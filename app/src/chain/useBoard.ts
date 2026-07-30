import { useEffect, useState } from "react";
import type { App } from "@parity/product-sdk/core";

import { BoardUnavailable, readBoard, readYourBest } from "./board";
import { rank, type Row } from "./ranking";

/**
 * The leaderboard, as the UI needs it.
 *
 * A hook rather than a call in `Play`, because the board has four states the
 * panel has to distinguish — no host, loading, ready, failed — and the difference
 * between "nobody has scored" and "we could not read it" is exactly what a
 * leaderboard must not blur.
 */

export type BoardStatus =
  /** No Polkadot host, so no chain access. Not an error; a mode the app supports. */
  | "nohost"
  | "loading"
  | "ready"
  | "error";

export interface BoardView {
  status: BoardStatus;
  /** Ranked, highest first, at most `TOP`. */
  ranked: Row[];
  /** Everyone enrolled on the board, including rows beyond what was read. */
  total: number;
  /** Rows actually fetched. Less than `total` means the ranking is partial. */
  read: number;
  /** The player's own best, straight from the mapping. Null until read. */
  yourBest: bigint | null;
  /** Wall-clock ms of the last successful read. */
  at: number | null;
  error: string | null;
  /** True when the deployment predates the board view, which needs a redeploy. */
  needsRedeploy: boolean;
}

const EMPTY: BoardView = {
  status: "loading",
  ranked: [],
  total: 0,
  read: 0,
  yourBest: null,
  at: null,
  error: null,
  needsRedeploy: false,
};

/**
 * @param refreshKey bump it to re-read. A landed score changes the board, and
 *        nothing pushes that fact to us — a read is a dry-run, not a
 *        subscription — so the caller says when it is worth asking again.
 */
export function useBoard(
  app: App | null,
  gameId: number,
  player: string | null,
  refreshKey: number,
): BoardView {
  const [view, setView] = useState<BoardView>(EMPTY);

  useEffect(() => {
    if (!app) {
      setView({ ...EMPTY, status: "nohost" });
      return;
    }

    // Keep the rows already on screen while refreshing. Blanking the panel on
    // every refresh would make a landed score look like it wiped the board.
    setView((v) => ({ ...v, status: "loading", error: null }));

    let live = true;
    void (async () => {
      try {
        const snapshot = await readBoard(app, gameId);
        // Read after the board, and tolerated separately: a failure here is not
        // a reason to withhold a board that was read successfully.
        let yourBest: bigint | null = null;
        if (player) {
          try {
            yourBest = await readYourBest(app, gameId, player);
          } catch {
            yourBest = null;
          }
        }
        if (!live) return;
        setView({
          status: "ready",
          ranked: rank(snapshot.rows),
          total: snapshot.total,
          read: snapshot.rows.length,
          yourBest,
          at: snapshot.at,
          error: null,
          needsRedeploy: false,
        });
      } catch (e) {
        if (!live) return;
        setView((v) => ({
          ...v,
          status: "error",
          error: e instanceof Error ? e.message : String(e),
          needsRedeploy: e instanceof BoardUnavailable,
        }));
      }
    })();

    return () => {
      live = false;
    };
  }, [app, gameId, player, refreshKey]);

  return view;
}
