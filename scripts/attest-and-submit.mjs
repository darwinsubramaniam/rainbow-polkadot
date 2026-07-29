#!/usr/bin/env node
// End-to-end: ask the enclave to attest a run, then land it on-chain.
//
//   node scripts/attest-and-submit.mjs --verifier https://<tunnel> --player 0x…
//
// What this proves, and why each step is here:
//
//   1. The enclave's advertised key matches the key Acurast published ON-CHAIN
//      for that deployment. This is the whole trust story — the verifier address
//      is read from chain state, not taken from whatever the enclave claims.
//   2. The enclave replays the input log itself and returns a score we never
//      supplied. No claimed score is sent, so none can be believed.
//   3. `signer_sign` returns 64 bytes with no recovery id (E0.3), so `v` is
//      reconstructed here by trying both and keeping the one that recovers to
//      the known verifier address.
//   4. The contract accepts it.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { execFileSync } from "node:child_process";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const VERIFIER_URL = arg("verifier");
const PLAYER = arg("player", "0x00000000000000000000000000000000000000A1");
const K = Number(arg("k", "3"));
const CONTRACT = arg("contract", "0x9cc62a70E0d2ed75432C3d9c1F997a122eE976a0");
const RPC = arg("rpc", "https://paseo-assethub-rpc.laissez-faire.trade");
const EXPECTED_VERIFIER = arg("expect-verifier", "").toLowerCase();

if (!VERIFIER_URL) {
  console.error("usage: --verifier https://<tunnel> [--player 0x…] [--k N]");
  process.exit(1);
}

const addressOf = (pub) =>
  "0x" + bytesToHex(keccak_256(secp256k1.Point.fromHex(pub.replace(/^0x/, "")).toBytes(false).slice(1)).slice(-20));

const cast = (...args) =>
  execFileSync("cast", args, {encoding: "utf8", env: process.env}).trim();

// --- 1. identity -----------------------------------------------------------
const id = await (await fetch(`${VERIFIER_URL}/identity`)).json();
const encAddr = addressOf(id.secp256k1);
console.log(`enclave secp256k1 : ${id.secp256k1}`);
console.log(`enclave address   : ${encAddr}`);
console.log(`enclave rulesHash : ${id.rulesHash}`);

if (EXPECTED_VERIFIER && encAddr.toLowerCase() !== EXPECTED_VERIFIER) {
  console.error(`\nMISMATCH: on-chain verifier is ${EXPECTED_VERIFIER}`);
  console.error("The enclave is not the key the contract trusts. Stopping.");
  process.exit(1);
}

const onChainRules = cast("call", CONTRACT, "gameRules(uint64)(bytes32)", String(id.gameId), "--rpc-url", RPC);
if (onChainRules.toLowerCase() !== id.rulesHash.toLowerCase()) {
  console.error(`\nMISMATCH: contract rulesHash ${onChainRules} != enclave ${id.rulesHash}`);
  console.error("The enclave is running a different simulation than the board is pinned to.");
  process.exit(1);
}
console.log(`rulesHash matches on-chain registration ✓`);

// --- 2. attest -------------------------------------------------------------
const epoch = Number(cast("call", CONTRACT, "currentEpoch()(uint64)", "--rpc-url", RPC).split(/\s/)[0]);

// A plausible run: alternating held directions. The enclave replays this and
// computes the score; we never tell it what the score was.
const inputLog = [];
for (let i = 0; i < 40; i++) inputLog.push([i * 37, i % 3 === 0 ? 0 : (i % 2 ? 1 : 2)]);

console.log(`\nrequesting attestation (epoch ${epoch}, k ${K}, ${inputLog.length} log entries)…`);
const res = await fetch(`${VERIFIER_URL}/attest`, {
  method: "POST",
  headers: {"content-type": "application/json"},
  body: JSON.stringify({player: PLAYER, epoch, k: K, inputLog}),
});
const att = await res.json();
if (att.error) {
  console.error("enclave refused:", att.error);
  process.exit(1);
}
console.log(`score (computed BY the enclave): ${att.claim.score}  over ${att.ticks} ticks`);
console.log(`digest    : ${att.digest}`);
console.log(`signature : ${att.signature} (${(att.signature.length - 2) / 2} bytes)`);

// --- 3. reconstruct v ------------------------------------------------------
const rs = hexToBytes(att.signature.replace(/^0x/, ""));
if (rs.length !== 64) {
  console.error(`expected 64-byte r||s, got ${rs.length}`);
  process.exit(1);
}
let v = null;
for (const rec of [0, 1]) {
  const packed = new Uint8Array(65);
  packed[0] = rec;
  packed.set(rs, 1);
  try {
    const pub = secp256k1.recoverPublicKey(packed, hexToBytes(att.digest.replace(/^0x/, "")), {prehash: false});
    if (addressOf(bytesToHex(pub)).toLowerCase() === encAddr.toLowerCase()) {
      v = 27 + rec;
      break;
    }
  } catch {}
}
if (v === null) {
  console.error("could not reconstruct a recovery id yielding the enclave address");
  process.exit(1);
}
console.log(`recovered v: ${v}`);
const sig65 = "0x" + bytesToHex(rs) + v.toString(16).padStart(2, "0");

// --- 4. submit -------------------------------------------------------------
const c = att.claim;
const tuple = `(${c.player},${c.gameId},${c.score},${c.epoch},${c.k},${c.rulesHash},${c.expiry})`;
const data = cast(
  "calldata",
  "submit((address,uint64,uint64,uint64,uint32,bytes32,uint64),bytes)",
  tuple,
  sig65,
);
console.log("\nsubmitting…");
execFileSync("node", [new URL("./revive-call.mjs", import.meta.url).pathname, "--to", CONTRACT, "--data", data], {
  stdio: "inherit",
  env: process.env,
});

const best = cast("call", CONTRACT, "best(uint64,address)(uint64)", String(c.gameId), c.player, "--rpc-url", RPC);
console.log(`\nbest(${c.gameId}, ${c.player}) = ${best}`);
console.log(best.split(/\s/)[0] === String(c.score) ? "MATCHES the attested score ✓" : "MISMATCH");
