/**
 * Your own runs, kept on this device.
 *
 * The contract stores exactly one number per player — their best — because that
 * is all a leaderboard needs and every extra slot is storage someone pays for.
 * So a personal *top ten* cannot come from chain state: there is nothing there
 * to page through.
 *
 * It could in principle be rebuilt from `NewBest` logs, since every improvement
 * emits one. Not on this chain: submissions arrive as Substrate `Revive.call`
 * extrinsics and the Ethereum-RPC view reports those blocks as having no
 * transactions, so `eth_getLogs` over the contract's whole history comes back
 * empty while `eth_call` against the same address answers correctly. No indexer
 * covers the chain either.
 *
 * What is left is honest and cheap: remember the runs this browser attested. The
 * *scores* are not local claims — each one was computed and signed inside the
 * enclave, which is the only authority the contract itself recognises — but the
 * *list* is, and the UI labels it as such. Clear the browser and it is gone;
 * your best survives, on-chain, because that is the part that matters.
 */

/** Newest-first cap. Ten are shown; the surplus is what makes "best 10" mean something. */
export const HISTORY_CAP = 60;

export interface RunRecord {
  /** The H160 the score was credited to. A stored list can outlive an account switch. */
  player: string;
  /** u64 as a decimal string — a score does not survive JSON's number type. */
  score: string;
  ticks: number;
  epoch: number;
  k: number;
  /** Wall clock ms, for display only. Never used to decide anything. */
  at: number;
  /** The enclave's number matched this device's. A mismatch is worth keeping visible. */
  agreed: boolean;
  /** Accepted on-chain, which is also what consumed the session. */
  landed: boolean;
}

/** Same session slot: one epoch, one `k`, one player. */
const sameSlot = (a: RunRecord, b: { player: string; epoch: number; k: number }) =>
  a.player === b.player && a.epoch === b.epoch && a.k === b.k;

const higher = (a: RunRecord, b: RunRecord) => (BigInt(a.score) >= BigInt(b.score) ? a : b);

/**
 * Add a run.
 *
 * One row per session slot, not per attestation. A held session can be replayed
 * and attested repeatedly until one submission lands, and each of those is a
 * genuinely different run of the same level — but only one of them can ever
 * reach the board, so listing all of them would let a single slot occupy the
 * personal top ten several times over. The slot keeps its highest score.
 *
 * Pure, and returns a new array: the caller persists whatever it gets back.
 */
export function remember(list: readonly RunRecord[], run: RunRecord): RunRecord[] {
  const previous = list.find((r) => sameSlot(r, run));
  const merged = previous
    ? // `landed` is sticky: a slot that landed stays landed even if a later
      // replay of it scored lower and was never submitted.
      { ...higher(previous, run), landed: previous.landed || run.landed }
    : run;

  return [merged, ...list.filter((r) => !sameSlot(r, run))].slice(0, HISTORY_CAP);
}

/** Mark a slot as landed on-chain. */
export function markLanded(
  list: readonly RunRecord[],
  at: { player: string; epoch: number; k: number },
): RunRecord[] {
  return list.map((r) => (sameSlot(r, at) ? { ...r, landed: true } : r));
}

/**
 * A player's best runs, highest first.
 *
 * Filtered by player, because the list is per browser and a browser can hold
 * more than one account — showing another account's runs under your address
 * would be a lie about who earned them.
 */
export function personalBest(list: readonly RunRecord[], player: string | null, top = 10): RunRecord[] {
  if (!player) return [];
  return list
    .filter((r) => r.player.toLowerCase() === player.toLowerCase())
    .sort((a, b) => {
      const x = BigInt(a.score);
      const y = BigInt(b.score);
      // Newest first among equal scores: the tie-break the player can actually
      // see a reason for.
      return x === y ? b.at - a.at : x > y ? -1 : 1;
    })
    .slice(0, top);
}
