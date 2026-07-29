// Copy the compiled simulation into public/ before dev and build.
//
// The bundle must ship the *same bytes* the enclave runs, because `rulesHash` is
// `keccak256(sim.wasm)` and the contract is pinned to it. Copying at build time
// from cargo's output — rather than keeping a checked-in duplicate — means the
// app can never quietly ship a stale ruleset while the repo builds a newer one.
//
// The hash is printed on every run so a mismatch with the on-chain `gameRules`
// is visible in the build log rather than at the moment a player's score is
// rejected.

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(
  HERE, "..", "..", "target", "wasm32-unknown-unknown", "release", "sim_wasm.wasm",
);
const DEST_DIR = path.join(HERE, "..", "public");
const DEST = path.join(DEST_DIR, "sim.wasm");

let bytes;
try {
  bytes = readFileSync(SRC);
} catch {
  console.error(`\nsync-wasm: cannot read ${SRC}`);
  console.error("Build it first:\n  cargo build -p sim-wasm --release --target wasm32-unknown-unknown\n");
  process.exit(1);
}

mkdirSync(DEST_DIR, { recursive: true });
copyFileSync(SRC, DEST);

// keccak256 would need a dependency; sha256 is enough to detect drift here, and
// the authoritative keccak rulesHash is printed by the verifier at boot.
const sha = createHash("sha256").update(bytes).digest("hex");
console.log(`sync-wasm: ${bytes.length} bytes -> public/sim.wasm  (sha256 ${sha.slice(0, 16)}…)`);
