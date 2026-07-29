#!/usr/bin/env node
// Rainbow score verifier — runs inside an Acurast processor's secure enclave.
//
// This is the component the whole design rests on. It replays the player's own
// input log against the pinned simulation, computes the score itself, and signs
// an EIP-712 attestation with a key that never leaves the processor's secure
// element. A signature proves who signed, not what is true — so the authority
// over score computation has to live here, where the player cannot reach it.
//
// Rules the enclave must never break (Goal.md §6):
//
//   DERIVED INSIDE       seed, sessionId, rulesHash, the score itself
//   ACCEPTED FROM CLIENT inputLog only
//   REJECTED             any client-supplied seed, starting state, score or digest
//
// In particular the EIP-712 digest is computed here, never accepted from the
// caller: signing a digest handed to us would let anyone get anything signed.

import net from "node:net";
import http from "node:http";
import fs from "node:fs";
import { keccak_256 } from "./keccak.mjs";

const PORT = Number(process.env.PORT ?? 3000);
const CONTRACT = (process.env.CONTRACT ?? "").toLowerCase();
const CHAIN_ID = BigInt(process.env.CHAIN_ID ?? "420420417");
const GAME_ID = BigInt(process.env.GAME_ID ?? "1");
const TTL_SECONDS = BigInt(process.env.ATTESTATION_TTL ?? "86400");
const EPOCH_SECONDS = BigInt(process.env.EPOCH_SECONDS ?? "3600");
const MAX_SESSIONS_PER_EPOCH = Number(process.env.MAX_SESSIONS_PER_EPOCH ?? "12");

// ---------------------------------------------------------------------------
// Host RPC — abstract Unix socket, JSON-RPC 2.0, ONE call per connection.
// ---------------------------------------------------------------------------

function rpc(method, params = [], timeout = 20000) {
  return new Promise((resolve) => {
    const name = process.env.BRIDGE_SOCKET;
    if (!name) return resolve({error: "BRIDGE_SOCKET unset"});
    const sock = net.connect({path: "\0" + name});
    let buf = "";
    const done = (v) => {
      try { sock.destroy(); } catch {}
      resolve(v);
    };
    sock.setTimeout(timeout, () => done({error: "rpc timeout"}));
    sock.on("error", (e) => done({error: `${e.code ?? e.name}: ${e.message}`}));
    sock.on("connect", () =>
      sock.write(JSON.stringify({jsonrpc: "2.0", method, params, id: "1"}) + "\n"));
    sock.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\n")) {
        try { done(JSON.parse(buf.trim())); } catch (e) { done({error: `bad json: ${e.message}`}); }
      }
    });
  });
}

const sign = async (hex) => {
  const r = await rpc("signer_sign", [{curve: "secp256k1", bytes: strip(hex)}]);
  return r?.result?.bytes ?? null;
};

// ---------------------------------------------------------------------------
// Hex / ABI helpers. All EIP-712 members here are static 32-byte words.
// ---------------------------------------------------------------------------

const strip = (h) => String(h ?? "").replace(/^0x/, "").toLowerCase();
const hexToBytes = (h) =>
  Uint8Array.from(strip(h).match(/../g)?.map((b) => parseInt(b, 16)) ?? []);
const bytesToHex = (b) => Buffer.from(b).toString("hex");

/** left-pad a bigint to a 32-byte word */
function word(v) {
  const out = new Uint8Array(32);
  let x = BigInt(v);
  for (let i = 31; i >= 0 && x > 0n; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}
/** left-pad 20-byte address into a 32-byte word */
function addrWord(a) {
  const out = new Uint8Array(32);
  out.set(hexToBytes(a).slice(-20), 12);
  return out;
}
const cat = (...arrs) => {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};

// ---------------------------------------------------------------------------
// The simulation — the source of truth for the score.
// ---------------------------------------------------------------------------

const wasmBytes = fs.readFileSync(new URL("./sim.wasm", import.meta.url));
const {instance: sim} = await WebAssembly.instantiate(wasmBytes, {});
const RULES_HASH = "0x" + bytesToHex(keccak_256(wasmBytes));

// The rules hash is computed from the artifact we are ACTUALLY executing, never
// configured. The enclave therefore cannot attest for a ruleset it is not running.
if (sim.exports.sim_abi_version() !== 1) throw new Error("sim.wasm ABI mismatch");

function replay(seed, log) {
  const bytes = new Uint8Array(log.length * 8);
  const dv = new DataView(bytes.buffer);
  log.forEach(([tick, buttons], i) => {
    dv.setUint32(i * 8, tick, true);
    dv.setUint32(i * 8 + 4, buttons, true);
  });

  const logPtr = log.length ? sim.exports.sim_alloc(bytes.length) : 0;
  const outPtr = sim.exports.sim_alloc(24);
  try {
    if (logPtr) new Uint8Array(sim.exports.memory.buffer).set(bytes, logPtr);
    const status = sim.exports.sim_verify(seed, logPtr, log.length, outPtr);
    if (status < 0) return {rejected: status};
    const out = new DataView(sim.exports.memory.buffer);
    return {
      score: out.getBigUint64(outPtr, true),
      stateHash: out.getBigUint64(outPtr + 8, true),
      ticks: out.getUint32(outPtr + 16, true),
      over: out.getUint32(outPtr + 20, true),
    };
  } finally {
    sim.exports.sim_dealloc(outPtr, 24);
    if (logPtr) sim.exports.sim_dealloc(logPtr, bytes.length);
  }
}

// ---------------------------------------------------------------------------
// Session + seed derivation
// ---------------------------------------------------------------------------

/** Must match Leaderboard.sessionIdFor exactly. */
const sessionIdFor = (player, epoch, k) =>
  "0x" + bytesToHex(keccak_256(cat(addrWord(player), word(epoch), word(k))));

/**
 * Derive a run's seed inside the enclave.
 *
 * `signer_sign` is deterministic (RFC 6979 — measured in E0.3) and its private
 * key never leaves the secure element, so signing a domain-separated message
 * acts as a PRF the player cannot evaluate offline. That is what stops seed
 * shopping: sessionId is public, but the seed it maps to is not.
 *
 * Caveat worth stating: this reuses the attestation key as a PRF. The distinct
 * "rainbow-seed-v1" prefix keeps the preimages disjoint from any EIP-712 digest,
 * so it cannot be coerced into producing an attestation — but a separate HD-derived
 * key (signer_sign supports derivationPath on secp256k1) would be cleaner.
 */
async function deriveSeed(sessionId) {
  const material = keccak_256(
    cat(new TextEncoder().encode("rainbow-seed-v1"), hexToBytes(sessionId)),
  );
  const sig = await sign(bytesToHex(material));
  if (!sig) throw new Error("seed derivation failed: signer_sign returned nothing");
  const dv = new DataView(keccak_256(hexToBytes(sig)).buffer);
  return dv.getBigUint64(0, true);
}

// ---------------------------------------------------------------------------
// EIP-712 — must match the deployed contract byte for byte
// ---------------------------------------------------------------------------

const TYPEHASH = keccak_256(
  new TextEncoder().encode(
    "Score(address player,uint64 gameId,uint64 score,uint64 epoch,uint32 k,bytes32 rulesHash,uint64 expiry)",
  ),
);
const DOMAIN_SEPARATOR = keccak_256(
  cat(
    keccak_256(new TextEncoder().encode(
      "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
    keccak_256(new TextEncoder().encode("RainbowLeaderboard")),
    keccak_256(new TextEncoder().encode("1")),
    word(CHAIN_ID),
    addrWord(CONTRACT),
  ),
);

function scoreDigest(c) {
  const structHash = keccak_256(cat(
    TYPEHASH,
    addrWord(c.player),
    word(c.gameId),
    word(c.score),
    word(c.epoch),
    word(c.k),
    hexToBytes(c.rulesHash),
    word(c.expiry),
  ));
  return keccak_256(cat(Uint8Array.from([0x19, 0x01]), DOMAIN_SEPARATOR, structHash));
}

// ---------------------------------------------------------------------------
// Attestation
// ---------------------------------------------------------------------------

async function attest({player, epoch, k, inputLog}) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(player ?? "")) throw new Error("bad player address");
  if (!Array.isArray(inputLog)) throw new Error("inputLog must be an array");

  // D1: only sessions the enclave could legitimately have issued. The contract
  // enforces this too; doing it here as well means a bad request never reaches
  // the expensive replay.
  const now = BigInt(Math.floor(Date.now() / 1000));
  const currentEpoch = now / EPOCH_SECONDS;
  const e = BigInt(epoch);
  if (e > currentEpoch) throw new Error("epoch in the future");
  if (!(k >= 0 && k < MAX_SESSIONS_PER_EPOCH)) throw new Error("session index out of range");

  const sessionId = sessionIdFor(player, e, k);
  const seed = await deriveSeed(sessionId);

  const result = replay(seed, inputLog);
  if (result.rejected !== undefined) {
    throw new Error(`sim rejected the log (status ${result.rejected})`);
  }

  // The score is what the replay produced. No claimed value is accepted, so
  // there is nothing here to compare against or be fooled by.
  const claim = {
    player,
    gameId: GAME_ID,
    score: result.score,
    epoch: e,
    k: BigInt(k),
    rulesHash: RULES_HASH,
    expiry: now + TTL_SECONDS,
  };

  const digest = scoreDigest(claim);
  const signature = await sign(bytesToHex(digest));
  if (!signature) throw new Error("signer_sign failed");

  return {
    claim: {
      player: claim.player,
      gameId: Number(claim.gameId),
      score: claim.score.toString(),
      epoch: Number(claim.epoch),
      k: Number(claim.k),
      rulesHash: claim.rulesHash,
      expiry: Number(claim.expiry),
    },
    sessionId,
    digest: "0x" + bytesToHex(digest),
    // 64 bytes, r||s — signer_sign returns no recovery id (E0.3). The caller
    // recovers v by trying both and keeping the one that yields `verifier`.
    signature: "0x" + strip(signature),
    ticks: result.ticks,
    stateHash: "0x" + result.stateHash.toString(16).padStart(16, "0"),
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

let identity = null;
async function getIdentity() {
  if (identity) return identity;
  const dep = await rpc("deployment_publicKeys");
  identity = {
    secp256k1: dep?.result?.publicKeys?.secp256k1 ?? null,
    rulesHash: RULES_HASH,
    contract: CONTRACT,
    chainId: Number(CHAIN_ID),
    gameId: Number(GAME_ID),
  };
  return identity;
}

const send = (res, code, obj) => {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
  });
  res.end(body);
};

http.createServer(async (req, res) => {
  try {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "OPTIONS") return send(res, 204, {});
    if (path === "/health") return send(res, 200, {ok: true, rulesHash: RULES_HASH});
    if (path === "/identity") return send(res, 200, await getIdentity());
    if (path === "/attest" && req.method === "POST") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", async () => {
        try {
          send(res, 200, await attest(JSON.parse(body || "{}")));
        } catch (e) {
          send(res, 400, {error: e.message});
        }
      });
      return;
    }
    send(res, 404, {error: "try /health, /identity, POST /attest"});
  } catch (e) {
    send(res, 500, {error: e.message});
  }
}).listen(PORT, "0.0.0.0", () => {
  console.log(`[verifier] listening on 0.0.0.0:${PORT}`);
  console.log(`[verifier] rulesHash ${RULES_HASH}`);
  console.log(`[verifier] contract  ${CONTRACT} chain ${CHAIN_ID}`);
});
