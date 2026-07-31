import { personalBest, type RunRecord } from "../chain/history";

interface Props {
  /** Every run this browser has attested, unfiltered — the panel picks the player's. */
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
 * Your ten best runs.
 *
 * Deliberately a different kind of claim to the board beside it, and labelled as
 * one. Each *score* here was computed and signed inside the enclave — the app
 * never invents a number — but the *list* is this browser's own memory, because
 * the contract stores one score per player and there is nothing on-chain to page
 * through. Clearing the browser loses the history; your best survives on-chain,
 * which is the part that counts.
 *
 * A row that landed is marked, because that is the difference between a run that
 * happened and a run the chain accepted.
 */
export function YourRuns({ history, you, onChainBest, simulated, guest }: Props) {
  const runs = personalBest(history, you);

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
          <p className="empty">No attested runs yet. Play one, then let the enclave recompute it.</p>
        )}

        {runs.length > 0 && (
          <ol className="rows">
            {runs.map((r) => (
              <li key={`${r.epoch}-${r.k}`} className={r.landed ? "row landed" : "row"}>
                {/* A tick rather than a chain glyph: the marker sits in the same
                    column as the board's rank numbers, and an emoji there
                    renders at a different weight on every platform. */}
                <span className="place" title={r.landed ? "accepted on-chain" : "attested, never landed"}>
                  {r.landed ? "✓" : "·"}
                </span>
                <span className="who">
                  {when(r.at)}
                  <span className="dim"> · {r.ticks} ticks</span>
                  {!r.agreed && <span className="tag bad">disagreed</span>}
                </span>
                <span className="score">{r.score}</span>
              </li>
            ))}
          </ol>
        )}

        {runs.length > 0 && (
          <p className="hint">
            Every score here was computed inside the enclave, not by this browser. ✓ marks the ones the contract
            accepted — the rest were attested but never landed, usually because they did not beat your best.
          </p>
        )}
      </div>
    </section>
  );
}
