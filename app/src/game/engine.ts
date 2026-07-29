// The game loop and the input log.
//
// This file owns the one contract that must hold exactly, or the enclave will
// compute a different score from the same run and an honest player will be
// rejected on-chain:
//
//   at simulation tick T, every log entry stamped T is applied, then step().
//
// That is what `replay_with` does in crates/sim/src/lib.rs. Here it means the
// entry is pushed BEFORE stepping, stamped with the number of steps already
// taken (which equals State.tick). An off-by-one is silent — the game plays
// perfectly and only the attestation disagrees.

import { BUTTON_JUMP, BUTTON_LEFT, BUTTON_RIGHT, Sim, type Snapshot } from "../sim/sim";
import { Renderer } from "./renderer";

/** Fixed simulation rate. The tick count IS the clock the enclave replays. */
const TICK_HZ = 60;
const TICK_MS = 1000 / TICK_HZ;

/**
 * Ceiling on catch-up work in a single frame.
 *
 * A backgrounded tab accumulates real time without rendering; without this the
 * first frame back would try to simulate thousands of ticks and lock the page.
 * Dropping that time is correct — the player was not pressing anything.
 */
const MAX_CATCHUP_MS = 250;

export type LogEntry = [tick: number, buttons: number];

export interface RunResult {
  score: bigint;
  ticks: number;
  won: boolean;
  lives: number;
  coins: number;
  inputLog: LogEntry[];
}

type Key = "left" | "right" | "jump";

const KEY_MAP: Record<string, Key> = {
  ArrowLeft: "left",
  KeyA: "left",
  ArrowRight: "right",
  KeyD: "right",
  Space: "jump",
  ArrowUp: "jump",
  KeyW: "jump",
};

export class Engine {
  private readonly sim: Sim;
  private readonly renderer: Renderer;
  private readonly held = new Set<Key>();

  private inputLog: LogEntry[] = [];
  private steps = 0;
  private lastButtons = 0;
  private acc = 0;
  private running = false;

  private onFrame: ((s: Snapshot) => void) | null = null;
  private onEnd: ((r: RunResult) => void) | null = null;

  constructor(sim: Sim, renderer: Renderer) {
    this.sim = sim;
    this.renderer = renderer;

    renderer.app.ticker.add((ticker) => this.tick(ticker.deltaMS));
    renderer.app.ticker.start();
  }

  /** Buttons currently held, as the simulation's bitmask. */
  private buttons(): number {
    let b = 0;
    if (this.held.has("left")) b |= BUTTON_LEFT;
    if (this.held.has("right")) b |= BUTTON_RIGHT;
    if (this.held.has("jump")) b |= BUTTON_JUMP;
    return b;
  }

  start(seed: bigint, onFrame: (s: Snapshot) => void, onEnd: (r: RunResult) => void): void {
    const terrain = this.sim.start(seed);
    this.renderer.setLevel(terrain, this.sim.levelW, this.sim.levelH, this.sim.tile);

    this.inputLog = [];
    this.steps = 0;
    this.lastButtons = 0;
    this.acc = 0;
    this.held.clear();
    this.onFrame = onFrame;
    this.onEnd = onEnd;
    this.running = true;

    const first = this.sim.read();
    this.renderer.draw(first);
    onFrame(first);
  }

  stop(): void {
    this.running = false;
  }

  private tick(deltaMS: number): void {
    if (!this.running) return;

    this.acc += Math.min(deltaMS, MAX_CATCHUP_MS);

    let ended = false;
    while (this.acc >= TICK_MS && !ended) {
      ended = this.stepOnce();
      this.acc -= TICK_MS;
    }

    const s = this.sim.read();
    this.renderer.draw(s);
    this.onFrame?.(s);

    if (ended) {
      this.running = false;
      this.onEnd?.({
        score: s.score,
        ticks: s.tick,
        won: s.won,
        lives: s.lives,
        coins: s.coins,
        inputLog: this.inputLog,
      });
    }
  }

  /** Advance one tick, recording the input change if there was one. */
  private stepOnce(): boolean {
    const b = this.buttons();
    if (b !== this.lastButtons) {
      this.inputLog.push([this.steps, b]);
      this.lastButtons = b;
    }
    const over = this.sim.step(b);
    this.steps++;
    return over;
  }

  // -- input ---------------------------------------------------------------

  handleKey(code: string, down: boolean): boolean {
    const k = KEY_MAP[code];
    if (!k) return false;
    if (down) this.held.add(k);
    else this.held.delete(k);
    return true;
  }

  /** Touch/pointer controls, for the app running on a phone. */
  setKey(k: Key, down: boolean): void {
    if (down) this.held.add(k);
    else this.held.delete(k);
  }

  /**
   * Release everything.
   *
   * A lost focus that leaves a key stuck does not merely look wrong: the held
   * button keeps being written into the input log, and the enclave will faithfully
   * replay a player who ran into a pit while the tab was in the background.
   */
  releaseAll(): void {
    this.held.clear();
  }

  destroy(): void {
    this.running = false;
    this.sim.dispose();
  }
}
