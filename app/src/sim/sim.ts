// Typed binding to sim.wasm (ABI version 2).
//
// This module never implements a game rule. It steps the compiled simulation
// and reads state back out. A JavaScript reimplementation of the physics would
// be a second set of rules, it would drift from the enclave's, and honest
// players would start being flagged as cheats.
//
// The snapshot layout below mirrors `sim_snapshot` in crates/sim-wasm/src/lib.rs.
// It is an explicit byte format rather than a view over the Rust struct, because
// rustc's field ordering is not stable and a compiler upgrade could silently
// reshuffle it.

export const BUTTON_LEFT = 1;
export const BUTTON_RIGHT = 2;
export const BUTTON_JUMP = 4;

export const TILE_EMPTY = 0;
export const TILE_SOLID = 1;
export const TILE_SPIKE = 2;
export const TILE_GOAL = 3;

/** 16.16 fixed point, matching crates/sim/src/fx.rs. */
const FX = 65536;

const ABI_VERSION = 2;

interface SimExports {
  memory: WebAssembly.Memory;
  sim_abi_version(): number;
  sim_level_w(): number;
  sim_level_h(): number;
  sim_tile_size(): number;
  sim_max_enemies(): number;
  sim_max_coins(): number;
  sim_snapshot_size(): number;
  sim_alloc(len: number): number;
  sim_dealloc(ptr: number, len: number): void;
  sim_create(seed: bigint): number;
  sim_destroy(handle: number): void;
  sim_step_one(handle: number, buttons: number): number;
  sim_terrain(handle: number, out: number, cap: number): number;
  sim_snapshot(handle: number, out: number, cap: number): number;
}

export interface Entity {
  x: number;
  y: number;
}

export interface Snapshot {
  tick: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  onGround: boolean;
  facing: number;
  lives: number;
  over: boolean;
  won: boolean;
  invuln: boolean;
  coins: number;
  score: bigint;
  maxTx: number;
  enemies: Entity[];
  coinsOnField: Entity[];
}

export class Sim {
  readonly levelW: number;
  readonly levelH: number;
  readonly tile: number;

  private readonly w: SimExports;
  private readonly maxEnemies: number;
  private readonly maxCoins: number;
  private readonly snapSize: number;
  private readonly snapPtr: number;
  private readonly terrainPtr: number;

  private handle = 0;

  private constructor(w: SimExports) {
    this.w = w;
    this.levelW = w.sim_level_w();
    this.levelH = w.sim_level_h();
    this.tile = w.sim_tile_size();
    this.maxEnemies = w.sim_max_enemies();
    this.maxCoins = w.sim_max_coins();
    this.snapSize = w.sim_snapshot_size();
    this.snapPtr = w.sim_alloc(this.snapSize);
    this.terrainPtr = w.sim_alloc(this.levelW * this.levelH);
  }

  static async load(url: string): Promise<Sim> {
    // instantiateStreaming needs the right MIME type; fall back for hosts that
    // serve the bundle from a service-worker VFS with a generic content type,
    // which is exactly how a published Product is delivered.
    let instance: WebAssembly.Instance;
    try {
      ({ instance } = await WebAssembly.instantiateStreaming(fetch(url), {}));
    } catch {
      const bytes = await (await fetch(url)).arrayBuffer();
      ({ instance } = await WebAssembly.instantiate(bytes, {}));
    }

    const w = instance.exports as unknown as SimExports;
    const abi = w.sim_abi_version();
    if (abi !== ABI_VERSION) {
      throw new Error(`sim.wasm ABI ${abi}, expected ${ABI_VERSION} — rebuild it`);
    }
    return new Sim(w);
  }

  /** Begin a run on `seed`, generating that seed's level. */
  start(seed: bigint): Uint8Array {
    this.dispose();
    this.handle = this.w.sim_create(seed);
    if (!this.handle) throw new Error("sim_create failed");

    const n = this.w.sim_terrain(this.handle, this.terrainPtr, this.levelW * this.levelH);
    if (n < 0) throw new Error(`sim_terrain status ${n}`);
    // Copied out: linear memory can be detached when the wasm heap grows.
    return new Uint8Array(this.w.memory.buffer).slice(this.terrainPtr, this.terrainPtr + n);
  }

  /** Advance exactly one tick. Returns true once the run is over. */
  step(buttons: number): boolean {
    const r = this.w.sim_step_one(this.handle, buttons);
    if (r < 0) throw new Error(`sim_step_one status ${r}`);
    return r === 1;
  }

  read(): Snapshot {
    const n = this.w.sim_snapshot(this.handle, this.snapPtr, this.snapSize);
    if (n < 0) throw new Error(`sim_snapshot status ${n}`);

    const d = new DataView(this.w.memory.buffer);
    const p = this.snapPtr;

    const snap: Snapshot = {
      tick: d.getUint32(p, true),
      x: d.getInt32(p + 4, true) / FX,
      y: d.getInt32(p + 8, true) / FX,
      vx: d.getInt32(p + 12, true) / FX,
      vy: d.getInt32(p + 16, true) / FX,
      onGround: d.getUint8(p + 20) !== 0,
      facing: d.getInt8(p + 21),
      lives: d.getUint8(p + 22),
      over: d.getUint8(p + 23) !== 0,
      won: d.getUint8(p + 24) !== 0,
      invuln: d.getUint8(p + 25) !== 0,
      coins: d.getUint32(p + 28, true),
      score: d.getBigUint64(p + 32, true),
      maxTx: d.getInt32(p + 40, true),
      enemies: [],
      coinsOnField: [],
    };

    let off = p + 48;
    for (let i = 0; i < this.maxEnemies; i++, off += 12) {
      if (d.getUint8(off + 8) === 0) continue;
      snap.enemies.push({ x: d.getInt32(off, true) / FX, y: d.getInt32(off + 4, true) / FX });
    }
    for (let i = 0; i < this.maxCoins; i++, off += 12) {
      if (d.getUint8(off + 8) === 0) continue;
      snap.coinsOnField.push({ x: d.getInt32(off, true) / FX, y: d.getInt32(off + 4, true) / FX });
    }
    return snap;
  }

  dispose(): void {
    if (this.handle) {
      this.w.sim_destroy(this.handle);
      this.handle = 0;
    }
  }
}
