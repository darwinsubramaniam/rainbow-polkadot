import { rankOf } from "../chain/ranking";
import type { BoardView } from "../chain/useBoard";
import { short } from "./short";

interface Props {
  view: BoardView;
  /** The H160 the player scores as, so their own row can be marked. */
  you: string | null;
  onRefresh: () => void;
}

const ago = (at: number): string => {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
};

/**
 * The top ten, read from the contract.
 *
 * Every number on this panel came out of chain storage, and every one of them
 * got there by way of an enclave signature the contract checked — that is the
 * only way `best` can be written. So this is not a scoreboard the app is
 * keeping; it is the contract's own state, ranked for display.
 *
 * The states are kept distinct on purpose. "Nobody has scored yet" and "we could
 * not read the board" look identical if you render an empty list for both, and
 * an empty leaderboard is precisely the kind of wrong answer nobody questions.
 */
export function TopBoard({ view, you, onRefresh }: Props) {
  const { status, ranked, total, read, at } = view;
  const mine = rankOf(ranked, you);
  const partial = read < total;

  return (
    <section className="panel board" aria-label="Leaderboard">
      <div className="panel-head">
        <h2>Top 10</h2>
        {/* Nothing pushes a score to us — a view call is a dry-run, not a
            subscription — so a refresh is the honest way to see someone else's
            run land. Hidden with no host, where there is nothing to re-read. */}
        {status !== "nohost" && (
          <button className="ghost tiny" onClick={onRefresh} disabled={status === "loading"}>
            {status === "loading" ? "Reading…" : "Refresh"}
          </button>
        )}
        <span className="note">
          {status === "ready"
            ? total === 0
              ? "on-chain"
              : `${total} player${total === 1 ? "" : "s"}${at ? ` · ${ago(at)}` : ""}`
            : status === "loading"
              ? "reading the contract…"
              : status === "nohost"
                ? "needs the host"
                : "unavailable"}
        </span>
      </div>

      <div className="panel-body">
        {status === "nohost" && (
          <p className="empty">
            The board is read through Polkadot. Open this in the Polkadot app to see it — the game and the
            enclave&apos;s signature work without a host, but chain reads do not.
          </p>
        )}

        {status === "error" && (
          <p className="bad">
            {view.needsRedeploy
              ? "This deployment has no board view. It predates playerCount/board — redeploy the contract and point the app at the new address."
              : view.error}
          </p>
        )}

        {status !== "nohost" && status !== "error" && ranked.length === 0 && (
          <p className="empty">
            {status === "loading"
              ? "Reading the board…"
              : "Nobody has landed a score yet. Play a run and be first."}
          </p>
        )}

        {ranked.length > 0 && (
          <ol className="rows">
            {ranked.map((r, i) => (
              <li key={r.player} className={i === mine ? "row me" : "row"}>
                <span className="place">{i + 1}</span>
                <span className="who" title={r.player}>
                  {short(r.player)}
                  {i === mine && <span className="tag">you</span>}
                </span>
                <span className="score">{String(r.score)}</span>
              </li>
            ))}
          </ol>
        )}

        {/* Never silently truncate a ranking: a partial read can put the wrong
            player first, and the panel has to admit that rather than look
            authoritative. */}
        {partial && (
          <p className="hint">
            Ranked from the first {read} of {total} players — this board reads a bounded slice, so a score outside
            it would be missed.
          </p>
        )}
      </div>
    </section>
  );
}
