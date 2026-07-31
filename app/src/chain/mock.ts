// A simulated enclave, for development only.
//
// This is a second implementation of `e2e/acurast-verifier/app/verifier.mjs`
// that runs inside the browser tab: the same session id, the same seed
// derivation, a replay against the same sim.wasm, and the same EIP-712 digest.
// What differs is where the key lives — in the constant below, in the open,
// rather than inside a processor's secure element.
//
// That difference is the whole point and must not be blurred. The simulator
// exists so the play-and-attest loop can be exercised with no Acurast job
// deployed and no tunnel hostname to paste. It is not a verifier: its key is
// public, so anyone could produce the same "attestation" for any score, and the
// contract's `isVerifier` set does not contain it. `Play` never submits one.
//
// It used to sit behind `import.meta.env.DEV` and stay out of a build entirely.
// It no longer does — `Play` explains why — so this file *does* ship, as its own
// chunk behind a dynamic `import()`. It is downloaded only when a player turns
// the simulator on, which keeps it off the critical path and off the Bulletin
// byte quota for everyone who never asks for it.
//
// What keeps it harmless is not absence but the key: the one below is printed in
// this repository, so the contract's `isVerifier` set does not contain it and
// `Play` never submits what it signs.

// @noble v2 publishes explicit ".js" subpath exports; the extensionless form
// does not resolve.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import type { LogEntry } from "../game/engine";
import { EPOCH_SECONDS, MAX_ATTEMPTS } from "./attempts";
import type { Attestation, Enclave, ScoreClaim, Session } from "./enclave";
import { CONTRACT } from "./leaderboard";

/** Mirrors the deployment the real enclave is configured for (docs/deployment-devnet.md). */
const CHAIN_ID = 420420417n;
const GAME_ID = 1;
const TTL_SECONDS = 86_400;

/**
 * The simulated enclave's signing key.
 *
 * Derived from a constant string and written down here deliberately: a key
 * anyone can recompute cannot be mistaken for one that proves something. It is
 * fixed rather than random so a page reload keeps issuing the same seed for the
 * same session, which is how the real one behaves and what makes a replay
 * reproducible across a dev session.
 */
const DEV_KEY = keccak_256(new TextEncoder().encode("rainbow-simulated-enclave-v1"));

// -- hex / ABI words --------------------------------------------------------
//
// Every EIP-712 member here is a static 32-byte word, so this is all the ABI
// encoding the digest needs.

const bytes = (hex: string) => hexToBytes(hex.replace(/^0x/, "").toLowerCase());

/** Left-pad a number to a 32-byte word. */
function word(v: bigint | number): Uint8Array {
  const out = new Uint8Array(32);
  let x = BigInt(v);
  for (let i = 31; i >= 0 && x > 0n; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/** Left-pad a 20-byte address into a 32-byte word. */
function addrWord(a: string): Uint8Array {
  const out = new Uint8Array(32);
  out.set(bytes(a).slice(-20), 12);
  return out;
}

function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

// -- the simulation ---------------------------------------------------------

// Served from public/, resolved against the document — the same URL the game
// loads. `BASE_URL` is "./" here.
const WASM_URL = `${import.meta.env.BASE_URL}sim.wasm`;

const ABI_VERSION = 2;

/**
 * The verification half of sim.wasm's ABI.
 *
 * `sim/sim.ts` binds the interactive half — create, step, snapshot — because
 * that is all the player's game needs. `sim_verify` replays a whole log in one
 * call, which is what a verifier wants and what the real enclave uses.
 */
interface VerifyExports {
  memory: WebAssembly.Memory;
  sim_abi_version(): number;
  sim_alloc(len: number): number;
  sim_dealloc(ptr: number, len: number): void;
  sim_verify(seed: bigint, logPtr: number, logLen: number, out: number): number;
}

interface Replayer {
  w: VerifyExports;
  /** keccak256 of the wasm actually loaded — not a configured constant. */
  rulesHash: string;
}

let loading: Promise<Replayer> | null = null;

/**
 * Load a second, independent wasm instance.
 *
 * Independent on purpose: the enclave replays with no access to the state the
 * player's own run left behind, and a simulator that shared the game's `Sim`
 * handle would be quietly checking the run against itself.
 */
function load(): Promise<Replayer> {
  if (loading) return loading;

  const started = (async (): Promise<Replayer> => {
    const raw = new Uint8Array(await (await fetch(WASM_URL)).arrayBuffer());
    const { instance } = await WebAssembly.instantiate(raw, {});
    const w = instance.exports as unknown as VerifyExports;

    const abi = w.sim_abi_version();
    if (abi !== ABI_VERSION) throw new Error(`sim.wasm ABI ${abi}, expected ${ABI_VERSION}`);

    return { w, rulesHash: "0x" + bytesToHex(keccak_256(raw)) };
  })();

  loading = started;
  // A failed fetch must not be cached as the permanent answer, or every later
  // attempt would fail with the message from the first.
  started.catch(() => {
    if (loading === started) loading = null;
  });
  return started;
}

interface Replayed {
  score: bigint;
  stateHash: bigint;
  ticks: number;
}

function replay({ w }: Replayer, seed: bigint, log: LogEntry[]): Replayed {
  const packed = new Uint8Array(log.length * 8);
  const dv = new DataView(packed.buffer);
  log.forEach(([tick, buttons], i) => {
    dv.setUint32(i * 8, tick, true);
    dv.setUint32(i * 8 + 4, buttons, true);
  });

  const logPtr = log.length ? w.sim_alloc(packed.length) : 0;
  const outPtr = w.sim_alloc(24);
  try {
    if (logPtr) new Uint8Array(w.memory.buffer).set(packed, logPtr);

    const status = w.sim_verify(seed, logPtr, log.length, outPtr);
    if (status < 0) throw new Error(`sim rejected the log (status ${status})`);

    // Read the view only after the call: allocation inside wasm can grow the
    // heap, which detaches any buffer taken beforehand.
    const out = new DataView(w.memory.buffer);
    return {
      score: out.getBigUint64(outPtr, true),
      stateHash: out.getBigUint64(outPtr + 8, true),
      ticks: out.getUint32(outPtr + 16, true),
    };
  } finally {
    w.sim_dealloc(outPtr, 24);
    if (logPtr) w.sim_dealloc(logPtr, packed.length);
  }
}

// -- sessions and seeds -----------------------------------------------------

/** Must match Leaderboard.sessionIdFor, and the real enclave, exactly. */
const sessionIdFor = (player: string, epoch: number, k: number) =>
  "0x" + bytesToHex(keccak_256(cat(addrWord(player), word(epoch), word(k))));

/** RFC 6979, so the same digest always yields the same signature — as on the processor. */
const sign = (digest: Uint8Array) => secp256k1.sign(digest, DEV_KEY, { prehash: false });

/**
 * The seed for a session.
 *
 * Structurally what the enclave does: hash a domain-separated preimage, sign it
 * with the attestation key, and take the first eight bytes of the hash of that
 * signature. Deterministic signing is what makes it a PRF rather than a coin
 * flip. Here it is a PRF the player can evaluate offline, since they have the
 * key — one more reason this is a development aid and not a verifier.
 */
function deriveSeed(sessionId: string): bigint {
  const material = keccak_256(cat(utf8("rainbow-seed-v1"), bytes(sessionId)));
  const h = keccak_256(sign(material));
  return new DataView(h.buffer, h.byteOffset, h.byteLength).getBigUint64(0, true);
}

// -- EIP-712 ----------------------------------------------------------------

const TYPEHASH = keccak_256(
  utf8("Score(address player,uint64 gameId,uint64 score,uint64 epoch,uint32 k,bytes32 rulesHash,uint64 expiry)"),
);

const DOMAIN_SEPARATOR = keccak_256(
  cat(
    keccak_256(utf8("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
    keccak_256(utf8("RainbowLeaderboard")),
    keccak_256(utf8("1")),
    word(CHAIN_ID),
    addrWord(CONTRACT),
  ),
);

function digestOf(c: ScoreClaim): Uint8Array {
  const structHash = keccak_256(
    cat(
      TYPEHASH,
      addrWord(c.player),
      word(c.gameId),
      word(BigInt(c.score)),
      word(c.epoch),
      word(c.k),
      bytes(c.rulesHash),
      word(c.expiry),
    ),
  );
  return keccak_256(cat(Uint8Array.from([0x19, 0x01]), DOMAIN_SEPARATOR, structHash));
}

// -- the enclave ------------------------------------------------------------

/** The same request validation the real one performs before doing any work. */
function check(player: string, k: number): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(player)) throw new Error("bad player address");
  if (!(k >= 0 && k < MAX_ATTEMPTS)) throw new Error("session index out of range");
}

const now = () => Math.floor(Date.now() / 1000);
const epochNow = () => Math.floor(now() / EPOCH_SECONDS);

/** An `Enclave` that answers from this tab. Development only — see the file header. */
export function simulatedEnclave(): Enclave {
  return {
    async identity() {
      const { rulesHash } = await load();
      return {
        secp256k1: "0x" + bytesToHex(secp256k1.getPublicKey(DEV_KEY, true)),
        rulesHash,
        contract: CONTRACT.toLowerCase(),
        chainId: Number(CHAIN_ID),
        gameId: GAME_ID,
      };
    },

    async openSession(player: string, k: number): Promise<Session> {
      const { rulesHash } = await load();
      check(player, k);

      // Current epoch only, as upstream: issuing seeds for past epochs would
      // let a player harvest and sample levels they never have to play.
      const epoch = epochNow();
      const sessionId = sessionIdFor(player, epoch, k);

      return {
        player,
        epoch,
        k,
        sessionId,
        seed: deriveSeed(sessionId).toString(),
        gameId: GAME_ID,
        rulesHash,
        maxSessionsPerEpoch: MAX_ATTEMPTS,
        secondsLeftInEpoch: (epoch + 1) * EPOCH_SECONDS - now(),
      };
    },

    async attest(player: string, epoch: number, k: number, inputLog: LogEntry[]): Promise<Attestation> {
      const replayer = await load();
      check(player, k);
      if (epoch > epochNow()) throw new Error("epoch in the future");

      const sessionId = sessionIdFor(player, epoch, k);
      const out = replay(replayer, deriveSeed(sessionId), inputLog);

      // The score is whatever the replay produced. As upstream, no claimed
      // value is accepted, so there is nothing here to be fooled by.
      const claim: ScoreClaim = {
        player,
        gameId: GAME_ID,
        score: out.score.toString(),
        epoch,
        k,
        rulesHash: replayer.rulesHash,
        expiry: now() + TTL_SECONDS,
      };

      const digest = digestOf(claim);
      return {
        claim,
        sessionId,
        digest: "0x" + bytesToHex(digest),
        // 64 bytes, r‖s — the shape `signer_sign` returns, so the caller's
        // recovery-id search is exercised rather than bypassed.
        signature: "0x" + bytesToHex(sign(digest)),
        ticks: out.ticks,
        stateHash: "0x" + out.stateHash.toString(16).padStart(16, "0"),
      };
    },
  };
}
