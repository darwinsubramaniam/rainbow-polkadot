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

import { createContractFromClient, type AbiEntry } from "@parity/product-sdk/contracts";
import type { App } from "@parity/product-sdk/core";

import { CONTRACT, LEADERBOARD_ABI } from "./leaderboard";
import { ASSET_HUB } from "./network";
import type { Row } from "./ranking";

export interface Snapshot {
  /** Unranked, in the contract's first-score order. Rank with {@link rank}. */
  rows: Row[];
  /** `playerCount` — everyone enrolled, including rows this read did not fetch. */
  total: number;
  /** Wall-clock ms the read completed, for an "as of" line. */
  at: number;
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
 * Separate from the one in `submit.ts` on purpose: that one binds the product's
 * account as signer and origin, which costs a host round trip to derive. A view
 * needs neither, and requiring one would mean the board could not load until
 * the host had handed over an account.
 */
async function readHandle(app: App) {
  // Cached by the SDK, so calling it per refresh costs nothing after the first.
  await app.chain.connect({ assetHub: ASSET_HUB });

  // "Raw" here means untyped, not un-hosted — the name invites the opposite
  // reading, and a review did read it that way. `product-sdk-chain-client`:
  // "Connections route through the host provider … there is no direct-WebSocket
  // fallback." This client is the host's; there is no other kind to get.
  //
  // It also has to be this one rather than the typed API from `getClient`.
  // `createContractFromClient` builds on `createContractRuntimeFromClient`,
  // which the SDK says to "use on every production code path that calls a
  // contract's .tx() or .query() against a live chain" — because it routes the
  // dry-run through `getUnsafeApi()`. The typed factory is documented as being
  // for tests, and "susceptible to `Incompatible runtime entry` errors on a
  // live chain whose descriptor lags". Ours will lag eventually.
  const client = app.chain.getRawClient(ASSET_HUB);
  return createContractFromClient(
    client,
    ASSET_HUB,
    CONTRACT as `0x${string}`,
    LEADERBOARD_ABI as unknown as AbiEntry[],
  );
}

type Query = (...args: unknown[]) => Promise<{ success: boolean; value: unknown }>;

function view(contract: ReturnType<typeof createContractFromClient>, name: string): Query {
  const m = (contract as Record<string, unknown>)[name];
  if (!m) throw new Error(`contract has no method ${name}`);
  return (m as { query: Query }).query;
}

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
      `this deployment has no board view (${detail}). ` +
        `It was deployed before playerCount/board existed — redeploy the contract and ` +
        `point VITE_CONTRACT at the new address.`,
    );
    this.name = "BoardUnavailable";
  }
}

/** Everyone on a game's board, up to {@link MAX_ROWS}. Unranked. */
export async function readBoard(app: App, gameId: number): Promise<Snapshot> {
  const contract = await readHandle(app);

  const count = await view(contract, "playerCount")(BigInt(gameId));
  if (!count.success) throw new BoardUnavailable(`playerCount reverted: ${JSON.stringify(count.value)}`);
  const total = Number(count.value as bigint);

  const rows: Row[] = [];
  const wanted = Math.min(total, MAX_ROWS);

  while (rows.length < wanted) {
    const page = await view(contract, "board")(
      BigInt(gameId),
      BigInt(rows.length),
      BigInt(Math.min(PAGE, wanted - rows.length)),
    );
    if (!page.success) throw new BoardUnavailable(`board reverted: ${JSON.stringify(page.value)}`);

    const { players, scores } = page.value as { players: string[]; scores: (bigint | number)[] };
    // A short page means the roster ends here — or shrank under us, which it
    // cannot, but treating it as the end costs nothing and cannot loop forever.
    if (players.length === 0) break;

    // `forEach` rather than an index loop: the two arrays are parallel by
    // construction, and this is the form where the element type is not
    // `string | undefined`.
    players.forEach((p, i) => rows.push({ player: p, score: BigInt(scores[i] ?? 0) }));
  }

  return { rows, total, at: Date.now() };
}

/**
 * A player's best on this board, straight from the mapping.
 *
 * Read separately rather than picked out of the snapshot: with a truncated read
 * a player's own row can be one of the ones left unfetched, and "you are not on
 * the board" is exactly the wrong thing to tell someone who is.
 */
export async function readYourBest(app: App, gameId: number, player: string): Promise<bigint> {
  const contract = await readHandle(app);
  const res = await view(contract, "best")(BigInt(gameId), player);
  if (!res.success) throw new Error(`best() reverted: ${JSON.stringify(res.value)}`);
  return BigInt(res.value as bigint);
}
