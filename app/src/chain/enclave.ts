// Talking to the Acurast verifier enclave.
//
// Called straight from the browser, with no relay in between. E0.1 measured a
// Product's sandbox permitting egress to an arbitrary HTTPS origin, and the
// verifier answers with `access-control-allow-origin: *`, so the tunnel is
// reachable from inside the published app.
//
// Nothing here is trusted. The enclave is asked for a seed and for an
// attestation; the score in that attestation is one the enclave computed
// itself, and the contract checks the signature over it. A hostile response can
// waste the player's time but cannot mint a score.

import type { LogEntry } from "../game/engine";

export interface Session {
  player: string;
  epoch: number;
  k: number;
  sessionId: string;
  /** u64 as a decimal string — it does not survive JSON's number type. */
  seed: string;
  gameId: number;
  rulesHash: string;
  maxSessionsPerEpoch: number;
  secondsLeftInEpoch: number;
}

export interface ScoreClaim {
  player: string;
  gameId: number;
  score: string;
  epoch: number;
  k: number;
  rulesHash: string;
  expiry: number;
}

export interface Attestation {
  claim: ScoreClaim;
  sessionId: string;
  digest: string;
  /** 64 bytes, r‖s — signer_sign returns no recovery id. */
  signature: string;
  ticks: number;
  stateHash: string;
}

export interface Identity {
  secp256k1: string;
  rulesHash: string;
  contract: string;
  chainId: number;
  gameId: number;
}

const TIMEOUT_MS = 30_000;

async function call<T>(base: string, path: string, body?: unknown): Promise<T> {
  const url = base.replace(/\/$/, "") + path;

  // A tunnelled enclave on a phone can stall rather than refuse. Without a
  // deadline the UI would sit on a spinner indefinitely.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const json = (await res.json()) as T & { error?: string };
    if (json.error) throw new Error(json.error);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return json;
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`enclave did not answer within ${TIMEOUT_MS / 1000}s`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export const identity = (base: string) => call<Identity>(base, "/identity");

/**
 * Claim a session and receive its seed.
 *
 * The level is generated from this seed, so the client cannot draw anything
 * before this call returns. The enclave only issues seeds for the current
 * epoch, which is what caps a player at `maxSessionsPerEpoch` per hour.
 */
export const openSession = (base: string, player: string, k: number) =>
  call<Session>(base, "/session", { player, k });

/**
 * Ask the enclave to recompute the run.
 *
 * Note what is absent: no score is sent. There is no field for one. The enclave
 * replays the log against the same sim.wasm and arrives at its own number.
 */
export const attest = (
  base: string,
  player: string,
  epoch: number,
  k: number,
  inputLog: LogEntry[],
) => call<Attestation>(base, "/attest", { player, epoch, k, inputLog });
