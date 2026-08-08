// Reading the leaderboard.
//
// Everything here is a *read*, and reads go through the host exactly as writes
// do — `app.chain` lends the connection, `.query()` dry-runs the view. The app
// opens no chain connection of its own.
//
// Two consequences worth stating, because they shape the UI:
//
//  1. No account, no allowance and no mapping are needed. `.query()` resolves an
//     origin from the pallet-revive fallback when none is supplied, so the board
//     loads before the player has connected anything.
//  2. No host means no board. The game and the enclave round-trip work
//     standalone; this does not, and the panel says so rather than sitting on a
//     spinner.

import type { App } from "@parity/product-sdk/core";

import { leaderboard } from "./contract";
import type { Row } from "./ranking";
import { isContractRevert, revertMessage } from "./revert";

/**
 * Which of the contract's two boards to read.
 *
 * `alltime` is every score ever recorded for a player. `today` is the same
 * shape restricted to the current UTC day, and it empties at midnight — the
 * contract keeps a separate `dailyBest` keyed by `dayOf(epoch)` rather than
 * clearing anything, so "yesterday" is still there, just not asked for.
 */
export type Scope = "alltime" | "today";

export interface Snapshot {
  /** Unranked, in the contract's first-score order. Rank with {@link rank}. */
  rows: Row[];
  /** `playerCount` — everyone enrolled, including rows this read did not fetch. */
  total: number;
  /** Wall-clock ms the read completed, for an "as of" line. */
  at: number;
  /** The day this snapshot covers, or null for the all-time board. */
  day: number | null;
}

/** Rows per `board()` call. */
const PAGE = 50;

/**
 * Most rows one refresh will read.
 *
 * A cap is unavoidable — the roster is unbounded — so the only question is
 * whether it is honest. `total` is reported alongside, so a truncated read says
 * "top 10 of 40 read, 900 enrolled" rather than quietly claiming to have seen
 * everyone. Ranking a partial read can be wrong, and pretending otherwise is
 * the failure mode worth avoiding.
 */
const MAX_ROWS = 200;

/**
 * A read-only contract handle.
 *
 * No `options`, and that is the whole difference from `submit.ts`: that path
 * binds the product's account as signer and origin, which costs a host round
 * trip to derive. A view needs neither — `.query()` resolves an origin from the
 * pallet-revive fallback — and requiring one would mean the board could not load
 * until the host had handed over an account.
 */
const readHandle = (app: App) => leaderboard(app);

/**
 * A failed view on a deployment that predates the board.
 *
 * `board` and `playerCount` were added after the contract at
 * `docs/deployment-devnet.md` went live, and calling a selector a deployment
 * does not have reverts like any other bad call. Distinguished from a genuine
 * chain failure because the fix is completely different — redeploy, versus try
 * again — and the panel should say which.
 */
export class BoardUnavailable extends Error {
  constructor(detail: string) {
    super(
      `this deployment has no such board view (${detail}). ` +
        `The daily board (currentDay/dailyPlayerCount/dailyBoard) landed after the ` +
        `deployment in docs/deployment-devnet.md — redeploy the contract, then ` +
        `re-run \`cdm i -n devnet @dw3labs/rainbow-leaderboard\` in app/ so the ` +
        `manifest picks up the new address and ABI together.`,
    );
    this.name = "BoardUnavailable";
  }
}

/**
 * The right error for a failed view, which is not always {@link BoardUnavailable}.
 *
 * `success: false` covers two unrelated things. A *revert* is the deployment
 * answering — and for a view this app only calls on a board that should have it,
 * a revert really does mean the selector is missing, which is what
 * `BoardUnavailable` claims. A *dispatch* failure is the call never running, and
 * saying "redeploy the contract" to someone whose node just refused a runtime
 * call is advice that costs a deployment and fixes nothing.
 *
 * `useBoard` branches on the class (`needsRedeploy: e instanceof BoardUnavailable`),
 * so this is not only wording — it decides what the panel tells the player to do.
 */
function viewFailed(what: string, value: unknown): Error {
  return isContractRevert(value)
    ? new BoardUnavailable(`${what} reverted: ${revertMessage(value)}`)
    : new Error(`${what} could not be read: ${revertMessage(value)}`);
}

/**
 * Today's day index, as the *chain* counts it.
 *
 * Deliberately not `Math.floor(Date.now() / 86_400_000)`. The contract files a
 * score under `dayOf(claim.epoch)`, which derives from `block.timestamp` — so a
 * device whose clock is a few minutes fast would, for those minutes around
 * midnight, render tomorrow's empty board while every score still landed on
 * today's. Asking is one dry-run and removes the class.
 */
export async function readCurrentDay(app: App): Promise<number> {
  const contract = await readHandle(app);
  const res = await contract.currentDay.query();
  if (!res.success) throw viewFailed("currentDay", res.value);
  return Number(res.value);
}

/**
 * Everyone on a game's board, up to {@link MAX_ROWS}. Unranked.
 *
 * @param day the day to read, or null for the all-time board. Passed in rather
 *        than resolved here so a caller reading both boards spends one
 *        `currentDay` round trip instead of two.
 */
export async function readBoard(
  app: App,
  gameId: number,
  day: number | null = null,
): Promise<Snapshot> {
  const contract = await readHandle(app);

  // The two boards differ only in an extra leading argument, and this used to
  // exploit that by spreading a shared `countArgs` array into a method looked up
  // by name. It cannot any more: the generated types give each method its own
  // positional signature, so the call has to name which board it is asking for.
  //
  // A branch per call rather than two copies of the paging loop, which is the
  // part worth keeping shared — writing that twice is how the two would
  // eventually disagree about what a short page means.
  const countName = day === null ? "playerCount" : "dailyPlayerCount";
  const pageName = day === null ? "board" : "dailyBoard";

  const count =
    day === null
      ? await contract.playerCount.query(BigInt(gameId))
      : await contract.dailyPlayerCount.query(BigInt(gameId), BigInt(day));
  if (!count.success) throw viewFailed(countName, count.value);
  const total = Number(count.value);

  const rows: Row[] = [];
  const wanted = Math.min(total, MAX_ROWS);

  while (rows.length < wanted) {
    const offset = BigInt(rows.length);
    const limit = BigInt(Math.min(PAGE, wanted - rows.length));
    const page =
      day === null
        ? await contract.board.query(BigInt(gameId), offset, limit)
        : await contract.dailyBoard.query(BigInt(gameId), BigInt(day), offset, limit);
    if (!page.success) throw viewFailed(pageName, page.value);

    const { players, scores } = page.value;
    // A short page means the roster ends here — or shrank under us, which it
    // cannot, but treating it as the end costs nothing and cannot loop forever.
    if (players.length === 0) break;

    // `forEach` rather than an index loop: the two arrays are parallel by
    // construction, and this is the form where the element type is not
    // `string | undefined`.
    players.forEach((p, i) => rows.push({ player: p, score: scores[i] ?? 0n }));
  }

  return { rows, total, at: Date.now(), day };
}

/**
 * Whether the chain has already consumed a session.
 *
 * The exact answer to "did my submission land?", which is what the submit path
 * falls back on when the host stops answering. Exact because the contract sets
 * `usedSession` on every accepted attestation and on no rejected one — there is
 * no score comparison to be fooled by a previous run.
 */
export async function readSessionSpent(
  app: App,
  player: string,
  epoch: number,
  k: number,
): Promise<boolean> {
  const contract = await readHandle(app);
  const id = await contract.sessionIdFor.query(player, BigInt(epoch), k);
  if (!id.success) throw viewFailed("sessionIdFor", id.value);
  const used = await contract.usedSession.query(id.value);
  if (!used.success) throw viewFailed("usedSession", used.value);
  return used.value;
}

/**
 * Whether the contract will accept attestations signed by this enclave.
 *
 * `submit` recovers the signer from the claim and checks it against the
 * contract's own verifier set. An enclave that is not in it produces
 * `BadAttestation` — and that is the whole reason this exists as a *pre*-flight:
 * nothing about a run reveals the problem until the very end, so a player
 * finishes, earns a signed attestation, and only then learns the chain was never
 * going to take it.
 *
 * It goes stale in exactly one direction, and it is a direction that happens.
 * Redeploying the verifier job gives it a fresh signing key, so a deployment
 * that worked yesterday is untrusted today until someone calls `setVerifier` —
 * which is a step it is easy to finish a deploy without noticing.
 *
 * A plain view: no account, no gas, no prompt, same as every other read here.
 *
 * @param verifier the enclave's Ethereum address — `addressOf(identity.secp256k1)`,
 *        not the public key itself.
 */
export async function readVerifierTrusted(app: App, verifier: string): Promise<boolean> {
  const contract = await readHandle(app);
  const res = await contract.isVerifier.query(verifier);
  if (!res.success) throw viewFailed("isVerifier", res.value);
  return res.value;
}

/**
 * A player's best on this board, straight from the mapping.
 *
 * Read separately rather than picked out of the snapshot: with a truncated read
 * a player's own row can be one of the ones left unfetched, and "you are not on
 * the board" is exactly the wrong thing to tell someone who is.
 *
 * @param day the day to read, or null for the all-time best.
 */
export async function readYourBest(
  app: App,
  gameId: number,
  player: string,
  day: number | null = null,
): Promise<bigint> {
  const contract = await readHandle(app);
  const res =
    day === null
      ? await contract.best.query(BigInt(gameId), player)
      : await contract.dailyBest.query(BigInt(gameId), BigInt(day), player);
  if (!res.success) throw viewFailed(day === null ? "best" : "dailyBest", res.value);
  return res.value;
}
