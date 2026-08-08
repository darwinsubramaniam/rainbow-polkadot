/**
 * Your own runs, kept on this device.
 *
 * The contract stores exactly one number per player — their best — because that
 * is all a leaderboard needs and every extra slot is storage someone pays for.
 * So a personal *top ten* cannot come from chain state: there is nothing there
 * to page through.
 *
 * It could in principle be rebuilt from `ScoreRecorded` logs, since every
 * accepted run emits one. Not on this chain: submissions arrive as `Revive.call`
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
  /**
   * The enclave signed for this score, rather than only this browser computing
   * it.
   *
   * Absent on records written before unattested runs were kept, and every one of
   * those was attested — so absent reads as true, and no migration is needed.
   * Read it through {@link isAttested} rather than directly.
   */
  attested?: boolean;
}

/** Whether the enclave signed for this score. Absent means yes; see {@link RunRecord.attested}. */
export const isAttested = (r: RunRecord): boolean => r.attested !== false;

/** Same session slot: one epoch, one `k`, one player. */
const sameSlot = (a: RunRecord, b: { player: string; epoch: number; k: number }) =>
  a.player === b.player && a.epoch === b.epoch && a.k === b.k;

/**
 * Which of two records for one slot to keep.
 *
 * An enclave-signed score outranks a device-only one whatever the numbers say,
 * and that ordering is not a preference — it is the point. When the two
 * disagree the enclave's is the only number the contract recognises, so letting
 * a higher local number win would store a score no chain would ever accept and
 * show it in a list that claims otherwise.
 *
 * Between two of the same kind, the higher score wins.
 */
const better = (a: RunRecord, b: RunRecord): RunRecord => {
  if (isAttested(a) !== isAttested(b)) return isAttested(a) ? a : b;
  return BigInt(a.score) >= BigInt(b.score) ? a : b;
};

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
      // replay of it scored lower and was never submitted. `attested` is not —
      // it describes the score that won, and rides along with it.
      { ...better(previous, run), landed: previous.landed || run.landed }
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

/** Where a number in the list came from, which is the whole of what it is worth. */
export type Source = "chain" | "enclave" | "device";

/** One line of the personal top ten, from whichever source produced it. */
export interface Standing {
  /** Stable across re-renders: the slot for a run, the score for the chain row. */
  key: string;
  /** u64 as a decimal string. */
  score: string;
  source: Source;
  landed: boolean;
  /** The enclave disagreed with this device. Never true for a row it did not judge. */
  disagreed: boolean;
  /** Null on the chain row, which has no run behind it on this device. */
  ticks: number | null;
  at: number | null;
}

/** Strongest claim first when scores tie: the chain outranks the enclave, which outranks this browser. */
const WEIGHT: Record<Source, number> = { chain: 0, enclave: 1, device: 2 };

const toStanding = (r: RunRecord): Standing => ({
  key: `run-${r.epoch}-${r.k}`,
  score: r.score,
  source: isAttested(r) ? "enclave" : "device",
  landed: r.landed,
  // A device-only run was never judged, so it cannot have disagreed — and
  // `agreed: false` on such a record means "no verdict", not "mismatch".
  disagreed: isAttested(r) && !r.agreed,
  ticks: r.ticks,
  at: r.at,
});

/**
 * The personal top ten, merged from both things that know a score.
 *
 * Two sources, and neither is complete on its own. The contract keeps exactly
 * one number per player — the best — and nothing else, so it cannot supply a
 * list. This browser keeps up to {@link HISTORY_CAP} runs, but only its own:
 * clear it, or land a score from a phone, and the number the chain holds is one
 * this device has never seen. Showing either alone means a panel that
 * contradicts the "on-chain best" printed directly above it.
 *
 * So both go in, each row says which it is, and the ten highest survive.
 *
 * The chain's row is dropped when a local run already accounts for it — same
 * score, and marked landed — because that is not two achievements, it is one
 * seen twice. Without that check the most common case of all, landing a score
 * on this very device, would list it twice.
 *
 * Filtered by player, because the list is per browser and a browser can hold
 * more than one account — showing another account's runs under your address
 * would be a lie about who earned them.
 */
export function standings(
  list: readonly RunRecord[],
  player: string | null,
  onChainBest: bigint | null,
  top = 10,
): Standing[] {
  if (!player) return [];

  const mine = list.filter((r) => r.player.toLowerCase() === player.toLowerCase());
  const rows = mine.map(toStanding);

  const alreadyShown =
    onChainBest !== null && mine.some((r) => r.landed && BigInt(r.score) === onChainBest);

  if (onChainBest !== null && onChainBest > 0n && !alreadyShown) {
    rows.push({
      key: `chain-${onChainBest}`,
      score: String(onChainBest),
      source: "chain",
      landed: true,
      disagreed: false,
      ticks: null,
      at: null,
    });
  }

  return rows
    .sort((a, b) => {
      const x = BigInt(a.score);
      const y = BigInt(b.score);
      if (x !== y) return x > y ? -1 : 1;
      if (a.source !== b.source) return WEIGHT[a.source] - WEIGHT[b.source];
      // Newest first among equals: the tie-break a player can see a reason for.
      return (b.at ?? 0) - (a.at ?? 0);
    })
    .slice(0, top);
}
