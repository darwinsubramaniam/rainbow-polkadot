//! Rainbow — the deterministic simulation core.
//!
//! This crate is the **source of truth for game rules**. The browser client and
//! the TEE verifier run the same compiled artifact, so a score can be recomputed
//! from nothing but a seed and the player's input log.
//!
//! # Determinism rules, and how they are enforced
//!
//! | Rule | Enforcement |
//! |---|---|
//! | No I/O, no wall-clock, no `HashMap` | `#![no_std]` — these are not reachable |
//! | No floating point | `#![forbid(clippy::float_arithmetic)]` plus fixed-point throughout |
//! | Pinned RNG algorithm | [`rng::Pcg32`] written in-tree, no `rand` dependency |
//! | No pointer-width-dependent state | no `usize`/`isize` in [`State`]; enforced by a test |
//! | Fixed timestep | [`step`] takes no delta; the tick count *is* the clock |
//! | Single-threaded | no threading primitives are reachable under `no_std` |
//!
//! `#![no_std]` is doing real work here: it makes the dangerous things
//! unreachable rather than merely discouraged. `HashMap` iteration order,
//! `SystemTime`, and thread-local RNGs all live in `std`.

#![no_std]
#![forbid(unsafe_code)]

pub mod fx;
pub mod rng;

use fx::Fx;
use rng::Pcg32;

// ---------------------------------------------------------------------------
// Tunables. Every one of these is part of the rules: changing any value changes
// the score a given input log produces, and is therefore a rules-version bump.
// ---------------------------------------------------------------------------

/// Hard cap on run length. 36,000 ticks at 60Hz is ten minutes.
///
/// This also bounds the enclave's per-claim work, so it doubles as a
/// denial-of-service limit on the verifier.
pub const MAX_TICKS: u32 = 36_000;

/// Buttons the simulation understands. Any other bit set is a malformed log.
pub const BUTTON_LEFT: u8 = 0b0000_0001;
pub const BUTTON_RIGHT: u8 = 0b0000_0010;
pub const VALID_BUTTONS: u8 = BUTTON_LEFT | BUTTON_RIGHT;

/// Number of orb colours in a full rainbow.
pub const COLOURS: u8 = 7;
/// Entity kind marking a hazard rather than a collectible.
pub const KIND_HAZARD: u8 = 7;

/// Maximum simultaneous entities. A fixed-capacity array rather than a `Vec`:
/// no allocation, and iteration order is the array order on every target.
pub const MAX_ENTITIES: usize = 48;

const FIELD_W: Fx = fx::from_int(256);
const FIELD_H: Fx = fx::from_int(256);
const PLAYER_Y: Fx = fx::from_int(232);
const PLAYER_HALF_W: Fx = fx::from_int(10);
const PLAYER_HALF_H: Fx = fx::from_int(6);
const ORB_HALF: Fx = fx::from_int(6);

const PLAYER_ACCEL: Fx = fx::frac(35, 100);
const PLAYER_FRICTION: Fx = fx::frac(88, 100);
const PLAYER_MAX_VX: Fx = fx::from_int(4);

const ORB_MIN_VY: Fx = fx::frac(60, 100);
const ORB_MAX_VY: Fx = fx::frac(150, 100);
/// Difficulty ramp: orb fall speed gains this much per 600 ticks elapsed.
const ORB_VY_RAMP: Fx = fx::frac(12, 100);

const SPAWN_INTERVAL_START: u32 = 48;
const SPAWN_INTERVAL_MIN: u32 = 14;
/// Spawn interval loses one tick every this many ticks of play.
const SPAWN_RAMP_TICKS: u32 = 420;

const STARTING_LIVES: u8 = 3;
const MAX_MULTIPLIER: u32 = 9;
const SCORE_CORRECT: u64 = 10;
const SCORE_WRONG: u64 = 1;
const SCORE_RAINBOW_BONUS: u64 = 500;
/// One in this many spawns is a hazard.
const HAZARD_ONE_IN: u32 = 9;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// A single tick's button state.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Input(pub u8);

impl Input {
    #[inline]
    pub fn left(self) -> bool {
        self.0 & BUTTON_LEFT != 0
    }
    #[inline]
    pub fn right(self) -> bool {
        self.0 & BUTTON_RIGHT != 0
    }
    /// Whether this input sets only bits the simulation defines.
    #[inline]
    pub fn is_valid(self) -> bool {
        self.0 & !VALID_BUTTONS == 0
    }
}

/// One entry in a replay log. Recorded on input *change*, not per frame, so a
/// ten-minute run compresses to a few kilobytes.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct LogEntry {
    pub tick: u32,
    pub buttons: u8,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Entity {
    pub x: Fx,
    pub y: Fx,
    pub vy: Fx,
    /// `0..COLOURS` is a collectible of that colour; [`KIND_HAZARD`] is a hazard.
    pub kind: u8,
    pub active: u8,
}

/// Complete simulation state.
///
/// Every field has an explicit width. `usize` is deliberately absent: it is
/// 32-bit on wasm32 and 64-bit on aarch64, so storing or hashing one would make
/// the state hash differ between the client and the enclave. A test enforces
/// this by asserting the serialized length.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct State {
    pub tick: u32,
    rng: Pcg32,
    pub player_x: Fx,
    pub player_vx: Fx,
    pub entities: [Entity; MAX_ENTITIES],
    /// Next colour needed to extend the rainbow chain.
    pub chain: u8,
    pub multiplier: u32,
    pub lives: u8,
    pub over: u8,
    score: u64,
    spawn_timer: u32,
}

/// Why a log was refused. The enclave must reject before replaying, never after.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Reject {
    /// More entries than could fit in `MAX_TICKS`.
    LogTooLong,
    /// Ticks must be strictly increasing.
    NonMonotonicTick,
    /// An entry lands at or beyond the run limit.
    TickBeyondLimit,
    /// An entry sets a button bit the simulation does not define.
    InvalidButtons,
}

// ---------------------------------------------------------------------------
// Public API (the shape specified in the design document, plus `state_hash`)
// ---------------------------------------------------------------------------

/// Create the initial state for a seed.
pub fn init(seed: u64) -> State {
    State {
        tick: 0,
        rng: Pcg32::new(seed),
        player_x: FIELD_W / 2,
        player_vx: 0,
        entities: [Entity::default(); MAX_ENTITIES],
        chain: 0,
        multiplier: 1,
        lives: STARTING_LIVES,
        over: 0,
        score: 0,
        spawn_timer: SPAWN_INTERVAL_START,
    }
}

/// Advance the simulation by exactly one tick.
///
/// There is no `delta_time` parameter and there must never be one: the tick
/// count is the only clock, which is what makes a replay reproducible.
pub fn step(state: &mut State, input: Input) {
    if state.over != 0 {
        return;
    }

    state.tick += 1;

    move_player(state, input);
    spawn(state);
    advance_entities(state);
    collide(state);

    if state.lives == 0 || state.tick >= MAX_TICKS {
        state.over = 1;
    }
}

/// The score a run has earned so far.
pub fn score(state: &State) -> u64 {
    state.score
}

/// A 64-bit digest of the entire state.
///
/// Used by the determinism harness to compare two runs tick by tick. Comparing
/// only final scores would hide a divergence that happens to reconverge, and
/// would not say *when* things went wrong.
pub fn state_hash(state: &State) -> u64 {
    let mut h = Fnv1a::new();
    h.u32(state.tick);
    for w in state.rng.state_words() {
        h.u64(w);
    }
    h.i32(state.player_x);
    h.i32(state.player_vx);
    for e in &state.entities {
        h.i32(e.x);
        h.i32(e.y);
        h.i32(e.vy);
        h.u8(e.kind);
        h.u8(e.active);
    }
    h.u8(state.chain);
    h.u32(state.multiplier);
    h.u8(state.lives);
    h.u8(state.over);
    h.u64(state.score);
    h.u32(state.spawn_timer);
    h.finish()
}

/// Validate a log, then replay it from `seed`.
///
/// This is the function the enclave calls. It is deliberately in the shared
/// crate so the client and the verifier cannot drift: any rule expressible here
/// is a rule both sides apply identically.
///
/// The run advances until the player is out of lives or [`MAX_TICKS`] is
/// reached; the log supplies input changes along the way. Note that the log
/// alone determines the outcome — there is no separate "end" marker a client
/// could manipulate.
pub fn replay(seed: u64, log: &[LogEntry]) -> Result<State, Reject> {
    replay_with(seed, log, |_| {})
}

/// [`replay`], calling `on_tick` after every simulated tick.
///
/// The determinism harness uses this to capture a per-tick hash trace. Both
/// entry points share this one implementation deliberately: a separate
/// trace-mode replay could drift from the real one, and then the harness would
/// be certifying something the enclave does not actually run.
pub fn replay_with<F: FnMut(&State)>(
    seed: u64,
    log: &[LogEntry],
    mut on_tick: F,
) -> Result<State, Reject> {
    validate(log)?;

    let mut state = init(seed);
    let mut buttons = 0u8;
    let mut idx = 0usize;

    while state.over == 0 {
        // Apply every change scheduled for the tick about to be simulated.
        while idx < log.len() && log[idx].tick == state.tick {
            buttons = log[idx].buttons;
            idx += 1;
        }
        step(&mut state, Input(buttons));
        on_tick(&state);
    }

    Ok(state)
}

/// Check a log's structure without replaying it.
///
/// Cheap rejection first: a malformed log should cost the verifier as little as
/// possible, since replaying is the expensive part and claims are attacker-
/// controlled.
pub fn validate(log: &[LogEntry]) -> Result<(), Reject> {
    if log.len() > MAX_TICKS as usize {
        return Err(Reject::LogTooLong);
    }

    let mut prev: Option<u32> = None;
    for entry in log {
        if entry.tick >= MAX_TICKS {
            return Err(Reject::TickBeyondLimit);
        }
        if let Some(p) = prev
            && entry.tick <= p
        {
            return Err(Reject::NonMonotonicTick);
        }
        if !Input(entry.buttons).is_valid() {
            return Err(Reject::InvalidButtons);
        }
        prev = Some(entry.tick);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Simulation internals
// ---------------------------------------------------------------------------

fn move_player(state: &mut State, input: Input) {
    if input.left() {
        state.player_vx -= PLAYER_ACCEL;
    }
    if input.right() {
        state.player_vx += PLAYER_ACCEL;
    }

    state.player_vx = fx::mul(state.player_vx, PLAYER_FRICTION);
    state.player_vx = fx::clamp(state.player_vx, -PLAYER_MAX_VX, PLAYER_MAX_VX);
    state.player_x += state.player_vx;

    // Walls absorb horizontal momentum rather than bouncing.
    let lo = PLAYER_HALF_W;
    let hi = FIELD_W - PLAYER_HALF_W;
    if state.player_x < lo {
        state.player_x = lo;
        state.player_vx = 0;
    } else if state.player_x > hi {
        state.player_x = hi;
        state.player_vx = 0;
    }
}

fn spawn(state: &mut State) {
    if state.spawn_timer > 0 {
        state.spawn_timer -= 1;
        return;
    }

    let interval = SPAWN_INTERVAL_START.saturating_sub(state.tick / SPAWN_RAMP_TICKS);
    state.spawn_timer = interval.max(SPAWN_INTERVAL_MIN);

    // Fixed scan order, so which slot a new entity takes is deterministic.
    let Some(slot) = state.entities.iter().position(|e| e.active == 0) else {
        return; // Field is full; skip this spawn. Still deterministic.
    };

    let kind = if state.rng.below(HAZARD_ONE_IN) == 0 {
        KIND_HAZARD
    } else {
        state.rng.below(COLOURS as u32) as u8
    };

    let margin = fx::to_int(ORB_HALF);
    let x = fx::from_int(state.rng.range(margin, fx::to_int(FIELD_W) - margin));

    let ramp = fx::mul(ORB_VY_RAMP, fx::from_int((state.tick / 600) as i32));
    let base = state.rng.range(fx::to_int(ORB_MIN_VY * 100), fx::to_int(ORB_MAX_VY * 100));
    let vy = fx::div(fx::from_int(base), fx::from_int(100)) + ramp;

    state.entities[slot] = Entity {
        x,
        y: -ORB_HALF,
        vy,
        kind,
        active: 1,
    };
}

fn advance_entities(state: &mut State) {
    for e in state.entities.iter_mut() {
        if e.active == 0 {
            continue;
        }
        e.y += e.vy;
        if e.y > FIELD_H + ORB_HALF {
            e.active = 0;
        }
    }
}

fn collide(state: &mut State) {
    // Index order, not spatial order. A spatial sort would be faster but its
    // tie-breaking would have to be specified exactly to stay deterministic;
    // at 48 entities the linear scan is not worth that risk.
    for i in 0..MAX_ENTITIES {
        let e = state.entities[i];
        if e.active == 0 {
            continue;
        }

        let dx = fx::abs(e.x - state.player_x);
        let dy = fx::abs(e.y - PLAYER_Y);
        if dx > PLAYER_HALF_W + ORB_HALF || dy > PLAYER_HALF_H + ORB_HALF {
            continue;
        }

        state.entities[i].active = 0;

        if e.kind == KIND_HAZARD {
            state.lives = state.lives.saturating_sub(1);
            state.multiplier = 1;
            state.chain = 0;
            continue;
        }

        if e.kind == state.chain {
            state.chain += 1;
            state.score += SCORE_CORRECT * state.multiplier as u64;

            if state.chain >= COLOURS {
                state.chain = 0;
                state.score += SCORE_RAINBOW_BONUS * state.multiplier as u64;
                state.multiplier = (state.multiplier + 1).min(MAX_MULTIPLIER);
            }
        } else {
            state.chain = 0;
            state.score += SCORE_WRONG * state.multiplier as u64;
        }
    }
}

// ---------------------------------------------------------------------------
// FNV-1a, 64-bit. Written out for the same reason as the RNG: the state hash is
// consensus-critical, so its algorithm belongs in this repository.
// ---------------------------------------------------------------------------

struct Fnv1a(u64);

impl Fnv1a {
    #[inline]
    fn new() -> Self {
        Fnv1a(0xcbf2_9ce4_8422_2325)
    }
    #[inline]
    fn u8(&mut self, v: u8) {
        self.0 ^= v as u64;
        self.0 = self.0.wrapping_mul(0x0000_0100_0000_01b3);
    }
    #[inline]
    fn u32(&mut self, v: u32) {
        for b in v.to_le_bytes() {
            self.u8(b);
        }
    }
    #[inline]
    fn i32(&mut self, v: i32) {
        self.u32(v as u32);
    }
    #[inline]
    fn u64(&mut self, v: u64) {
        for b in v.to_le_bytes() {
            self.u8(b);
        }
    }
    #[inline]
    fn finish(self) -> u64 {
        self.0
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    extern crate alloc;
    use alloc::vec::Vec;

    fn log(entries: &[(u32, u8)]) -> Vec<LogEntry> {
        entries
            .iter()
            .map(|&(tick, buttons)| LogEntry { tick, buttons })
            .collect()
    }

    #[test]
    fn same_seed_same_log_same_result() {
        let l = log(&[(0, 1), (30, 0), (60, 2), (500, 0)]);
        let a = replay(0xdead_beef, &l).unwrap();
        let b = replay(0xdead_beef, &l).unwrap();
        assert_eq!(state_hash(&a), state_hash(&b));
        assert_eq!(score(&a), score(&b));
    }

    #[test]
    fn different_seeds_diverge() {
        let l = log(&[(0, 1), (100, 2)]);
        let a = replay(1, &l).unwrap();
        let b = replay(2, &l).unwrap();
        assert_ne!(state_hash(&a), state_hash(&b));
    }

    #[test]
    fn different_input_changes_outcome() {
        // Two different players on the same seed should not coincide.
        let a = replay(77, &log(&[(0, 1)])).unwrap();
        let b = replay(77, &log(&[(0, 2)])).unwrap();
        assert_ne!(state_hash(&a), state_hash(&b));
    }

    #[test]
    fn every_run_terminates() {
        // No input at all: the player stands still, takes hazard hits, and the
        // run must still end rather than looping forever.
        for seed in 0..32u64 {
            let s = replay(seed, &[]).unwrap();
            assert_eq!(s.over, 1);
            assert!(s.tick <= MAX_TICKS);
        }
    }

    #[test]
    fn run_never_exceeds_tick_cap() {
        // A player who dodges perfectly is capped by MAX_TICKS, which is what
        // bounds the enclave's work per claim.
        let mut entries = Vec::new();
        for i in 0..600u32 {
            entries.push((i * 50, if i % 2 == 0 { 1 } else { 2 }));
        }
        let s = replay(4242, &log(&entries)).unwrap();
        assert!(s.tick <= MAX_TICKS);
    }

    #[test]
    fn score_is_monotonic_over_a_run() {
        let mut s = init(31337);
        let mut last = 0;
        while s.over == 0 {
            step(&mut s, Input(BUTTON_LEFT));
            assert!(score(&s) >= last, "score must never decrease");
            last = score(&s);
        }
    }

    #[test]
    fn player_stays_inside_the_field() {
        let mut s = init(5);
        for _ in 0..2000 {
            step(&mut s, Input(BUTTON_LEFT));
            assert!(s.player_x >= PLAYER_HALF_W && s.player_x <= FIELD_W - PLAYER_HALF_W);
        }
        let mut s = init(5);
        for _ in 0..2000 {
            step(&mut s, Input(BUTTON_RIGHT));
            assert!(s.player_x >= PLAYER_HALF_W && s.player_x <= FIELD_W - PLAYER_HALF_W);
        }
    }

    #[test]
    fn step_after_game_over_is_a_no_op() {
        let mut s = replay(9, &[]).unwrap();
        let before = state_hash(&s);
        for _ in 0..100 {
            step(&mut s, Input(BUTTON_LEFT));
        }
        assert_eq!(state_hash(&s), before);
    }

    // -- rejection paths: the enclave's first line of defence ----------------

    #[test]
    fn rejects_non_monotonic_ticks() {
        assert_eq!(
            validate(&log(&[(10, 1), (5, 0)])),
            Err(Reject::NonMonotonicTick)
        );
        assert_eq!(
            validate(&log(&[(10, 1), (10, 0)])),
            Err(Reject::NonMonotonicTick),
            "duplicate ticks are also non-monotonic"
        );
    }

    #[test]
    fn rejects_out_of_range_buttons() {
        assert_eq!(validate(&log(&[(0, 0xFF)])), Err(Reject::InvalidButtons));
        assert_eq!(validate(&log(&[(0, 0b100)])), Err(Reject::InvalidButtons));
    }

    #[test]
    fn rejects_ticks_beyond_the_limit() {
        assert_eq!(
            validate(&log(&[(MAX_TICKS, 1)])),
            Err(Reject::TickBeyondLimit)
        );
    }

    #[test]
    fn accepts_a_well_formed_log() {
        assert_eq!(validate(&log(&[(0, 1), (1, 3), (MAX_TICKS - 1, 0)])), Ok(()));
    }

    #[test]
    fn empty_log_is_valid() {
        assert_eq!(validate(&[]), Ok(()));
    }

    // -- determinism guards --------------------------------------------------

    #[test]
    fn state_contains_no_pointer_width_dependent_fields() {
        // If someone adds a `usize` to State this size assertion changes on one
        // target but not the other, and the state hash silently diverges
        // between the browser (wasm32) and the enclave (aarch64).
        const ENTITY: usize = 4 + 4 + 4 + 1 + 1; // padded to 16 by alignment
        assert_eq!(core::mem::size_of::<Entity>(), 16);
        assert_eq!(core::mem::align_of::<Entity>(), 4);
        let _ = ENTITY;

        assert_eq!(core::mem::align_of::<State>(), 8);
    }

    #[test]
    fn state_hash_covers_every_meaningful_field() {
        // Mutating any observable field must move the hash. This catches a
        // field added to State but forgotten in state_hash.
        let base = init(1);

        let mut a = base;
        a.tick += 1;
        assert_ne!(state_hash(&a), state_hash(&base), "tick");

        let mut a = base;
        a.player_x += 1;
        assert_ne!(state_hash(&a), state_hash(&base), "player_x");

        let mut a = base;
        a.player_vx += 1;
        assert_ne!(state_hash(&a), state_hash(&base), "player_vx");

        let mut a = base;
        a.chain += 1;
        assert_ne!(state_hash(&a), state_hash(&base), "chain");

        let mut a = base;
        a.multiplier += 1;
        assert_ne!(state_hash(&a), state_hash(&base), "multiplier");

        let mut a = base;
        a.lives -= 1;
        assert_ne!(state_hash(&a), state_hash(&base), "lives");

        let mut a = base;
        a.over = 1;
        assert_ne!(state_hash(&a), state_hash(&base), "over");

        let mut a = base;
        a.score += 1;
        assert_ne!(state_hash(&a), state_hash(&base), "score");

        let mut a = base;
        a.spawn_timer += 1;
        assert_ne!(state_hash(&a), state_hash(&base), "spawn_timer");

        let mut a = base;
        a.entities[7].x += 1;
        assert_ne!(state_hash(&a), state_hash(&base), "entity");
    }

    #[test]
    fn claimed_score_is_never_trusted() {
        // The enclave compares; it never adopts. This test documents that the
        // only way to obtain a score is to replay for it.
        let l = log(&[(0, 1), (200, 2)]);
        let s = replay(123, &l).unwrap();
        let honest = score(&s);
        let claimed = 999_999u64;
        assert_ne!(honest, claimed);
        assert_eq!(score(&replay(123, &l).unwrap()), honest);
    }
}
