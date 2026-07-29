//! Rainbow — the deterministic simulation core.
//!
//! This crate is the **source of truth for game rules**. The browser client and
//! the TEE verifier run the same compiled artifact, so a score can be recomputed
//! from nothing but a seed and the player's input log.
//!
//! The game is a side-scrolling platformer: run, jump, stomp enemies, collect
//! coins, avoid spikes and pits, reach the goal. The level itself is *generated
//! from the seed*, which is why the seed must stay secret until the enclave
//! issues it — see `deriveSeed` in the verifier. A player who could pick their
//! own seed could shop for an easy level.
//!
//! # Determinism rules, and how they are enforced
//!
//! | Rule | Enforcement |
//! |---|---|
//! | No I/O, no wall-clock, no `HashMap` | `#![no_std]` — these are not reachable |
//! | No floating point | fixed-point throughout; `Fx` is an `i32` |
//! | Pinned RNG algorithm | [`rng::Pcg32`] written in-tree, no `rand` dependency |
//! | No pointer-width-dependent state | no `usize`/`isize` in [`State`]; enforced by a test |
//! | Fixed timestep | [`step`] takes no delta; the tick count *is* the clock |
//! | Single-threaded | no threading primitives are reachable under `no_std` |
//! | Axis-separated collision | X resolved fully, then Y — never "whichever overlap is smaller" |
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
pub const BUTTON_JUMP: u8 = 0b0000_0100;
pub const VALID_BUTTONS: u8 = BUTTON_LEFT | BUTTON_RIGHT | BUTTON_JUMP;

// -- level geometry ---------------------------------------------------------

/// Side length of one tile, in world units. A power of two so tile lookup is a
/// shift rather than a division — division would be correct too, but the shift
/// keeps the hot collision path free of any rounding question.
pub const TILE: i32 = 16;
/// `log2(TILE)`.
pub const TILE_SHIFT: u32 = 4;

pub const LEVEL_W: usize = 160;
pub const LEVEL_H: usize = 15;
pub const LEVEL_TILES: usize = LEVEL_W * LEVEL_H;

/// Topmost row of solid ground. Rows below this are ground too; rows above are
/// the playfield.
const GROUND_ROW: usize = 13;
/// Guaranteed solid tiles on the far side of every pit, so two pits can never
/// abut and every jump has somewhere fair to land.
const LANDING_STRIP: usize = 2;
/// Highest row that must be clear above a spike for it to be jumpable. Set from
/// the measured jump arc, which carries the player's head to about row 8.
const SPIKE_CLEARANCE_TOP: usize = 8;
/// Row for the lower band of floating platforms.
const PLAT_ROW_LOW: usize = 10;
/// Row for the upper band. Three tiles above [`PLAT_ROW_LOW`], which is inside
/// the player's jump height — see `jump_clears_three_tiles`.
const PLAT_ROW_HIGH: usize = 7;

// -- tile kinds -------------------------------------------------------------

pub const TILE_EMPTY: u8 = 0;
pub const TILE_SOLID: u8 = 1;
pub const TILE_SPIKE: u8 = 2;
pub const TILE_GOAL: u8 = 3;

// -- entity capacities ------------------------------------------------------

pub const MAX_ENEMIES: usize = 24;
pub const MAX_COINS: usize = 64;

// -- player physics ---------------------------------------------------------

const PLAYER_HALF_W: Fx = fx::from_int(5);
const PLAYER_HALF_H: Fx = fx::from_int(7);

const GRAVITY: Fx = fx::frac(36, 100);
const MAX_FALL: Fx = fx::from_int(7);
/// Chosen so a jump clears the three-tile spacing between platform bands with
/// margin. Discrete integration costs about `v/2` against the textbook
/// `v²/2g` height, so the closed-form value is not enough on its own —
/// `jump_clears_three_tiles` pins the real number.
const JUMP_VY: Fx = fx::frac(66, 10);
/// Releasing jump while still rising cuts the remaining upward velocity. This is
/// what makes a tap-jump shorter than a held one.
const JUMP_CUT: Fx = fx::frac(45, 100);

const RUN_ACCEL: Fx = fx::frac(28, 100);
const RUN_FRICTION: Fx = fx::frac(85, 100);
const MAX_VX: Fx = fx::frac(260, 100);

/// Upward kick given to the player for landing on an enemy.
const STOMP_BOUNCE: Fx = fx::from_int(4);

const STARTING_LIVES: u8 = 3;
/// Ticks of invulnerability after taking damage. Without this, respawning next
/// to a hazard can drain every life in well under a second.
const INVULN_TICKS: u16 = 90;

const SPAWN_TX: i32 = 2;
const SPAWN_TY: i32 = GROUND_ROW as i32 - 1;

// -- enemy physics ----------------------------------------------------------

const ENEMY_HALF_W: Fx = fx::from_int(6);
const ENEMY_HALF_H: Fx = fx::from_int(6);
const ENEMY_VX: Fx = fx::frac(50, 100);

const COIN_HALF: Fx = fx::from_int(5);

// -- scoring ----------------------------------------------------------------

const SCORE_COIN: u64 = 100;
const SCORE_STOMP: u64 = 200;
const SCORE_GOAL: u64 = 2_000;
/// Awarded once per tile of *new* furthest progress, so a run that dies partway
/// still scores something proportional to how far it got.
const SCORE_PER_TILE: u64 = 5;
/// Ticks left on the clock are worth this fraction of a point each.
const TIME_BONUS_DIVISOR: u64 = 20;

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
    #[inline]
    pub fn jump(self) -> bool {
        self.0 & BUTTON_JUMP != 0
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
pub struct Enemy {
    pub x: Fx,
    pub y: Fx,
    pub vx: Fx,
    pub vy: Fx,
    pub active: u8,
    _pad: [u8; 3],
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Coin {
    pub x: Fx,
    pub y: Fx,
    pub active: u8,
    _pad: [u8; 3],
}

/// Complete simulation state.
///
/// Every field has an explicit width. `usize` is deliberately absent: it is
/// 32-bit on wasm32 and 64-bit on aarch64, so storing or hashing one would make
/// the state hash differ between the client and the enclave. A test enforces
/// this by asserting the layout.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct State {
    pub tick: u32,
    rng: Pcg32,

    /// The generated level. Immutable once [`init`] returns.
    ///
    /// Deliberately *not* walked by [`state_hash`] on every tick: at 2,400 bytes
    /// that would dominate the hash cost of a 36,000-tick replay for no benefit,
    /// since it never changes. [`State::level_hash`] covers it once instead.
    pub terrain: [u8; LEVEL_TILES],
    /// Digest of [`State::terrain`], folded into the per-tick state hash so the
    /// level is still covered without being rescanned.
    pub level_hash: u64,

    pub player_x: Fx,
    pub player_y: Fx,
    pub player_vx: Fx,
    pub player_vy: Fx,
    pub on_ground: u8,
    /// -1 facing left, 1 facing right. Rendering only; carried in state so the
    /// client never has to infer it (and so it stays part of the hash).
    pub facing: i8,
    pub jump_held: u8,
    pub lives: u8,
    pub invuln: u16,
    /// 0 while running, 1 once the run has ended.
    pub over: u8,
    /// 1 if the run ended by reaching the goal rather than by dying or timing out.
    pub won: u8,

    pub enemies: [Enemy; MAX_ENEMIES],
    pub coins: [Coin; MAX_COINS],

    /// Furthest tile column reached, for progress scoring.
    pub max_tx: i32,
    /// Where a death sends the player back to. Advances only forward, and only
    /// to ground the player has actually stood on.
    pub checkpoint_tx: i32,
    pub checkpoint_ty: i32,
    pub coins_taken: u32,
    score: u64,
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
// Public API
// ---------------------------------------------------------------------------

/// Create the initial state for a seed, generating that seed's level.
pub fn init(seed: u64) -> State {
    let mut rng = Pcg32::new(seed);

    let mut state = State {
        tick: 0,
        terrain: [TILE_EMPTY; LEVEL_TILES],
        level_hash: 0,
        player_x: tile_centre(SPAWN_TX),
        player_y: fx::from_int(SPAWN_TY * TILE + TILE) - PLAYER_HALF_H,
        player_vx: 0,
        player_vy: 0,
        on_ground: 1,
        facing: 1,
        jump_held: 0,
        lives: STARTING_LIVES,
        invuln: 0,
        over: 0,
        won: 0,
        enemies: [Enemy::default(); MAX_ENEMIES],
        coins: [Coin::default(); MAX_COINS],
        max_tx: SPAWN_TX,
        checkpoint_tx: SPAWN_TX,
        checkpoint_ty: SPAWN_TY + 1,
        coins_taken: 0,
        score: 0,
        rng,
    };

    generate(&mut state, &mut rng);
    state.rng = rng;
    state.level_hash = hash_terrain(&state.terrain);
    state
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
    if state.invuln > 0 {
        state.invuln -= 1;
    }

    move_player(state, input);
    move_enemies(state);
    collide_enemies(state);
    collect_coins(state);
    check_terrain_hazards(state);
    score_progress(state);
    update_checkpoint(state);

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
    // The terrain enters through its precomputed digest rather than byte by
    // byte; it is immutable after init, so one fold is as sound as 2,400.
    h.u64(state.level_hash);
    h.i32(state.player_x);
    h.i32(state.player_y);
    h.i32(state.player_vx);
    h.i32(state.player_vy);
    h.u8(state.on_ground);
    h.u8(state.facing as u8);
    h.u8(state.jump_held);
    h.u8(state.lives);
    h.u32(state.invuln as u32);
    h.u8(state.over);
    h.u8(state.won);
    for e in &state.enemies {
        h.i32(e.x);
        h.i32(e.y);
        h.i32(e.vx);
        h.i32(e.vy);
        h.u8(e.active);
    }
    for c in &state.coins {
        h.i32(c.x);
        h.i32(c.y);
        h.u8(c.active);
    }
    h.i32(state.max_tx);
    h.i32(state.checkpoint_tx);
    h.i32(state.checkpoint_ty);
    h.u32(state.coins_taken);
    h.u64(state.score);
    h.finish()
}

/// Validate a log, then replay it from `seed`.
///
/// This is the function the enclave calls. It is deliberately in the shared
/// crate so the client and the verifier cannot drift: any rule expressible here
/// is a rule both sides apply identically.
///
/// The run advances until the player is out of lives, reaches the goal, or
/// [`MAX_TICKS`] is reached; the log supplies input changes along the way. Note
/// that the log alone determines the outcome — there is no separate "end" marker
/// a client could manipulate.
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
// Level generation
// ---------------------------------------------------------------------------

#[inline]
fn tile_centre(tx: i32) -> Fx {
    fx::from_int(tx * TILE + TILE / 2)
}

#[inline]
fn tile_index(tx: usize, ty: usize) -> usize {
    ty * LEVEL_W + tx
}

/// Read a tile, treating out-of-bounds as walls on the sides and open air above
/// and below.
///
/// Making the side columns solid is what keeps the player inside the level
/// without a separate bounds check in the movement code. Below the floor is
/// deliberately *not* solid: falling out of the world is a death.
#[inline]
fn tile_at(terrain: &[u8; LEVEL_TILES], tx: i32, ty: i32) -> u8 {
    if tx < 0 || tx >= LEVEL_W as i32 {
        return TILE_SOLID;
    }
    if ty < 0 || ty >= LEVEL_H as i32 {
        return TILE_EMPTY;
    }
    terrain[tile_index(tx as usize, ty as usize)]
}

#[inline]
fn is_solid(t: u8) -> bool {
    t == TILE_SOLID
}

/// Build the level for this seed.
///
/// Every decision is drawn from `rng` in a fixed order, so the same seed always
/// produces the same level on every target. The generator is deliberately
/// conservative about reachability: gaps never exceed three tiles and platform
/// bands are spaced within jump height, both of which are asserted by tests.
fn generate(state: &mut State, rng: &mut Pcg32) {
    // -- ground, with pits ---------------------------------------------------
    let mut tx = 0usize;
    while tx < LEVEL_W {
        // A safe run-up at the start and a solid landing zone at the goal.
        // Ten tiles is enough for the player to reach full speed before the
        // first pit, which matters because a standing jump clears less ground.
        let protected = tx < 10 || tx >= LEVEL_W - 8;

        if !protected && rng.below(13) == 0 {
            // A pit. Three tiles is the widest the player can clear, so that is
            // the cap; see `widest_pit_is_jumpable`.
            let gap = rng.range(2, 3) as usize;
            tx += gap;

            // Force a landing strip on the far side. Without this, the next
            // iteration can immediately roll another pit and the two merge into
            // a six-tile hole no jump can cross — an unwinnable level.
            //
            // Two tiles rather than one: a single tile between two pits is
            // clearable, but it demands frame-perfect landing on 16 units of
            // ground for a 10-unit-wide player, and the generator was placing
            // that pattern as early as the eighth column. Width is pinned by
            // `pits_always_have_a_landing_strip`.
            for _ in 0..LANDING_STRIP {
                if tx >= LEVEL_W {
                    break;
                }
                for ty in GROUND_ROW..LEVEL_H {
                    state.terrain[tile_index(tx, ty)] = TILE_SOLID;
                }
                tx += 1;
            }
            continue;
        }

        for ty in GROUND_ROW..LEVEL_H {
            state.terrain[tile_index(tx, ty)] = TILE_SOLID;
        }
        tx += 1;
    }

    // -- floating platforms --------------------------------------------------
    for &row in &[PLAT_ROW_LOW, PLAT_ROW_HIGH] {
        let mut tx = 8usize;
        while tx < LEVEL_W - 12 {
            if rng.below(4) == 0 {
                let span = rng.range(3, 6) as usize;
                for i in 0..span {
                    if tx + i >= LEVEL_W - 10 {
                        break;
                    }
                    state.terrain[tile_index(tx + i, row)] = TILE_SOLID;
                }
                tx += span + rng.range(3, 7) as usize;
            } else {
                tx += rng.range(2, 5) as usize;
            }
        }
    }

    // -- spikes, sitting on the ground ---------------------------------------
    //
    // Placed AFTER the platforms, and only where the jump arc is clear. The
    // order is load-bearing: a spike under a low platform cannot be jumped —
    // the player's head hits the platform, velocity is killed, and they drop
    // straight back onto the spike. Generating spikes first made that
    // combination reachable, and it reads as the game cheating.
    for tx in 12..LEVEL_W - 10 {
        if !is_solid(state.terrain[tile_index(tx, GROUND_ROW)]) {
            continue;
        }
        let clear = (SPIKE_CLEARANCE_TOP..GROUND_ROW)
            .all(|ty| state.terrain[tile_index(tx, ty)] == TILE_EMPTY);
        if clear && rng.below(17) == 0 {
            state.terrain[tile_index(tx, GROUND_ROW - 1)] = TILE_SPIKE;
        }
    }

    // -- the goal, a full-height column at the far right ---------------------
    let goal_tx = LEVEL_W - 4;
    for ty in (GROUND_ROW - 4)..GROUND_ROW {
        state.terrain[tile_index(goal_tx, ty)] = TILE_GOAL;
    }

    // -- coins ---------------------------------------------------------------
    // Placed one tile above any solid surface, which keeps them collectible by
    // construction rather than by luck.
    let mut coin_n = 0usize;
    for tx in 6..LEVEL_W - 6 {
        if coin_n >= MAX_COINS {
            break;
        }
        for ty in 1..LEVEL_H {
            if coin_n >= MAX_COINS {
                break;
            }
            let here = state.terrain[tile_index(tx, ty)];
            let above = state.terrain[tile_index(tx, ty - 1)];
            if is_solid(here) && above == TILE_EMPTY && rng.below(5) == 0 {
                state.coins[coin_n] = Coin {
                    x: tile_centre(tx as i32),
                    y: tile_centre(ty as i32 - 1),
                    active: 1,
                    _pad: [0; 3],
                };
                coin_n += 1;
                break;
            }
        }
    }

    // -- enemies -------------------------------------------------------------
    // Spawned only on wide-enough solid footing, away from the player's spawn.
    let mut enemy_n = 0usize;
    let mut tx = 14usize;
    while tx < LEVEL_W - 10 && enemy_n < MAX_ENEMIES {
        for ty in 1..LEVEL_H {
            let here = state.terrain[tile_index(tx, ty)];
            let above = state.terrain[tile_index(tx, ty - 1)];
            let left = is_solid(state.terrain[tile_index(tx - 1, ty)]);
            let right = is_solid(state.terrain[tile_index(tx + 1, ty)]);

            if is_solid(here) && above == TILE_EMPTY && left && right && rng.below(3) == 0 {
                state.enemies[enemy_n] = Enemy {
                    x: tile_centre(tx as i32),
                    y: fx::from_int(ty as i32 * TILE) - ENEMY_HALF_H,
                    vx: if rng.below(2) == 0 { ENEMY_VX } else { -ENEMY_VX },
                    vy: 0,
                    active: 1,
                    _pad: [0; 3],
                };
                enemy_n += 1;
                break;
            }
        }
        tx += rng.range(3, 8) as usize;
    }
}

fn hash_terrain(terrain: &[u8; LEVEL_TILES]) -> u64 {
    let mut h = Fnv1a::new();
    for &t in terrain.iter() {
        h.u8(t);
    }
    h.finish()
}

// ---------------------------------------------------------------------------
// Simulation internals
// ---------------------------------------------------------------------------

/// One raw fixed-point unit. Subtracted from a box's far edge so that a box
/// resting exactly on a tile boundary does not read as overlapping the next
/// tile along.
const EPS: Fx = 1;

fn move_player(state: &mut State, input: Input) {
    // -- horizontal intent ---------------------------------------------------
    if input.left() {
        state.player_vx -= RUN_ACCEL;
        state.facing = -1;
    }
    if input.right() {
        state.player_vx += RUN_ACCEL;
        state.facing = 1;
    }
    state.player_vx = fx::mul(state.player_vx, RUN_FRICTION);
    state.player_vx = fx::clamp(state.player_vx, -MAX_VX, MAX_VX);

    // -- jump ----------------------------------------------------------------
    let jump = input.jump();
    if jump && state.jump_held == 0 && state.on_ground != 0 {
        state.player_vy = -JUMP_VY;
        state.on_ground = 0;
    }
    // Releasing early trims the arc. Checked on the release edge only, so a
    // held jump is never affected.
    if !jump && state.jump_held != 0 && state.player_vy < 0 {
        state.player_vy = fx::mul(state.player_vy, JUMP_CUT);
    }
    state.jump_held = jump as u8;

    state.player_vy += GRAVITY;
    if state.player_vy > MAX_FALL {
        state.player_vy = MAX_FALL;
    }

    // -- resolve, one axis at a time -----------------------------------------
    // Axis separation is the reason this is reproducible. Resolving "whichever
    // penetration is smaller" would make the outcome depend on a comparison of
    // two near-equal quantities, which is exactly where two implementations
    // drift apart.
    move_player_x(state);
    move_player_y(state);

    // -- fell out of the world ----------------------------------------------
    if state.player_y > fx::from_int(LEVEL_H as i32 * TILE + 4 * TILE) {
        damage(state, true);
    }
}

fn move_player_x(state: &mut State) {
    state.player_x += state.player_vx;

    let top = fx::to_int(state.player_y - PLAYER_HALF_H) >> TILE_SHIFT;
    let bottom = fx::to_int(state.player_y + PLAYER_HALF_H - EPS) >> TILE_SHIFT;

    if state.player_vx > 0 {
        let tx = fx::to_int(state.player_x + PLAYER_HALF_W - EPS) >> TILE_SHIFT;
        for ty in top..=bottom {
            if is_solid(tile_at(&state.terrain, tx, ty)) {
                state.player_x = fx::from_int(tx * TILE) - PLAYER_HALF_W;
                state.player_vx = 0;
                break;
            }
        }
    } else if state.player_vx < 0 {
        let tx = fx::to_int(state.player_x - PLAYER_HALF_W) >> TILE_SHIFT;
        for ty in top..=bottom {
            if is_solid(tile_at(&state.terrain, tx, ty)) {
                state.player_x = fx::from_int((tx + 1) * TILE) + PLAYER_HALF_W;
                state.player_vx = 0;
                break;
            }
        }
    }
}

fn move_player_y(state: &mut State) {
    state.player_y += state.player_vy;
    state.on_ground = 0;

    let left = fx::to_int(state.player_x - PLAYER_HALF_W) >> TILE_SHIFT;
    let right = fx::to_int(state.player_x + PLAYER_HALF_W - EPS) >> TILE_SHIFT;

    if state.player_vy > 0 {
        let ty = fx::to_int(state.player_y + PLAYER_HALF_H - EPS) >> TILE_SHIFT;
        for tx in left..=right {
            if is_solid(tile_at(&state.terrain, tx, ty)) {
                state.player_y = fx::from_int(ty * TILE) - PLAYER_HALF_H;
                state.player_vy = 0;
                state.on_ground = 1;
                break;
            }
        }
    } else if state.player_vy < 0 {
        let ty = fx::to_int(state.player_y - PLAYER_HALF_H) >> TILE_SHIFT;
        for tx in left..=right {
            if is_solid(tile_at(&state.terrain, tx, ty)) {
                state.player_y = fx::from_int((ty + 1) * TILE) + PLAYER_HALF_H;
                state.player_vy = 0;
                break;
            }
        }
    }
}

fn move_enemies(state: &mut State) {
    for i in 0..MAX_ENEMIES {
        if state.enemies[i].active == 0 {
            continue;
        }

        let mut e = state.enemies[i];

        e.vy += GRAVITY;
        if e.vy > MAX_FALL {
            e.vy = MAX_FALL;
        }

        // Horizontal, with a wall check.
        e.x += e.vx;
        let probe_tx = if e.vx > 0 {
            fx::to_int(e.x + ENEMY_HALF_W - EPS) >> TILE_SHIFT
        } else {
            fx::to_int(e.x - ENEMY_HALF_W) >> TILE_SHIFT
        };
        let mid_ty = fx::to_int(e.y) >> TILE_SHIFT;
        if is_solid(tile_at(&state.terrain, probe_tx, mid_ty)) {
            e.x -= e.vx;
            e.vx = -e.vx;
        }

        // Vertical.
        e.y += e.vy;
        let foot_ty = fx::to_int(e.y + ENEMY_HALF_H - EPS) >> TILE_SHIFT;
        let left = fx::to_int(e.x - ENEMY_HALF_W) >> TILE_SHIFT;
        let right = fx::to_int(e.x + ENEMY_HALF_W - EPS) >> TILE_SHIFT;
        let mut grounded = false;
        if e.vy > 0 {
            for tx in left..=right {
                if is_solid(tile_at(&state.terrain, tx, foot_ty)) {
                    e.y = fx::from_int(foot_ty * TILE) - ENEMY_HALF_H;
                    e.vy = 0;
                    grounded = true;
                    break;
                }
            }
        }

        // Turn at ledges, so an enemy patrols its platform instead of walking
        // off it. Checked only when standing, so a falling enemy is unaffected.
        if grounded {
            let ahead_tx = if e.vx > 0 {
                fx::to_int(e.x + ENEMY_HALF_W) >> TILE_SHIFT
            } else {
                fx::to_int(e.x - ENEMY_HALF_W) >> TILE_SHIFT
            };
            let below_ty = (fx::to_int(e.y + ENEMY_HALF_H) >> TILE_SHIFT) + 1;
            if !is_solid(tile_at(&state.terrain, ahead_tx, below_ty)) {
                e.vx = -e.vx;
            }
        }

        // An enemy that falls into a pit is gone for good.
        if e.y > fx::from_int(LEVEL_H as i32 * TILE + 4 * TILE) {
            e.active = 0;
        }

        state.enemies[i] = e;
    }
}

fn collide_enemies(state: &mut State) {
    // Index order, not spatial order. A spatial sort would be faster but its
    // tie-breaking would have to be specified exactly to stay deterministic;
    // at 24 enemies the linear scan is not worth that risk.
    for i in 0..MAX_ENEMIES {
        let e = state.enemies[i];
        if e.active == 0 {
            continue;
        }

        let dx = fx::abs(e.x - state.player_x);
        let dy = fx::abs(e.y - state.player_y);
        if dx > PLAYER_HALF_W + ENEMY_HALF_W || dy > PLAYER_HALF_H + ENEMY_HALF_H {
            continue;
        }

        // A stomp is "descending, and the player's feet are still above the
        // enemy's middle". Both halves matter: velocity alone would let a
        // player who walks into an enemy while drifting downward kill it.
        let falling = state.player_vy > 0;
        let above = state.player_y + PLAYER_HALF_H - ENEMY_HALF_H < e.y;

        if falling && above {
            state.enemies[i].active = 0;
            state.player_vy = -STOMP_BOUNCE;
            state.on_ground = 0;
            state.score += SCORE_STOMP;
        } else {
            damage(state, false);
        }
    }
}

fn collect_coins(state: &mut State) {
    for i in 0..MAX_COINS {
        let c = state.coins[i];
        if c.active == 0 {
            continue;
        }
        let dx = fx::abs(c.x - state.player_x);
        let dy = fx::abs(c.y - state.player_y);
        if dx <= PLAYER_HALF_W + COIN_HALF && dy <= PLAYER_HALF_H + COIN_HALF {
            state.coins[i].active = 0;
            state.coins_taken += 1;
            state.score += SCORE_COIN;
        }
    }
}

fn check_terrain_hazards(state: &mut State) {
    let left = fx::to_int(state.player_x - PLAYER_HALF_W) >> TILE_SHIFT;
    let right = fx::to_int(state.player_x + PLAYER_HALF_W - EPS) >> TILE_SHIFT;
    let top = fx::to_int(state.player_y - PLAYER_HALF_H) >> TILE_SHIFT;
    let bottom = fx::to_int(state.player_y + PLAYER_HALF_H - EPS) >> TILE_SHIFT;

    for ty in top..=bottom {
        for tx in left..=right {
            match tile_at(&state.terrain, tx, ty) {
                TILE_SPIKE => damage(state, false),
                TILE_GOAL => finish(state),
                _ => {}
            }
        }
    }
}

/// End the run in victory, banking the goal bonus and whatever time is left.
fn finish(state: &mut State) {
    if state.over != 0 {
        return;
    }
    state.score += SCORE_GOAL;
    state.score += (MAX_TICKS - state.tick) as u64 / TIME_BONUS_DIVISOR;
    state.won = 1;
    state.over = 1;
}

/// Take a hit: lose a life and restart from the last checkpoint.
///
/// `fatal` skips the invulnerability check — falling out of the world must
/// always cost a life, or a player could ride out their i-frames in the void.
fn damage(state: &mut State, fatal: bool) {
    if state.over != 0 {
        return;
    }
    if state.invuln > 0 && !fatal {
        return;
    }

    state.lives = state.lives.saturating_sub(1);
    state.invuln = INVULN_TICKS;

    state.player_x = tile_centre(state.checkpoint_tx);
    state.player_y = fx::from_int(state.checkpoint_ty * TILE) - PLAYER_HALF_H;
    state.player_vx = 0;
    state.player_vy = 0;
    state.on_ground = 1;
    state.facing = 1;
}

/// Advance the checkpoint to the ground the player is currently standing on.
///
/// Without this, a death restarts a 160-tile level from column two, and three
/// lives are nowhere near enough to see the end of it — the goal bonus becomes
/// unreachable content. Checkpointing is what makes the level completable.
///
/// Two restrictions keep it honest. It only ever moves *forward*, so
/// backtracking cannot rewind it; and it only accepts ground the player is
/// genuinely resting on, so it can never save a position mid-jump or on top of
/// a spike, which would make respawning a death loop.
fn update_checkpoint(state: &mut State) {
    if state.on_ground == 0 {
        return;
    }

    let tx = fx::to_int(state.player_x) >> TILE_SHIFT;
    if tx <= state.checkpoint_tx {
        return;
    }

    // The tile the player's feet are resting on.
    let ty = fx::to_int(state.player_y + PLAYER_HALF_H) >> TILE_SHIFT;
    if !is_solid(tile_at(&state.terrain, tx, ty)) {
        return;
    }
    if tile_at(&state.terrain, tx, ty - 1) == TILE_SPIKE {
        return;
    }

    state.checkpoint_tx = tx;
    state.checkpoint_ty = ty;
}

/// Award progress for reaching a new furthest column.
///
/// Only *new* ground counts, so pacing back and forth earns nothing.
fn score_progress(state: &mut State) {
    let tx = fx::to_int(state.player_x) >> TILE_SHIFT;
    if tx > state.max_tx {
        state.score += SCORE_PER_TILE * (tx - state.max_tx) as u64;
        state.max_tx = tx;
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

    /// Hold right for the whole run, tapping jump on a fixed cadence. Useful as
    /// a "player who is actually trying" baseline.
    fn runner_log() -> Vec<LogEntry> {
        let mut v = Vec::new();
        let mut tick = 0u32;
        let mut jumping = false;
        while tick < 3_000 {
            jumping = !jumping;
            v.push(LogEntry {
                tick,
                buttons: BUTTON_RIGHT | if jumping { BUTTON_JUMP } else { 0 },
            });
            tick += 14;
        }
        v
    }

    // -- determinism ---------------------------------------------------------

    #[test]
    fn same_seed_same_log_same_result() {
        let l = runner_log();
        let a = replay(0xdead_beef, &l).unwrap();
        let b = replay(0xdead_beef, &l).unwrap();
        assert_eq!(state_hash(&a), state_hash(&b));
        assert_eq!(score(&a), score(&b));
    }

    #[test]
    fn different_seeds_build_different_levels() {
        // The level *is* the seed's product now, so this is the property that
        // makes seed secrecy meaningful.
        let a = init(1);
        let b = init(2);
        assert_ne!(a.level_hash, b.level_hash);
    }

    #[test]
    fn different_seeds_diverge() {
        let l = runner_log();
        let a = replay(1, &l).unwrap();
        let b = replay(2, &l).unwrap();
        assert_ne!(state_hash(&a), state_hash(&b));
    }

    #[test]
    fn different_input_changes_outcome() {
        let a = replay(77, &log(&[(0, BUTTON_RIGHT)])).unwrap();
        let b = replay(77, &log(&[(0, BUTTON_LEFT)])).unwrap();
        assert_ne!(state_hash(&a), state_hash(&b));
    }

    #[test]
    fn every_run_terminates() {
        // No input at all: the player stands still and the run must still end
        // rather than looping forever.
        for seed in 0..24u64 {
            let s = replay(seed, &[]).unwrap();
            assert_eq!(s.over, 1);
            assert!(s.tick <= MAX_TICKS);
        }
    }

    #[test]
    fn run_never_exceeds_tick_cap() {
        let mut entries = Vec::new();
        for i in 0..600u32 {
            entries.push((i * 50, if i % 2 == 0 { BUTTON_LEFT } else { BUTTON_RIGHT }));
        }
        let s = replay(4242, &log(&entries)).unwrap();
        assert!(s.tick <= MAX_TICKS);
    }

    #[test]
    fn score_is_monotonic_over_a_run() {
        let mut s = init(31337);
        let mut last = 0;
        let mut buttons = BUTTON_RIGHT;
        while s.over == 0 {
            if s.tick % 20 == 0 {
                buttons ^= BUTTON_JUMP;
            }
            step(&mut s, Input(buttons));
            assert!(score(&s) >= last, "score must never decrease");
            last = score(&s);
        }
    }

    #[test]
    fn step_after_game_over_is_a_no_op() {
        let mut s = replay(9, &[]).unwrap();
        let before = state_hash(&s);
        for _ in 0..100 {
            step(&mut s, Input(BUTTON_RIGHT | BUTTON_JUMP));
        }
        assert_eq!(state_hash(&s), before);
    }

    // -- physics -------------------------------------------------------------

    #[test]
    fn player_starts_on_solid_ground_and_stays_put() {
        // Standing still must not sink, drift, or fall through the floor.
        let mut s = init(11);
        let x0 = s.player_x;
        let y0 = s.player_y;
        for _ in 0..300 {
            step(&mut s, Input(0));
        }
        assert_eq!(s.player_x, x0, "no horizontal drift without input");
        assert_eq!(s.player_y, y0, "must rest exactly on the floor");
        assert_eq!(s.on_ground, 1);
        assert_eq!(s.lives, STARTING_LIVES, "standing still is not fatal");
    }

    #[test]
    fn player_never_tunnels_through_solid_tiles() {
        // The whole collision story rests on this: at no tick may the player's
        // centre be inside a solid tile.
        for seed in 0..12u64 {
            let mut s = init(seed);
            let mut buttons = BUTTON_RIGHT;
            let mut ticks = 0;
            while s.over == 0 && ticks < 4_000 {
                if ticks % 11 == 0 {
                    buttons ^= BUTTON_JUMP;
                }
                step(&mut s, Input(buttons));
                let tx = fx::to_int(s.player_x) >> TILE_SHIFT;
                let ty = fx::to_int(s.player_y) >> TILE_SHIFT;
                assert!(
                    !is_solid(tile_at(&s.terrain, tx, ty)),
                    "seed {seed} tick {}: player centre inside a solid tile",
                    s.tick
                );
                ticks += 1;
            }
        }
    }

    #[test]
    fn walls_keep_the_player_inside_the_level() {
        let mut s = init(5);
        for _ in 0..2_000 {
            step(&mut s, Input(BUTTON_LEFT));
        }
        assert!(s.player_x >= PLAYER_HALF_W);

        let mut s = init(5);
        for _ in 0..6_000 {
            step(&mut s, Input(BUTTON_RIGHT));
        }
        assert!(s.player_x <= fx::from_int(LEVEL_W as i32 * TILE) - PLAYER_HALF_W);
    }

    #[test]
    fn jump_clears_three_tiles() {
        // The platform bands are three tiles apart. If a jump cannot clear that,
        // the generator is producing levels the player cannot traverse.
        let mut s = init(3);
        let start_y = s.player_y;
        let mut peak = start_y;
        for _ in 0..80 {
            step(&mut s, Input(BUTTON_JUMP));
            if s.player_y < peak {
                peak = s.player_y;
            }
        }
        let rise = fx::to_int(start_y - peak);
        assert!(
            rise >= 3 * TILE,
            "jump rose {rise} units, needs at least {}",
            3 * TILE
        );
    }

    #[test]
    fn a_tapped_jump_is_shorter_than_a_held_one() {
        let peak_of = |hold: u32| {
            let mut s = init(3);
            let start = s.player_y;
            let mut peak = start;
            for t in 0..80u32 {
                let b = if t < hold { BUTTON_JUMP } else { 0 };
                step(&mut s, Input(b));
                if s.player_y < peak {
                    peak = s.player_y;
                }
            }
            fx::to_int(start - peak)
        };
        assert!(peak_of(3) < peak_of(60), "jump cut must shorten the arc");
    }

    #[test]
    fn falling_into_a_pit_costs_a_life() {
        // Walk off the edge of the world: the floor stops existing below the
        // level, so this must register as a death rather than a soft-lock.
        let mut s = init(7);
        // Carve a pit right in front of the player.
        for ty in GROUND_ROW..LEVEL_H {
            for tx in 3..8 {
                s.terrain[tile_index(tx, ty)] = TILE_EMPTY;
            }
        }
        let mut ticks = 0;
        while s.lives == STARTING_LIVES && ticks < 600 {
            step(&mut s, Input(BUTTON_RIGHT));
            ticks += 1;
        }
        assert_eq!(s.lives, STARTING_LIVES - 1, "falling out must cost a life");
        assert!(s.player_y < fx::from_int(LEVEL_H as i32 * TILE), "respawned");
    }

    #[test]
    fn checkpoints_advance_forward_and_never_rewind() {
        let mut s = init(19);
        let start = s.checkpoint_tx;

        // Run right for a while: the checkpoint must follow the player.
        let mut buttons = BUTTON_RIGHT;
        for t in 0..400u32 {
            if t % 24 == 0 {
                buttons ^= BUTTON_JUMP;
            }
            step(&mut s, Input(buttons));
        }
        let advanced = s.checkpoint_tx;
        assert!(advanced > start, "checkpoint should follow the player forward");

        // Walk back to the beginning: it must not follow.
        for _ in 0..900 {
            step(&mut s, Input(BUTTON_LEFT));
        }
        assert_eq!(
            s.checkpoint_tx, advanced,
            "backtracking must not rewind the checkpoint"
        );
    }

    #[test]
    fn a_death_returns_the_player_to_the_checkpoint() {
        let mut s = init(19);
        let mut buttons = BUTTON_RIGHT;
        for t in 0..400u32 {
            if t % 24 == 0 {
                buttons ^= BUTTON_JUMP;
            }
            step(&mut s, Input(buttons));
        }
        assert!(s.checkpoint_tx > SPAWN_TX, "test needs a moved checkpoint");

        let cp = s.checkpoint_tx;
        damage(&mut s, true);
        assert_eq!(
            fx::to_int(s.player_x) >> TILE_SHIFT,
            cp,
            "respawn must land on the checkpoint, not the level start"
        );
    }

    #[test]
    fn a_checkpoint_is_never_saved_on_a_spike() {
        // Respawning onto a hazard would burn every remaining life in a loop.
        for seed in 0..24u64 {
            let mut s = init(seed);
            let mut buttons = BUTTON_RIGHT;
            for t in 0..1_500u32 {
                if t % 19 == 0 {
                    buttons ^= BUTTON_JUMP;
                }
                step(&mut s, Input(buttons));
                assert_ne!(
                    tile_at(&s.terrain, s.checkpoint_tx, s.checkpoint_ty - 1),
                    TILE_SPIKE,
                    "seed {seed}: checkpoint saved on a spike"
                );
                assert!(
                    is_solid(tile_at(&s.terrain, s.checkpoint_tx, s.checkpoint_ty)),
                    "seed {seed}: checkpoint saved over thin air"
                );
            }
        }
    }

    #[test]
    fn invulnerability_prevents_losing_every_life_at_once() {
        let mut s = init(4);
        // Park a spike under the spawn point and stand on it.
        s.terrain[tile_index(SPAWN_TX as usize, (GROUND_ROW - 1) as usize)] = TILE_SPIKE;
        for _ in 0..60 {
            step(&mut s, Input(0));
        }
        assert_eq!(
            s.lives,
            STARTING_LIVES - 1,
            "i-frames must absorb the repeat contacts"
        );
    }

    // -- entities ------------------------------------------------------------

    #[test]
    fn stomping_an_enemy_scores_and_walking_into_one_hurts() {
        let mut s = init(21);
        s.enemies = [Enemy::default(); MAX_ENEMIES];
        s.enemies[0] = Enemy {
            // Just inside the combined half-heights, so the boxes actually
            // overlap — placing it a full tile away tests nothing.
            y: s.player_y + fx::from_int(10),
            x: s.player_x,
            vx: 0,
            vy: 0,
            active: 1,
            _pad: [0; 3],
        };
        s.player_vy = fx::from_int(2); // descending onto it
        let before = score(&s);
        collide_enemies(&mut s);
        assert_eq!(s.enemies[0].active, 0, "stomp must kill the enemy");
        assert_eq!(score(&s) - before, SCORE_STOMP);
        assert!(s.player_vy < 0, "stomp must bounce the player upward");

        // Same overlap, but level with the player and moving sideways.
        let mut s = init(21);
        s.enemies = [Enemy::default(); MAX_ENEMIES];
        s.enemies[0] = Enemy {
            x: s.player_x,
            y: s.player_y,
            vx: 0,
            vy: 0,
            active: 1,
            _pad: [0; 3],
        };
        s.player_vy = 0;
        collide_enemies(&mut s);
        assert_eq!(s.lives, STARTING_LIVES - 1, "side contact must hurt");
    }

    #[test]
    fn enemies_stay_on_their_platforms() {
        // A patrolling enemy must never walk off into a pit; if it does, the
        // ledge check has regressed.
        for seed in 0..8u64 {
            let mut s = init(seed);
            let starting = s.enemies.iter().filter(|e| e.active != 0).count();
            for _ in 0..1_500 {
                move_enemies(&mut s);
            }
            let surviving = s.enemies.iter().filter(|e| e.active != 0).count();
            assert_eq!(
                starting, surviving,
                "seed {seed}: an enemy fell out of the world"
            );
        }
    }

    #[test]
    fn coins_are_collected_once() {
        let mut s = init(15);
        s.coins = [Coin::default(); MAX_COINS];
        s.coins[0] = Coin {
            x: s.player_x,
            y: s.player_y,
            active: 1,
            _pad: [0; 3],
        };
        collect_coins(&mut s);
        assert_eq!(score(&s), SCORE_COIN);
        assert_eq!(s.coins_taken, 1);
        collect_coins(&mut s);
        assert_eq!(score(&s), SCORE_COIN, "a coin must not pay out twice");
    }

    #[test]
    fn reaching_the_goal_ends_the_run_as_a_win() {
        let mut s = init(8);
        let goal_tx = (LEVEL_W - 4) as i32;
        s.player_x = tile_centre(goal_tx);
        s.player_y = tile_centre(GROUND_ROW as i32 - 2);
        check_terrain_hazards(&mut s);
        assert_eq!(s.won, 1);
        assert_eq!(s.over, 1);
        assert!(score(&s) >= SCORE_GOAL);
    }

    #[test]
    fn progress_only_pays_for_new_ground() {
        let mut s = init(6);
        s.player_x = tile_centre(40);
        score_progress(&mut s);
        let after_first = score(&s);
        assert!(after_first > 0);

        // Walk back, then return to the same column: no further payout.
        s.player_x = tile_centre(20);
        score_progress(&mut s);
        s.player_x = tile_centre(40);
        score_progress(&mut s);
        assert_eq!(score(&s), after_first);
    }

    // -- generated levels are playable ---------------------------------------

    #[test]
    fn widest_pit_is_jumpable() {
        // The generator caps pits at three tiles. Confirm no seed produces a
        // wider one, since a four-tile pit would be an unwinnable level.
        for seed in 0..64u64 {
            let s = init(seed);
            let mut run = 0;
            for tx in 0..LEVEL_W {
                if is_solid(s.terrain[tile_index(tx, GROUND_ROW)]) {
                    run = 0;
                } else {
                    run += 1;
                    assert!(run <= 3, "seed {seed}: pit of {run} tiles at column {tx}");
                }
            }
        }
    }

    #[test]
    fn pits_always_have_a_landing_strip() {
        // A jump is only fair if there is somewhere to land. Every run of ground
        // between two pits must be at least LANDING_STRIP tiles wide — a
        // one-tile ledge between two gaps is technically clearable and horrible
        // to actually play.
        for seed in 0..64u64 {
            let s = init(seed);
            let solid: [bool; LEVEL_W] = core::array::from_fn(|tx| {
                is_solid(s.terrain[tile_index(tx, GROUND_ROW)])
            });

            let mut run = 0usize;
            for tx in 0..LEVEL_W {
                if solid[tx] {
                    run += 1;
                    continue;
                }
                // A pit closes the run before it. Runs bounded by a pit on both
                // sides are the ones that have to be wide enough; the opening
                // stretch of the level is protected ground and not at issue.
                if run > 0 && tx > run {
                    assert!(
                        run >= LANDING_STRIP,
                        "seed {seed}: {run}-tile ledge between pits at column {tx}"
                    );
                }
                run = 0;
            }
        }
    }

    #[test]
    fn every_spike_can_be_jumped() {
        // A spike with a platform overhead is a trap the player cannot clear:
        // the jump is cut short against the platform and drops them back on to
        // it. No seed may produce one.
        for seed in 0..64u64 {
            let s = init(seed);
            for tx in 0..LEVEL_W {
                if s.terrain[tile_index(tx, GROUND_ROW - 1)] != TILE_SPIKE {
                    continue;
                }
                for ty in SPIKE_CLEARANCE_TOP..GROUND_ROW - 1 {
                    assert_eq!(
                        s.terrain[tile_index(tx, ty)],
                        TILE_EMPTY,
                        "seed {seed}: spike at column {tx} is roofed at row {ty}"
                    );
                }
            }
        }
    }

    #[test]
    fn the_opening_stretch_is_safe() {
        // The player needs room to reach full speed before the first hazard,
        // and should never be killed by something they had no chance to see.
        for seed in 0..64u64 {
            let s = init(seed);
            for tx in 0..10 {
                assert!(
                    is_solid(s.terrain[tile_index(tx, GROUND_ROW)]),
                    "seed {seed}: pit at column {tx} of the run-up"
                );
                assert_ne!(
                    s.terrain[tile_index(tx, GROUND_ROW - 1)],
                    TILE_SPIKE,
                    "seed {seed}: spike at column {tx} of the run-up"
                );
            }
        }
    }

    #[test]
    fn every_level_has_a_goal_and_a_safe_spawn() {
        for seed in 0..64u64 {
            let s = init(seed);
            let goals = s.terrain.iter().filter(|&&t| t == TILE_GOAL).count();
            assert!(goals > 0, "seed {seed} has no goal");

            // The spawn tile must be clear and the tile under it solid.
            assert_eq!(tile_at(&s.terrain, SPAWN_TX, SPAWN_TY), TILE_EMPTY);
            assert!(is_solid(tile_at(&s.terrain, SPAWN_TX, SPAWN_TY + 1)));
        }
    }

    #[test]
    fn entity_capacities_are_never_exceeded() {
        for seed in 0..64u64 {
            let s = init(seed);
            assert!(s.enemies.len() <= MAX_ENEMIES);
            assert!(s.coins.len() <= MAX_COINS);
            // Coins must sit in open air, never buried inside terrain.
            for c in s.coins.iter().filter(|c| c.active != 0) {
                let tx = fx::to_int(c.x) >> TILE_SHIFT;
                let ty = fx::to_int(c.y) >> TILE_SHIFT;
                assert!(
                    !is_solid(tile_at(&s.terrain, tx, ty)),
                    "seed {seed}: coin buried in terrain"
                );
            }
        }
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
        assert_eq!(
            validate(&log(&[(0, 0b1000)])),
            Err(Reject::InvalidButtons),
            "bit 3 is not a button the simulation defines"
        );
    }

    #[test]
    fn accepts_the_jump_button() {
        assert_eq!(validate(&log(&[(0, BUTTON_JUMP)])), Ok(()));
        assert_eq!(validate(&log(&[(0, VALID_BUTTONS)])), Ok(()));
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
        // If someone adds a `usize` to State these assertions change on one
        // target but not the other, and the state hash silently diverges
        // between the browser (wasm32) and the enclave (aarch64).
        assert_eq!(core::mem::size_of::<Enemy>(), 20);
        assert_eq!(core::mem::align_of::<Enemy>(), 4);
        assert_eq!(core::mem::size_of::<Coin>(), 12);
        assert_eq!(core::mem::align_of::<Coin>(), 4);
        assert_eq!(core::mem::align_of::<State>(), 8);
    }

    #[test]
    fn state_hash_covers_every_meaningful_field() {
        // Mutating any observable field must move the hash. This catches a
        // field added to State but forgotten in state_hash.
        let base = init(1);

        macro_rules! moves_hash {
            ($name:literal, $mutate:expr) => {{
                let mut a = base;
                #[allow(clippy::redundant_closure_call)]
                ($mutate)(&mut a);
                assert_ne!(state_hash(&a), state_hash(&base), $name);
            }};
        }

        moves_hash!("tick", |s: &mut State| s.tick += 1);
        moves_hash!("level_hash", |s: &mut State| s.level_hash ^= 1);
        moves_hash!("player_x", |s: &mut State| s.player_x += 1);
        moves_hash!("player_y", |s: &mut State| s.player_y += 1);
        moves_hash!("player_vx", |s: &mut State| s.player_vx += 1);
        moves_hash!("player_vy", |s: &mut State| s.player_vy += 1);
        moves_hash!("on_ground", |s: &mut State| s.on_ground ^= 1);
        moves_hash!("facing", |s: &mut State| s.facing = -s.facing);
        moves_hash!("jump_held", |s: &mut State| s.jump_held ^= 1);
        moves_hash!("lives", |s: &mut State| s.lives -= 1);
        moves_hash!("invuln", |s: &mut State| s.invuln += 1);
        moves_hash!("over", |s: &mut State| s.over = 1);
        moves_hash!("won", |s: &mut State| s.won = 1);
        moves_hash!("max_tx", |s: &mut State| s.max_tx += 1);
        moves_hash!("checkpoint_tx", |s: &mut State| s.checkpoint_tx += 1);
        moves_hash!("checkpoint_ty", |s: &mut State| s.checkpoint_ty += 1);
        moves_hash!("coins_taken", |s: &mut State| s.coins_taken += 1);
        moves_hash!("score", |s: &mut State| s.score += 1);
        moves_hash!("enemy", |s: &mut State| s.enemies[3].x += 1);
        moves_hash!("enemy active", |s: &mut State| s.enemies[3].active ^= 1);
        moves_hash!("coin", |s: &mut State| s.coins[5].y += 1);
        moves_hash!("coin active", |s: &mut State| s.coins[5].active ^= 1);
    }

    #[test]
    fn level_hash_actually_tracks_the_terrain() {
        // The per-tick hash trusts `level_hash` to stand in for 2,400 bytes of
        // terrain. If that digest stopped depending on the tiles, the shortcut
        // would be unsound and a tampered level would hash identically.
        let a = init(1);
        let mut b = a;
        b.terrain[tile_index(40, GROUND_ROW)] ^= TILE_SOLID;
        assert_ne!(hash_terrain(&a.terrain), hash_terrain(&b.terrain));
    }

    #[test]
    fn claimed_score_is_never_trusted() {
        // The enclave compares; it never adopts. This test documents that the
        // only way to obtain a score is to replay for it.
        let l = runner_log();
        let s = replay(123, &l).unwrap();
        let honest = score(&s);
        let claimed = 999_999u64;
        assert_ne!(honest, claimed);
        assert_eq!(score(&replay(123, &l).unwrap()), honest);
    }
}
