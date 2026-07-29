/**
 * Which run the player gets next.
 *
 * The contract gives each player `maxSessionsPerEpoch` session slots per epoch,
 * indexed by `k`, and consumes one only when a submit is accepted. That is an
 * anti-grinding rule: without it a player could keep asking for seeds, look at
 * each level, and play only the friendliest one.
 *
 * Expressing it here, as a pure function over the stored record, keeps the rule
 * in one readable place and out of the render path — and means the player never
 * has to think about `k` at all. They press Play; this decides whether that
 * means replaying the run they already hold or spending the next slot.
 */

/** Mirrors the contract's `maxSessionsPerEpoch`, a compile-time constant. */
export const MAX_ATTEMPTS = 12;

/** Mirrors the contract's `epochSeconds`, likewise fixed at deployment. */
export const EPOCH_SECONDS = 3600;

export interface SessionRecord {
  player: string;
  epoch: number;
  k: number;
  seed: string;
  /** True once a submit was accepted on-chain, which consumes the session. */
  spent: boolean;
}

export type Next =
  /** A held session is still unspent: replay it, no round trip, same level. */
  | { mode: "replay"; k: number; seed: string; epoch: number }
  /** Ask the enclave to open slot `k`. */
  | { mode: "mint"; k: number }
  /** Every slot this epoch is spent; nothing to do but wait for the reset. */
  | { mode: "exhausted" };

/**
 * The epoch the contract is *probably* in, from the local clock.
 *
 * A hint, never an authority. It only chooses which slot to ask for, and the
 * epoch the enclave answers with is what gets stored. Guessing wrong across an
 * hour boundary costs a skipped slot index, which is legal in any epoch.
 */
export const localEpoch = (now = Date.now()): number => Math.floor(now / 1000 / EPOCH_SECONDS);

/** Whole minutes until the current epoch rolls and the slots come back. */
export const minutesToReset = (now = Date.now()): number =>
  Math.ceil((EPOCH_SECONDS - ((now / 1000) % EPOCH_SECONDS)) / 60);

export function nextAttempt(record: SessionRecord | null, player: string | null, epoch: number): Next {
  // A record is only about *this* player in *this* epoch. Sessions are keyed by
  // `keccak256(player, epoch, k)`, so a record from another account or a past
  // hour says nothing about what is available now — the budget starts fresh.
  const held = record && player && record.player === player && record.epoch === epoch ? record : null;

  if (held && !held.spent) return { mode: "replay", k: held.k, seed: held.seed, epoch: held.epoch };

  const k = held ? held.k + 1 : 0;
  return k >= MAX_ATTEMPTS ? { mode: "exhausted" } : { mode: "mint", k };
}
