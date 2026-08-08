import { standings, type RunRecord, type Standing } from "../chain/history";

interface Props {
  /** Every run this browser has kept, unfiltered — the panel picks the player's. */
  history: readonly RunRecord[];
  /** The H160 the player scores as, or null when no account is connected. */
  you: string | null;
  /** The player's best on-chain, read from the contract. Null when unread. */
  onChainBest: bigint | null;
  /** True while the simulator is answering, which makes these runs unlandable. */
  simulated: boolean;
  /** True when these runs belong to a guest identity, which has no on-chain record. */
  guest: boolean;
}

const when = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * The marker in the rank column, and what it promises.
 *
 * Three states rather than two, because the list now merges three kinds of
 * claim and a row that does not say which it is invites the strongest reading.
 * All three are typographic for the same reason the tick was: the column lines
 * up with the board's rank numbers beside it, and an emoji there renders at a
 * different weight on every platform.
 */
const TITLE: Record<Standing["source"], string> = {
  chain: "your best, read from the contract — landed from somewhere this browser has no record of",
  enclave: "signed by the enclave, never landed",
  device: "this browser's own count — it did not beat your best, so it was never attested",
};

const mark = (s: Standing) => ({
  glyph: s.landed ? "✓" : "·",
  title: s.landed && s.source !== "chain" ? "accepted on-chain" : TITLE[s.source],
});

/**
 * Your ten best runs, from both places that know one.
 *
 * Deliberately a different kind of claim to the board beside it, and labelled as
 * one — row by row, because the rows no longer make the same claim as each
 * other. Three kinds appear:
 *
 *  - the contract's own number, which is the only one that counts for ranking;
 *  - a run the enclave signed on this device but that never landed;
 *  - a run only this browser counted, because it did not beat your best and so
 *    was never worth sending to the enclave at all.
 *
 * The mix is the honest shape of the thing. The contract stores one score per
 * player and nothing to page through, so it cannot supply a list; this browser
 * has a list but only of what it saw. Neither alone can fill a top ten that
 * agrees with the "on-chain best" printed directly above it.
 *
 * Clearing the browser loses the local rows; your best survives on-chain, which
 * is the part that matters — and after a clear it is exactly what this panel
 * still shows.
 */
export function YourRuns({ history, you, onChainBest, simulated, guest }: Props) {
  const runs = standings(history, you, onChainBest);

  return (
    <section className="panel board" aria-label="Your runs">
      <div className="panel-head">
        <h2>Your best 10</h2>
        <span className="note">
          {onChainBest !== null && onChainBest > 0n
            ? `on-chain best ${String(onChainBest)}`
            : guest
              ? "guest — this device only"
              : simulated
                ? "simulated"
                : "this device"}
        </span>
      </div>

      <div className="panel-body">
        {!you && <p className="empty">Connect an account to keep a record of your runs.</p>}

        {you && runs.length === 0 && (
          <p className="empty">No runs yet. Play one — it is kept here whether or not it beats your best.</p>
        )}

        {runs.length > 0 && (
          <ol className="rows">
            {runs.map((r) => (
              <li key={r.key} className={r.landed ? "row landed" : "row"}>
                {/* A tick rather than a chain glyph: the marker sits in the same
                    column as the board's rank numbers, and an emoji there
                    renders at a different weight on every platform. */}
                <span className="place" title={mark(r).title}>
                  {mark(r).glyph}
                </span>
                <span className="who">
                  {/* The chain row has no run behind it on this device, so it
                      has no clock and no tick count to show — only what it is. */}
                  {r.at === null ? "on-chain best" : when(r.at)}
                  {r.ticks !== null && <span className="dim"> · {r.ticks} ticks</span>}
                  {r.source === "device" && <span className="tag soft">this device</span>}
                  {r.disagreed && <span className="tag bad">disagreed</span>}
                </span>
                <span className="score">{r.score}</span>
              </li>
            ))}
          </ol>
        )}

        {runs.length > 0 && (
          <p className="hint">
            ✓ marks a score the contract holds. The rest were played here and never landed — an unmarked row the
            enclave signed, or one tagged “this device” that it never saw, because a run that cannot beat your best
            is not worth sending.
          </p>
        )}
      </div>
    </section>
  );
}
