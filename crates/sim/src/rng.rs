//! PCG-XSH-RR 64/32, transcribed from the reference implementation.
//!
//! Why this is written out by hand instead of using `rand`:
//!
//! `rand::rngs::SmallRng` — which the original design document specified — is
//! explicitly documented as *not* reproducible across releases, and it has
//! historically selected a different Xoshiro variant depending on pointer
//! width. That is precisely the wasm32 (32-bit) versus aarch64 (64-bit) split
//! this simulation has to survive, so it would have been a live determinism
//! bug rather than a theoretical one.
//!
//! Keeping the algorithm in-tree means the generator cannot change under a
//! `cargo update`, and the exact sequence is reviewable in one screen.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Pcg32 {
    state: u64,
    inc: u64,
}

const MULTIPLIER: u64 = 6_364_136_223_846_793_005;

impl Pcg32 {
    /// Seed the generator. The stream constant is fixed so that a given seed
    /// always produces the same sequence; the enclave and the client must agree
    /// on this exactly.
    pub fn new(seed: u64) -> Self {
        let mut r = Pcg32 {
            state: 0,
            inc: 0xda3e_39cb_94b9_5bdb,
        };
        r.next_u32();
        r.state = r.state.wrapping_add(seed);
        r.next_u32();
        r
    }

    #[inline]
    pub fn next_u32(&mut self) -> u32 {
        let old = self.state;
        self.state = old.wrapping_mul(MULTIPLIER).wrapping_add(self.inc);
        let xorshifted = (((old >> 18) ^ old) >> 27) as u32;
        let rot = (old >> 59) as u32;
        xorshifted.rotate_right(rot)
    }

    /// Uniform integer in `[0, n)` via Lemire's rejection method.
    ///
    /// Rejection (rather than plain modulo) keeps the distribution unbiased,
    /// and the rejection loop is itself deterministic because it consumes a
    /// predictable number of words for a given state. Returns 0 for `n == 0`.
    #[inline]
    pub fn below(&mut self, n: u32) -> u32 {
        if n == 0 {
            return 0;
        }
        let threshold = n.wrapping_neg() % n;
        loop {
            let v = self.next_u32();
            if v >= threshold {
                return v % n;
            }
        }
    }

    /// Uniform integer in `[lo, hi]` inclusive. Returns `lo` if `hi < lo`.
    #[inline]
    pub fn range(&mut self, lo: i32, hi: i32) -> i32 {
        if hi <= lo {
            return lo;
        }
        let span = (hi as i64 - lo as i64 + 1) as u32;
        lo + self.below(span) as i32
    }

    pub(crate) fn state_words(&self) -> [u64; 2] {
        [self.state, self.inc]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Golden vector, captured from this implementation on 2026-07-29.
    ///
    /// If this test ever fails, the generator changed — which means every
    /// previously attested score was computed under different rules. Updating
    /// these constants is only correct as part of a deliberate rules-version
    /// bump, never as a way to make a red test go green.
    #[test]
    fn golden_sequence_is_pinned() {
        let mut r = Pcg32::new(42);
        let got: [u32; 8] = core::array::from_fn(|_| r.next_u32());
        assert_eq!(got, GOLDEN_42);
    }

    const GOLDEN_42: [u32; 8] = [
        0xddaa_6c75, 0x3237_b41c, 0xe070_ca56, 0xc17a_7979, 0xafd5_d8ee, 0x58ad_52b6, 0xcbe6_ae50,
        0x4d3b_ac55,
    ];

    #[test]
    fn same_seed_same_sequence() {
        let mut a = Pcg32::new(7);
        let mut b = Pcg32::new(7);
        for _ in 0..1000 {
            assert_eq!(a.next_u32(), b.next_u32());
        }
    }

    #[test]
    fn different_seeds_diverge() {
        let mut a = Pcg32::new(1);
        let mut b = Pcg32::new(2);
        let differs = (0..64).any(|_| a.next_u32() != b.next_u32());
        assert!(differs);
    }

    #[test]
    fn below_respects_bound_and_covers_it() {
        let mut r = Pcg32::new(99);
        let mut seen = [false; 7];
        for _ in 0..10_000 {
            let v = r.below(7);
            assert!(v < 7);
            seen[v as usize] = true;
        }
        assert!(seen.iter().all(|s| *s), "every value in range should occur");
    }

    #[test]
    fn below_zero_is_zero() {
        let mut r = Pcg32::new(5);
        assert_eq!(r.below(0), 0);
    }

    #[test]
    fn range_is_inclusive_and_ordered() {
        let mut r = Pcg32::new(11);
        for _ in 0..1000 {
            let v = r.range(-5, 5);
            assert!((-5..=5).contains(&v));
        }
        assert_eq!(r.range(3, 3), 3);
        assert_eq!(r.range(9, 2), 9);
    }
}
