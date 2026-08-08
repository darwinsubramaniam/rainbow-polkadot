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
  /**
   * True once a submit was accepted on-chain, which consumes the session.
   *
   * Now the only way a slot finishes, and that is a simplification the contract
   * paid for. A record used to carry an `abandoned` flag beside this one,
   * because a submit that did not beat the player's own best reverted and
   * consumed nothing: a player who could not improve was pinned to one level
   * for the rest of the epoch, every run reverting `NotAnImprovement` and the
   * same seed coming back. Skipping was the escape hatch.
   *
   * The contract now records every attested run and consumes the session on the
   * first submission whatever it scored, so there is nothing left to walk away
   * from — play always advances, and the escape hatch has no dead end to escape.
   * Records written by earlier builds may still carry `abandoned`; it is ignored
   * rather than migrated, and such a slot simply reads as unspent, which is what
   * it always was on-chain.
   */
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

  // An unspent slot is replayable. `spent` is the local belief, and the chain is
  // the authority — see {@link reconcileSpent}, which is what keeps the two from
  // drifting apart and stranding a player on a slot that can never land again.
  if (held && !held.spent) {
    return { mode: "replay", k: held.k, seed: held.seed, epoch: held.epoch };
  }

  const k = held ? held.k + 1 : 0;
  return k >= MAX_ATTEMPTS ? { mode: "exhausted" } : { mode: "mint", k };
}

/**
 * Fold what the chain says about a slot back into the stored record.
 *
 * `spent` is a local belief, written when a submit is *observed* to succeed, and
 * there are two ordinary ways for it to be wrong — both of which strand the
 * player on a slot that can never land again:
 *
 *  1. **The submit landed but the app never saw it.** The host's transport can
 *     accept a transaction and then never answer, which is precisely why
 *     `submitAttestation` has a timeout at all. The transaction is in a block;
 *     this browser simply does not know.
 *  2. **The slot was consumed out of band** — from another device, or from
 *     `scripts/attest-and-submit.mjs` after a hung submit was rescued by hand.
 *
 * In both cases `nextAttempt` keeps offering a replay of a session the contract
 * has already burned, and every submission of it reverts `SessionAlreadyUsed`
 * for the rest of the epoch. That is the same hour-long dead end the removed
 * `abandoned` flag existed to escape — reached by a different door, since the
 * contract's improvement check is no longer the thing closing it.
 *
 * Reconciling is better than a Skip button, which is what this replaces: the
 * player never has to notice, and the local record converges on the truth rather
 * than acquiring a second way to be wrong. It is also strictly cheap — one view
 * call, no account, no gas.
 *
 * Deliberately one-directional. A slot the chain reports as unspent is left
 * alone rather than being un-spent locally: `spent` is only ever set by evidence
 * that a submission landed, and a read racing a transaction still in the pool
 * would otherwise hand the player back a seed they have already used.
 */
export function reconcileSpent(record: SessionRecord, spentOnChain: boolean): SessionRecord {
  if (!spentOnChain || record.spent) return record;
  return { ...record, spent: true };
}
