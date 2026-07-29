#!/usr/bin/env node
// Third arm of the determinism harness (experiment E0.2).
//
// The Rust harness compares `sim` linked natively against `sim.wasm` run
// through `wasmi`. Both of those are Rust executing Rust. This script runs the
// *same bytes* through V8's WebAssembly implementation instead — a completely
// independent engine, and the one the browser client will actually use.
//
// That makes this the arm that matters: wasmi is what the TEE verifier runs and
// V8 is what the player runs, so this pair is precisely the "false cheat flag
// on an honest player" risk. Everything else is a proxy for it.
//
//   node harness/run-node.mjs [--wasm PATH] [--golden PATH]

import { readFile } from "node:fs/promises";
import { argv, exit } from "node:process";

const DEFAULT_WASM = "target/wasm32-unknown-unknown/release/sim_wasm.wasm";
const DEFAULT_GOLDEN = "harness/golden.json";

const VERIFY_OUT_SIZE = 24;
const LOG_ENTRY_SIZE = 8;

function flag(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const REJECT = {
  "-1": "LogTooLong",
  "-2": "NonMonotonicTick",
  "-3": "TickBeyondLimit",
  "-4": "InvalidButtons",
  "-5": "BadArgument",
  "-6": "TraceCapacity",
};

class Sim {
  constructor(instance) {
    this.e = instance.exports;
    this.mem = () => new DataView(this.e.memory.buffer);
    this.bytes = () => new Uint8Array(this.e.memory.buffer);
  }

  static async load(path) {
    const wasm = await readFile(path);
    const { instance } = await WebAssembly.instantiate(wasm, {});
    const sim = new Sim(instance);

    const abi = sim.e.sim_abi_version();
    if (abi !== 1) throw new Error(`sim.wasm ABI version ${abi}, expected 1`);
    return sim;
  }

  writeLog(log) {
    const len = log.length;
    if (len === 0) return { ptr: 0, bytes: 0 };
    const bytes = len * LOG_ENTRY_SIZE;
    const ptr = this.e.sim_alloc(bytes);
    if (ptr === 0) throw new Error(`sim_alloc(${bytes}) returned null`);
    const dv = this.mem();
    for (let i = 0; i < len; i++) {
      const [tick, buttons] = log[i];
      dv.setUint32(ptr + i * LOG_ENTRY_SIZE, tick, true);
      dv.setUint32(ptr + i * LOG_ENTRY_SIZE + 4, buttons, true);
    }
    return { ptr, bytes };
  }

  verify(seed, log) {
    const { ptr, bytes } = this.writeLog(log);
    const out = this.e.sim_alloc(VERIFY_OUT_SIZE);
    try {
      const status = this.e.sim_verify(seed, ptr, log.length, out);
      if (status < 0) return { rejected: REJECT[String(status)] ?? `status ${status}` };
      // Re-read the DataView: a wasm allocation can grow memory and detach the
      // old ArrayBuffer, which would make a cached view throw.
      const dv = this.mem();
      return {
        score: dv.getBigUint64(out, true),
        stateHash: dv.getBigUint64(out + 8, true),
        ticks: dv.getUint32(out + 16, true),
        over: dv.getUint32(out + 20, true),
      };
    } finally {
      this.e.sim_dealloc(out, VERIFY_OUT_SIZE);
      if (ptr !== 0) this.e.sim_dealloc(ptr, bytes);
    }
  }
}

const hex = (b) => "0x" + b.toString(16).padStart(16, "0");

async function main() {
  const wasmPath = flag("--wasm", DEFAULT_WASM);
  const goldenPath = flag("--golden", DEFAULT_GOLDEN);

  const sim = await Sim.load(wasmPath);
  const golden = JSON.parse(await readFile(goldenPath, "utf8"));

  console.log("Rainbow determinism harness — V8 arm");
  console.log(`  engine : node ${process.version} (V8 ${process.versions.v8})`);
  console.log(`  wasm   : ${wasmPath}`);
  console.log(`  golden : ${goldenPath} (${golden.vectors.length} vectors)`);
  console.log();

  let failures = 0;
  let ticks = 0;

  for (const v of golden.vectors) {
    const got = sim.verify(BigInt(v.seed), v.log);

    if (got.rejected) {
      console.error(`DIVERGENCE seed=${v.seed}: V8 rejected a valid log (${got.rejected})`);
      failures++;
      continue;
    }
    if (got.score !== BigInt(v.score)) {
      console.error(`DIVERGENCE seed=${v.seed}: score wasmi ${v.score} != V8 ${got.score}`);
      failures++;
      continue;
    }
    if (hex(got.stateHash) !== v.stateHash) {
      console.error(
        `DIVERGENCE seed=${v.seed}: state hash wasmi ${v.stateHash} != V8 ${hex(got.stateHash)}`,
      );
      failures++;
      continue;
    }
    if (got.ticks !== v.ticks) {
      console.error(`DIVERGENCE seed=${v.seed}: run length wasmi ${v.ticks} != V8 ${got.ticks}`);
      failures++;
      continue;
    }
    ticks += got.ticks;
  }

  // The rejection paths must match too. A log V8 accepts but the enclave
  // refuses would strand an honest player with an unattestable run.
  const malformed = [
    ["non-monotonic", [[10, 1], [5, 0]]],
    ["duplicate tick", [[10, 1], [10, 0]]],
    ["invalid buttons", [[0, 0xff]]],
    ["undefined button bit", [[0, 0b100]]],
    ["tick beyond limit", [[sim.e.sim_max_ticks(), 1]]],
  ];
  for (const [name, log] of malformed) {
    const got = sim.verify(1n, log);
    if (!got.rejected) {
      console.error(`ACCEPTED a log that must be rejected: ${name}`);
      failures++;
    }
  }

  console.log(`${ticks} ticks re-verified across ${golden.vectors.length} vectors`);
  console.log(`rejection paths agree on ${malformed.length} malformed logs`);

  if (failures > 0) {
    console.error(`\nFAIL — ${failures} divergence(s) between wasmi and V8`);
    exit(1);
  }
  console.log("\nPASS — wasmi (enclave) and V8 (browser) agree on every vector");
}

main().catch((e) => {
  console.error(e);
  exit(1);
});
