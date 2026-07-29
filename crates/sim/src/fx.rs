//! 16.16 signed fixed-point.
//!
//! Hand-rolled rather than pulled from a crate so the arithmetic is pinned in
//! this repository and cannot change under a dependency bump. Every operation
//! is integer-only and every intermediate is explicitly widened, so results are
//! bit-identical on wasm32 and aarch64.

/// A 16.16 signed fixed-point number.
pub type Fx = i32;

pub const SHIFT: u32 = 16;
pub const ONE: Fx = 1 << SHIFT;
pub const HALF: Fx = ONE / 2;

/// Whole number -> fixed point. Const so it can be used in constants.
pub const fn from_int(v: i32) -> Fx {
    v << SHIFT
}

/// Fixed point -> whole number, truncating toward negative infinity.
pub const fn to_int(v: Fx) -> i32 {
    v >> SHIFT
}

/// Build a fixed-point value from a numerator/denominator pair, evaluated at
/// compile time. `frac(1, 4)` is 0.25. Avoids writing raw magic integers.
pub const fn frac(num: i32, den: i32) -> Fx {
    ((num as i64 * ONE as i64) / den as i64) as i32
}

/// Multiply. The i64 intermediate is mandatory: the i32-only form overflows for
/// operands above ~181.0 and would differ from the widened form.
#[inline]
pub fn mul(a: Fx, b: Fx) -> Fx {
    let wide = (a as i64 * b as i64) >> SHIFT;
    clamp_i64(wide)
}

/// Divide. Truncates toward zero, matching Rust's integer division on every
/// target. Division by zero is defined here as a saturate rather than a panic,
/// because a panic inside the enclave would be a denial-of-service vector.
#[inline]
pub fn div(a: Fx, b: Fx) -> Fx {
    if b == 0 {
        return if a >= 0 { Fx::MAX } else { Fx::MIN };
    }
    clamp_i64(((a as i64) << SHIFT) / b as i64)
}

#[inline]
pub fn abs(a: Fx) -> Fx {
    // `i32::abs` panics on MIN under overflow-checks; saturate instead.
    if a < 0 {
        a.saturating_neg()
    } else {
        a
    }
}

#[inline]
pub fn clamp(v: Fx, lo: Fx, hi: Fx) -> Fx {
    if v < lo {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}

#[inline]
fn clamp_i64(v: i64) -> Fx {
    if v > Fx::MAX as i64 {
        Fx::MAX
    } else if v < Fx::MIN as i64 {
        Fx::MIN
    } else {
        v as i32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_whole_numbers() {
        for v in -1000..1000 {
            assert_eq!(to_int(from_int(v)), v);
        }
    }

    #[test]
    fn mul_is_widened() {
        // 200.0 * 200.0 = 40000.0. The naive i32 form overflows here; the
        // widened form must saturate rather than wrap.
        let a = from_int(200);
        assert_eq!(mul(a, a), Fx::MAX);
        // A case comfortably in range must be exact.
        assert_eq!(mul(from_int(3), HALF), from_int(1) + HALF);
    }

    #[test]
    fn div_by_zero_saturates_instead_of_panicking() {
        assert_eq!(div(ONE, 0), Fx::MAX);
        assert_eq!(div(-ONE, 0), Fx::MIN);
    }

    #[test]
    fn abs_handles_min_without_panicking() {
        assert_eq!(abs(Fx::MIN), Fx::MAX);
    }

    #[test]
    fn frac_is_exact_for_powers_of_two() {
        assert_eq!(frac(1, 2), HALF);
        assert_eq!(frac(1, 4), ONE / 4);
        assert_eq!(frac(-3, 4), -(ONE / 4) * 3);
    }
}
