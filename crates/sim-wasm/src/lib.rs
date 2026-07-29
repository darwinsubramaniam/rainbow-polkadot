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
//!
//! # Two ways in
//!
//! * [`sim_verify`] — replay a whole log and report the score. This is the
//!   enclave's entry point and the only one that can mint a score.
//! * [`sim_create`] / [`sim_step_one`] / [`sim_snapshot`] — drive the
//!   simulation one tick at a time and read out enough state to draw a frame.
//!   This is how the browser plays the game.
//!
//! The second family exists so the client can *render* the same simulation the
//! enclave will later replay, rather than approximating it in JavaScript. A
//! reimplementation in JS would be a second set of rules, and the two would
//! drift; then honest players would be flagged as cheats.
//!
//! Note that the live-play entry points cannot produce an attestable score.
//! They read state out; they never sign anything. The score that counts is the
//! one [`sim_verify`] computes inside the enclave from the input log alone.

use core::mem;
use sim::{LogEntry, Reject, State};

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

/// ABI generation. Bumped to 2 when the live-play entry points were added and
/// the rules became a platformer; a host that expects 1 must not run this.
#[unsafe(no_mangle)]
pub extern "C" fn sim_abi_version() -> u32 {
    2
}

#[unsafe(no_mangle)]
pub extern "C" fn sim_level_w() -> u32 {
    sim::LEVEL_W as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn sim_level_h() -> u32 {
    sim::LEVEL_H as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn sim_tile_size() -> u32 {
    sim::TILE as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn sim_max_enemies() -> u32 {
    sim::MAX_ENEMIES as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn sim_max_coins() -> u32 {
    sim::MAX_COINS as u32
}

/// Bytes [`sim_snapshot`] writes. Queried rather than hard-coded so the host
/// cannot fall out of step with the layout below.
#[unsafe(no_mangle)]
pub extern "C" fn sim_snapshot_size() -> u32 {
    SNAPSHOT_SIZE as u32
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

// ---------------------------------------------------------------------------
// Live play — stepping and reading the simulation for rendering
// ---------------------------------------------------------------------------
//
// The snapshot is an explicit, versioned byte layout rather than a pointer to
// the Rust `State`. Handing out the struct directly would make the browser
// depend on rustc's field ordering, which is not stable and is not part of any
// contract — a compiler upgrade could silently reshuffle it and the renderer
// would draw garbage. Serialising costs about a kilobyte per frame and removes
// that entire class of failure.

const HEADER_SIZE: usize = 48;
const ENEMY_REC: usize = 12;
const COIN_REC: usize = 12;

const SNAPSHOT_SIZE: usize =
    HEADER_SIZE + sim::MAX_ENEMIES * ENEMY_REC + sim::MAX_COINS * COIN_REC;

#[inline]
fn put_u32(buf: &mut [u8], off: usize, v: u32) {
    buf[off..off + 4].copy_from_slice(&v.to_le_bytes());
}

#[inline]
fn put_i32(buf: &mut [u8], off: usize, v: i32) {
    put_u32(buf, off, v as u32);
}

#[inline]
fn put_u64(buf: &mut [u8], off: usize, v: u64) {
    buf[off..off + 8].copy_from_slice(&v.to_le_bytes());
}

/// Begin a run on `seed`, generating that seed's level.
///
/// Returns an opaque handle, or null if allocation failed. Every handle must be
/// released with [`sim_destroy`].
#[unsafe(no_mangle)]
pub extern "C" fn sim_create(seed: u64) -> *mut State {
    Box::into_raw(Box::new(sim::init(seed)))
}

/// Release a handle from [`sim_create`].
///
/// # Safety
/// `handle` must have come from [`sim_create`] and must not be used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_destroy(handle: *mut State) {
    if handle.is_null() {
        return;
    }
    drop(unsafe { Box::from_raw(handle) });
}

/// Advance one tick under `buttons`. Returns 1 once the run is over, else 0.
///
/// Invalid button bits are rejected rather than masked off: silently clearing
/// them would let the client simulate an input the enclave will later refuse,
/// and the two would disagree about the run.
///
/// # Safety
/// `handle` must be a live handle from [`sim_create`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_step_one(handle: *mut State, buttons: u32) -> i32 {
    if handle.is_null() {
        return ERR_BAD_ARGUMENT;
    }
    if buttons > u8::MAX as u32 {
        return ERR_INVALID_BUTTONS;
    }
    let input = sim::Input(buttons as u8);
    if !input.is_valid() {
        return ERR_INVALID_BUTTONS;
    }

    let state = unsafe { &mut *handle };
    sim::step(state, input);
    state.over as i32
}

/// Copy the generated level's tiles into `out`, row-major, one byte per tile.
///
/// The client draws from this rather than generating a level of its own, so the
/// terrain on screen is by construction the terrain the enclave will replay
/// against.
///
/// Returns the number of bytes written, or a negative status.
///
/// # Safety
/// `out` must address `cap` writable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_terrain(handle: *const State, out: *mut u8, cap: u32) -> i32 {
    if handle.is_null() || out.is_null() {
        return ERR_BAD_ARGUMENT;
    }
    if (cap as usize) < sim::LEVEL_TILES {
        return ERR_BAD_ARGUMENT;
    }
    let state = unsafe { &*handle };
    unsafe {
        core::ptr::copy_nonoverlapping(state.terrain.as_ptr(), out, sim::LEVEL_TILES);
    }
    sim::LEVEL_TILES as i32
}

/// Write a render snapshot of the current tick into `out`.
///
/// Layout, little-endian throughout:
///
/// | Offset | Type | Field |
/// |---|---|---|
/// | 0  | `u32` | tick |
/// | 4  | `i32` | player x (16.16 fixed point) |
/// | 8  | `i32` | player y |
/// | 12 | `i32` | player vx |
/// | 16 | `i32` | player vy |
/// | 20 | `u8`  | on ground |
/// | 21 | `i8`  | facing (-1 / 1) |
/// | 22 | `u8`  | lives |
/// | 23 | `u8`  | over |
/// | 24 | `u8`  | won |
/// | 25 | `u8`  | invulnerable (0/1) |
/// | 28 | `u32` | coins taken |
/// | 32 | `u64` | score |
/// | 40 | `i32` | furthest tile column reached |
/// | 48 | — | `MAX_ENEMIES` × { `i32` x, `i32` y, `u8` active, 3 pad } |
/// | …  | — | `MAX_COINS` × { `i32` x, `i32` y, `u8` active, 3 pad } |
///
/// Entity slots are written at fixed offsets including inactive ones, so the
/// snapshot is a constant size and the host never has to parse a length prefix.
///
/// Returns bytes written, or a negative status.
///
/// # Safety
/// `out` must address `cap` writable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_snapshot(handle: *const State, out: *mut u8, cap: u32) -> i32 {
    if handle.is_null() || out.is_null() {
        return ERR_BAD_ARGUMENT;
    }
    if (cap as usize) < SNAPSHOT_SIZE {
        return ERR_BAD_ARGUMENT;
    }
    let s = unsafe { &*handle };

    let mut buf = [0u8; SNAPSHOT_SIZE];
    put_u32(&mut buf, 0, s.tick);
    put_i32(&mut buf, 4, s.player_x);
    put_i32(&mut buf, 8, s.player_y);
    put_i32(&mut buf, 12, s.player_vx);
    put_i32(&mut buf, 16, s.player_vy);
    buf[20] = s.on_ground;
    buf[21] = s.facing as u8;
    buf[22] = s.lives;
    buf[23] = s.over;
    buf[24] = s.won;
    buf[25] = (s.invuln > 0) as u8;
    put_u32(&mut buf, 28, s.coins_taken);
    put_u64(&mut buf, 32, sim::score(s));
    put_i32(&mut buf, 40, s.max_tx);

    let mut off = HEADER_SIZE;
    for e in s.enemies.iter() {
        put_i32(&mut buf, off, e.x);
        put_i32(&mut buf, off + 4, e.y);
        buf[off + 8] = e.active;
        off += ENEMY_REC;
    }
    for c in s.coins.iter() {
        put_i32(&mut buf, off, c.x);
        put_i32(&mut buf, off + 4, c.y);
        buf[off + 8] = c.active;
        off += COIN_REC;
    }

    unsafe { core::ptr::copy_nonoverlapping(buf.as_ptr(), out, SNAPSHOT_SIZE) };
    SNAPSHOT_SIZE as i32
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
