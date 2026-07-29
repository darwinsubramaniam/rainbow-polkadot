//! Flat C ABI over the simulation, compiled to `wasm32-unknown-unknown`.
//!
//! **This is the artifact that gets shipped to both sides.** The browser client
//! instantiates it with `WebAssembly.instantiate`; the TEE verifier runs the
//! very same bytes through `wasmi`. Because it is one compiled module rather
//! than two ports of the same rules, there is no cross-ISA arithmetic to
//! reconcile — the interpreter and the browser engine execute identical
//! instructions over identical linear memory.
//!
//! No `wasm-bindgen`. It would add a JS glue layer, inflate the module, and put
//! a code generator between the source and the artifact both sides must agree
//! on. The ABI here is small enough to write out.
//!
//! # Memory protocol
//!
//! The host allocates with [`sim_alloc`], writes its data, calls an entry point,
//! reads results back out of linear memory, then frees with [`sim_dealloc`].
//!
//! A log entry is 8 bytes, little-endian: `u32 tick`, then `u32 buttons`.
//! Eight-byte entries rather than a packed five keep every field naturally
//! aligned, which is worth more than the bandwidth.

use core::mem;
use sim::{LogEntry, Reject};

/// Bytes per encoded log entry.
pub const LOG_ENTRY_SIZE: usize = 8;
/// Bytes written to the `out` pointer by [`sim_verify`].
pub const VERIFY_OUT_SIZE: usize = 24;

// Status codes. Zero is success; every failure is negative so a host can test
// `< 0` without knowing the full set.
const OK: i32 = 0;
const ERR_LOG_TOO_LONG: i32 = -1;
const ERR_NON_MONOTONIC: i32 = -2;
const ERR_TICK_BEYOND_LIMIT: i32 = -3;
const ERR_INVALID_BUTTONS: i32 = -4;
const ERR_BAD_ARGUMENT: i32 = -5;
const ERR_TRACE_CAPACITY: i32 = -6;

fn code_for(r: Reject) -> i32 {
    match r {
        Reject::LogTooLong => ERR_LOG_TOO_LONG,
        Reject::NonMonotonicTick => ERR_NON_MONOTONIC,
        Reject::TickBeyondLimit => ERR_TICK_BEYOND_LIMIT,
        Reject::InvalidButtons => ERR_INVALID_BUTTONS,
    }
}

// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------

/// Allocate `len` bytes in linear memory and return the offset.
///
/// Returns 0 on failure, which is never a valid allocation here.
#[unsafe(no_mangle)]
pub extern "C" fn sim_alloc(len: u32) -> *mut u8 {
    if len == 0 {
        return core::ptr::null_mut();
    }
    let mut buf = Vec::<u8>::new();
    buf.try_reserve_exact(len as usize).ok();
    if buf.capacity() < len as usize {
        return core::ptr::null_mut();
    }
    let ptr = buf.as_mut_ptr();
    mem::forget(buf);
    ptr
}

/// Release a buffer previously returned by [`sim_alloc`].
///
/// # Safety
/// `ptr`/`len` must be exactly what [`sim_alloc`] returned and was called with.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_dealloc(ptr: *mut u8, len: u32) {
    if ptr.is_null() || len == 0 {
        return;
    }
    unsafe {
        drop(Vec::from_raw_parts(ptr, 0, len as usize));
    }
}

// ---------------------------------------------------------------------------
// Introspection — lets a host assert it agrees with the module about the rules
// ---------------------------------------------------------------------------

#[unsafe(no_mangle)]
pub extern "C" fn sim_max_ticks() -> u32 {
    sim::MAX_TICKS
}

#[unsafe(no_mangle)]
pub extern "C" fn sim_valid_buttons() -> u32 {
    sim::VALID_BUTTONS as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn sim_abi_version() -> u32 {
    1
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/// Validate and replay a log; this is what the enclave calls.
///
/// Writes 24 bytes at `out`, little-endian: `u64 score`, `u64 final_state_hash`,
/// `u32 final_tick`, `u32 over`.
///
/// Returns [`OK`] or a negative status. Note that no claimed score is an input:
/// the only way to learn a score is to replay for it.
///
/// # Safety
/// `log_ptr` must address `log_len * 8` readable bytes and `out` must address
/// [`VERIFY_OUT_SIZE`] writable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_verify(seed: u64, log_ptr: *const u8, log_len: u32, out: *mut u8) -> i32 {
    let Some(log) = (unsafe { decode_log(log_ptr, log_len) }) else {
        return ERR_BAD_ARGUMENT;
    };
    if out.is_null() {
        return ERR_BAD_ARGUMENT;
    }

    match sim::replay(seed, &log) {
        Err(r) => code_for(r),
        Ok(state) => {
            let mut buf = [0u8; VERIFY_OUT_SIZE];
            buf[0..8].copy_from_slice(&sim::score(&state).to_le_bytes());
            buf[8..16].copy_from_slice(&sim::state_hash(&state).to_le_bytes());
            buf[16..20].copy_from_slice(&state.tick.to_le_bytes());
            buf[20..24].copy_from_slice(&(state.over as u32).to_le_bytes());
            unsafe { core::ptr::copy_nonoverlapping(buf.as_ptr(), out, VERIFY_OUT_SIZE) };
            OK
        }
    }
}

/// Replay a log, writing one `u64` state hash per simulated tick.
///
/// Used only by the determinism harness. Comparing per-tick traces rather than
/// final scores locates the exact tick where two targets diverge; a final-value
/// comparison would report *that* something went wrong but never *where*, and
/// would miss a divergence that happens to reconverge.
///
/// Returns the number of hashes written, or a negative status.
///
/// # Safety
/// `log_ptr` must address `log_len * 8` readable bytes and `out` must address
/// `out_cap * 8` writable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_trace(
    seed: u64,
    log_ptr: *const u8,
    log_len: u32,
    out: *mut u8,
    out_cap: u32,
) -> i32 {
    let Some(log) = (unsafe { decode_log(log_ptr, log_len) }) else {
        return ERR_BAD_ARGUMENT;
    };
    if out.is_null() {
        return ERR_BAD_ARGUMENT;
    }

    let mut written: u32 = 0;
    let mut overflow = false;

    let result = sim::replay_with(seed, &log, |state| {
        if written >= out_cap {
            overflow = true;
            return;
        }
        let bytes = sim::state_hash(state).to_le_bytes();
        unsafe {
            core::ptr::copy_nonoverlapping(bytes.as_ptr(), out.add(written as usize * 8), 8);
        }
        written += 1;
    });

    match result {
        Err(r) => code_for(r),
        Ok(_) if overflow => ERR_TRACE_CAPACITY,
        Ok(_) => written as i32,
    }
}

/// # Safety
/// `ptr` must address `len * LOG_ENTRY_SIZE` readable bytes, or be null with
/// `len == 0`.
unsafe fn decode_log(ptr: *const u8, len: u32) -> Option<Vec<LogEntry>> {
    if len == 0 {
        return Some(Vec::new());
    }
    if ptr.is_null() {
        return None;
    }
    // Refuse absurd lengths before allocating for them — this input is
    // attacker-controlled and reaches the enclave.
    if len > sim::MAX_TICKS {
        return None;
    }

    let bytes = unsafe { core::slice::from_raw_parts(ptr, len as usize * LOG_ENTRY_SIZE) };
    let mut out = Vec::with_capacity(len as usize);
    for chunk in bytes.chunks_exact(LOG_ENTRY_SIZE) {
        let tick = u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        let buttons = u32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]);
        // Truncating here would silently discard a set high bit and turn an
        // invalid log into a valid one; reject instead.
        if buttons > u8::MAX as u32 {
            return None;
        }
        out.push(LogEntry {
            tick,
            buttons: buttons as u8,
        });
    }
    Some(out)
}
