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

/**
 * Resolve BRIDGE_SOCKET to a connectable path.
 *
 * Acurast hands us an *abstract* socket name, which is a Linux-only concept
 * signalled by a leading NUL byte. macOS has no equivalent, so a name given as
 * a filesystem path is used as-is — that is the only way to exercise this file
 * on a developer machine, and it costs nothing in production, where the runtime
 * always supplies a bare abstract name.
 */
const socketPath = (name) => (name.startsWith("/") || name.startsWith(".") ? name : "\0" + name);

function rpc(method, params = [], timeout = 20000) {
  return new Promise((resolve) => {
    const name = process.env.BRIDGE_SOCKET;
    if (!name) return resolve({error: "BRIDGE_SOCKET unset"});
    const sock = net.connect({path: socketPath(name)});
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
if (sim.exports.sim_abi_version() !== 2) throw new Error("sim.wasm ABI mismatch");

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
 * **The player is deliberately not in the preimage.** It used to be — this took
 * `sessionId`, which is `keccak256(player, epoch, k)` — and that gave every
 * player their own private level for every slot. Two things were wrong with it,
 * and only the second was obvious.
 *
 * The first: a leaderboard that ranks scores earned on different levels ranks
 * the draw as much as the play. Measured over 20,000 seeds from this exact
 * `sim.wasm`, a level carries 17–56 coins and 0–17 enemies, so a *perfect* run
 * is worth between 5,100 and 11,000 points depending on nothing the player did.
 * The p5–p95 spread is 2,500 on a median of 7,700. Comparing those numbers to
 * each other was never meaningful.
 *
 * The second: it was not even sound as anti-grinding. `maxSessionsPerEpoch`
 * caps seeds per *address*, `/session` is unauthenticated and will derive for
 * any address you name, `sim.wasm` is published, and the contract credits the
 * `player` inside the signed claim rather than `msg.sender`. So the attack was:
 * mint a thousand addresses, pull twelve seeds each, generate all twelve
 * thousand levels locally, play the friendliest, and be credited to whichever
 * address drew it. Addresses are free; the cap bounded nothing.
 *
 * Keying on `(epoch, k)` alone fixes both. Everyone faces the same twelve levels
 * per hour, which makes the boards comparable and leaves an address-farmer with
 * nothing to shop for.
 *
 * ## What it costs, stated plainly
 *
 * Levels become public knowledge the moment anyone asks for one, and an input
 * log is now portable: a route another player found and published can be
 * replayed by anyone, attested, and submitted under their own address for the
 * same score. Under per-player seeds that log was meaningless to anyone else.
 *
 * This is the daily-puzzle trade and it is taken knowingly. Copying still spends
 * one of the copier's twelve slots, so it is not free, and an attested replay of
 * someone else's route is in any case indistinguishable from playing it well.
 * What is bought in exchange is a board where two scores mean the same thing.
 *
 * ## What has not changed
 *
 * `signer_sign` is deterministic (RFC 6979 — measured in E0.3) and its private
 * key never leaves the secure element, so this is still a PRF nobody can
 * evaluate offline. That no longer buys secrecy, since anyone may ask for any
 * `(epoch, k)`; it buys unforgeability — no client can invent a seed and have
 * the enclave replay against it.
 *
 * Note the corollary: the key is per-deployment, so a redeployed verifier serves
 * *different* levels for the same `(epoch, k)`. That was always true and was
 * invisible while seeds were per-player; under shared seeds it means two live
 * verifiers would disagree about what today's levels are. Use `reuseKeysFrom`
 * across redeployments if that matters.
 *
 * The prefix is bumped to `-v2` so the two schemes can never share a preimage,
 * and this reuses the attestation key as a PRF — the distinct prefix keeps it
 * disjoint from any EIP-712 digest, so it cannot be coerced into producing an
 * attestation, but a separate HD-derived key (signer_sign supports
 * derivationPath on secp256k1) would be cleaner.
 */
async function deriveSeed(epoch, k) {
  const material = keccak_256(
    cat(new TextEncoder().encode("rainbow-seed-v2"), word(epoch), word(k)),
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
  // The seed is the level, and the level is shared; `sessionId` still binds the
  // *slot* to this player, which is what the contract spends.
  const seed = await deriveSeed(e, k);

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
// Session issuance
// ---------------------------------------------------------------------------

/**
 * Hand out the seed for a session so the client can actually play it.
 *
 * The level is generated from the seed, so without this the player has nothing
 * to render.
 *
 * Since {@link deriveSeed} stopped keying on the player, a seed is no longer
 * anybody's secret: the twelve levels of an epoch are the same twelve for
 * everyone, and this endpoint hands them to whoever asks. That is a deliberate
 * property, not a leak — the whole point is that two scores on the board were
 * earned on the same level. The restrictions below are what remain, and what
 * they still buy:
 *
 *   - CURRENT EPOCH ONLY, still load-bearing but for a narrower reason. `attest`
 *     and the contract both accept any epoch <= current, because a run played at
 *     the end of one epoch may legitimately be submitted in the next. Issuing
 *     *seeds* on those terms would let anyone walk back through every past epoch
 *     and harvest levels to practise on before spending a slot. It no longer
 *     stops level *shopping* — everyone gets the same level whether they look
 *     first or not — but it keeps a slot a commitment rather than a preview.
 *
 *   - k < maxSessionsPerEpoch, matching the contract. A seed the contract would
 *     never accept a submission for is not worth deriving.
 *
 * The `player` argument is now used only to compute the returned `sessionId`,
 * which is what the *contract* spends; the seed ignores it. It is still
 * validated as an H160 so a caller cannot be handed a session identifier the
 * contract would never recognise.
 *
 * `deriveSeed` remains a signature under a key inside the secure element, so
 * nobody can compute a seed offline or invent one for the enclave to replay
 * against. What that buys is now unforgeability rather than secrecy.
 */
async function session({player, epoch, k}) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(player ?? "")) throw new Error("bad player address");

  const now = BigInt(Math.floor(Date.now() / 1000));
  const currentEpoch = now / EPOCH_SECONDS;
  const e = epoch === undefined || epoch === null ? currentEpoch : BigInt(epoch);

  if (e !== currentEpoch) {
    throw new Error(`seeds are issued for the current epoch only (${currentEpoch})`);
  }
  if (!(k >= 0 && k < MAX_SESSIONS_PER_EPOCH)) throw new Error("session index out of range");

  const sessionId = sessionIdFor(player, e, k);
  const seed = await deriveSeed(e, k);

  return {
    player,
    epoch: Number(e),
    k,
    sessionId,
    // Decimal string: a u64 seed does not survive JSON's number type intact.
    seed: seed.toString(),
    gameId: Number(GAME_ID),
    rulesHash: RULES_HASH,
    maxSessionsPerEpoch: Number(MAX_SESSIONS_PER_EPOCH),
    secondsLeftInEpoch: Number((currentEpoch + 1n) * EPOCH_SECONDS - now),
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
    const post = {"/attest": attest, "/session": session}[path];
    if (post && req.method === "POST") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", async () => {
        try {
          send(res, 200, await post(JSON.parse(body || "{}")));
        } catch (e) {
          send(res, 400, {error: e.message});
        }
      });
      return;
    }
    send(res, 404, {error: "try /health, /identity, POST /session, POST /attest"});
  } catch (e) {
    send(res, 500, {error: e.message});
  }
}).listen(PORT, "0.0.0.0", () => {
  console.log(`[verifier] listening on 0.0.0.0:${PORT}`);
  console.log(`[verifier] rulesHash ${RULES_HASH}`);
  console.log(`[verifier] contract  ${CONTRACT} chain ${CHAIN_ID}`);
});
