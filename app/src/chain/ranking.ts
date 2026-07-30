/**
 * Turning the contract's rows into a ranking.
 *
 * The contract hands back a board in first-score order and leaves the ordering
 * to whoever reads it — sorting on-chain would mean an unbounded write on every
 * submit, while sorting ten rows here costs nothing.
 *
 * Kept apart from `board.ts` so it is a pure module: that one reaches for the
 * host SDK and for `import.meta.env`, neither of which exists under Node's test
 * runner, and this is the part with rules worth pinning down.
 */

/** One row of the board: a player and the best they have landed. */
export interface Row {
  player: string;
  score: bigint;
}

/** How many rows the board shows. */
export const TOP = 10;

/**
 * Rank rows highest-first and keep the top `top`.
 *
 * `sort` is stable in every engine this ships to, so equal scores stay in the
 * contract's first-score order — whoever reached that score first is listed
 * first. The comparator compares rather than subtracting: `Number(a - b)` loses
 * precision at u64 scale and would order large scores arbitrarily.
 */
export function rank(rows: readonly Row[], top = TOP): Row[] {
  return [...rows]
    .sort((a, b) => (a.score === b.score ? 0 : a.score > b.score ? -1 : 1))
    .slice(0, top);
}

/** Zero-based position of a player in a ranked list, or null if absent. */
export function rankOf(ranked: readonly Row[], player: string | null): number | null {
  if (!player) return null;
  const target = player.toLowerCase();
  const i = ranked.findIndex((r) => r.player.toLowerCase() === target);
  return i === -1 ? null : i;
}
