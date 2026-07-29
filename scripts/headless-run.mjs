#!/usr/bin/env node
// Play a run without a browser, then have the enclave recompute the score.
//
//   node scripts/headless-run.mjs --verifier http://localhost:3001 [--k 0] [--player 0x…]
//
// This is the test that catches the failure the whole design is exposed to: the
// client drives the simulation through the *live-play* entry points
// (sim_create / sim_step_one), while the enclave replays the resulting log
// through a completely different entry point (sim_verify). Those two paths
// share the rules but not the plumbing, and nothing else in the repository
// exercises them against each other.
//
// If they ever disagree, an honest player's score gets rejected on-chain and the
// only symptom is a number that is quietly wrong. So this asserts they match.
//
// The bot is deliberately crude — hold right, jump at walls, gaps and hazards.
// It is not trying to be good at the game; it is trying to generate a long,
// varied input log that touches jumps, stomps, deaths and respawns.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const VERIFIER = (arg("verifier", "http://localhost:3001") || "").replace(/\/$/, "");
const PLAYER = arg("player", "0x00000000000000000000000000000000000000A1");
const K = Number(arg("k", "0"));
const MAX_TICKS = Number(arg("max-ticks", "36000"));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(HERE, "..", "target", "wasm32-unknown-unknown", "release", "sim_wasm.wasm");

const BUTTON_LEFT = 1, BUTTON_RIGHT = 2, BUTTON_JUMP = 4;
const TILE_EMPTY = 0, TILE_SOLID = 1, TILE_SPIKE = 2, TILE_GOAL = 3;
const FX = 65536;

// ---------------------------------------------------------------------------

const post = async (route, body) => {
  const r = await fetch(`${VERIFIER}${route}`, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${route}: ${j.error}`);
  return j;
};

const {instance} = await WebAssembly.instantiate(await readFile(WASM), {});
const w = instance.exports;

const LEVEL_W = w.sim_level_w();
const LEVEL_H = w.sim_level_h();
const TILE = w.sim_tile_size();
const MAX_ENEMIES = w.sim_max_enemies();
const SNAP = w.sim_snapshot_size();

// ---------------------------------------------------------------------------
// 1. Ask the enclave for a session seed
// ---------------------------------------------------------------------------

console.log(`verifier   ${VERIFIER}`);
const session = await post("/session", {player: PLAYER, k: K});
console.log(`session    epoch ${session.epoch} slot ${session.k}`);
console.log(`seed       ${session.seed}`);
console.log(`rulesHash  ${session.rulesHash}`);

// ---------------------------------------------------------------------------
// 2. Play it, exactly the way the browser does
// ---------------------------------------------------------------------------

const handle = w.sim_create(BigInt(session.seed));
if (!handle) throw new Error("sim_create failed");

const snapPtr = w.sim_alloc(SNAP);
const terrPtr = w.sim_alloc(LEVEL_W * LEVEL_H);
if (w.sim_terrain(handle, terrPtr, LEVEL_W * LEVEL_H) < 0) throw new Error("sim_terrain failed");
const terrain = new Uint8Array(w.memory.buffer).slice(terrPtr, terrPtr + LEVEL_W * LEVEL_H);

const tileAt = (tx, ty) => {
  if (tx < 0 || tx >= LEVEL_W) return TILE_SOLID;
  if (ty < 0 || ty >= LEVEL_H) return TILE_EMPTY;
  return terrain[ty * LEVEL_W + tx];
};

function snapshot() {
  if (w.sim_snapshot(handle, snapPtr, SNAP) < 0) throw new Error("sim_snapshot failed");
  const d = new DataView(w.memory.buffer);
  const s = {
    tick: d.getUint32(snapPtr, true),
    x: d.getInt32(snapPtr + 4, true) / FX,
    y: d.getInt32(snapPtr + 8, true) / FX,
    vx: d.getInt32(snapPtr + 12, true) / FX,
    onGround: d.getUint8(snapPtr + 20),
    lives: d.getUint8(snapPtr + 22),
    over: d.getUint8(snapPtr + 23),
    won: d.getUint8(snapPtr + 24),
    coins: d.getUint32(snapPtr + 28, true),
    score: d.getBigUint64(snapPtr + 32, true),
    enemies: [],
  };
  let off = snapPtr + 48;
  for (let i = 0; i < MAX_ENEMIES; i++, off += 12) {
    if (d.getUint8(off + 8) === 0) continue;
    s.enemies.push({x: d.getInt32(off, true) / FX, y: d.getInt32(off + 4, true) / FX});
  }
  return s;
}

/** Ticks the bot keeps holding jump after committing to one. */
const JUMP_HOLD = 16;
let holdJump = 0;

/**
 * Hold right; jump at anything that looks like it needs jumping over.
 *
 * The hold counter is not cosmetic. Releasing jump while still rising triggers
 * the simulation's jump-cut, so a bot that only sets JUMP on the takeoff tick
 * releases it the very next one and every jump collapses to a fraction of its
 * height — which reads as "the level is impossible" rather than "the bot let go
 * of the button". Keep holding.
 */
function decide(s) {
  let b = BUTTON_RIGHT;

  if (holdJump > 0) {
    holdJump--;
    return b | BUTTON_JUMP;
  }
  if (!s.onGround) return b;

  const ty = Math.floor(s.y / TILE);
  // Look further ahead the faster we are moving, so the jump starts in time.
  const reach = Math.max(12, 16 + s.vx * 4);
  const a1 = Math.floor((s.x + reach) / TILE);
  const a2 = Math.floor((s.x + reach + TILE) / TILE);

  const wall = tileAt(a1, ty) === TILE_SOLID;
  const gap = tileAt(a1, ty + 1) === TILE_EMPTY || tileAt(a2, ty + 1) === TILE_EMPTY;
  const spike = tileAt(a1, ty) === TILE_SPIKE || tileAt(a2, ty) === TILE_SPIKE;
  const enemy = s.enemies.some((e) => e.x - s.x > 0 && e.x - s.x < 30 && Math.abs(e.y - s.y) < 20);

  if (wall || gap || spike || enemy) {
    holdJump = JUMP_HOLD;
    b |= BUTTON_JUMP;
  }
  return b;
}

const inputLog = [];
let steps = 0;
let lastButtons = 0;

// Identical to the browser's stepOnce(): stamp the entry with the tick the
// simulation is currently ON, then step.
for (;;) {
  const s = snapshot();
  const b = decide(s);
  if (b !== lastButtons) {
    inputLog.push([steps, b]);
    lastButtons = b;
  }
  const over = w.sim_step_one(handle, b);
  if (over < 0) throw new Error(`sim_step_one status ${over}`);
  steps++;
  if (over === 1 || steps >= MAX_TICKS) break;
}

const final = snapshot();
const outcome = final.won ? "reached the goal" : final.lives === 0 ? "out of lives" : "time up";
console.log(`\nplayed     ${final.tick} ticks — ${outcome}`);
console.log(`local      score ${final.score}, ${final.coins} coins, ${final.lives} lives left`);
console.log(`log        ${inputLog.length} entries`);

// ---------------------------------------------------------------------------
// 3. Let the enclave recompute it from the log alone
// ---------------------------------------------------------------------------

const att = await post("/attest", {
  player: PLAYER,
  epoch: session.epoch,
  k: session.k,
  inputLog,
});

const enclave = BigInt(att.claim.score);
console.log(`\nenclave    replayed ${att.ticks} ticks, score ${enclave}`);
console.log(`digest     ${att.digest}`);

if (enclave !== final.score) {
  console.error(`\nDIVERGENCE: live play scored ${final.score}, replay scored ${enclave}`);
  console.error("The client and the enclave disagree. Do not deploy this.");
  process.exit(1);
}
if (att.ticks !== final.tick) {
  console.error(`\nDIVERGENCE: live play ran ${final.tick} ticks, replay ran ${att.ticks}`);
  process.exit(1);
}

console.log(`\nMATCH — live play and enclave replay agree on score and tick count`);
w.sim_destroy(handle);
