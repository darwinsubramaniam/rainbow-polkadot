import { useEffect, useRef } from "react";

import type { Attestation } from "../chain/enclave";
import { short } from "./short";

export type LogKind = "info" | "ok" | "bad";
export interface Line {
  kind: LogKind;
  text: string;
}

interface Props {
  onClose: () => void;

  /** The connected account and the H160 it plays as, or nulls. */
  address: string | null;
  player: string | null;
  onConnect: () => void;
  connecting: boolean;
  /** What the app is talking to: the host, the simulator, or nothing. */
  where: string;

  verifier: string;
  onVerifier: (value: string) => void;

  /** Development only, and compiled out of a build along with the simulator. */
  simulated: boolean;
  onToggleSimulation: () => void;

  lines: readonly Line[];
  attestation: Attestation | null;
}

/**
 * The gear: session details and the technical log.
 *
 * All of this used to sit permanently under the game — an address, a verifier
 * URL, a dev switch and a scrolling trace of every step. Useful while the system
 * was being built, and the wrong default once it works: a player arriving at a
 * game should be shown the leaderboard, not a debug console. So the page below
 * the cabinet now belongs to the boards, and this is here when it is wanted.
 *
 * It renders *inside* the cabinet rather than on the page, for the same reason
 * the play controls do: the cabinet is what goes fullscreen, so anything outside
 * it becomes unreachable exactly when the game is most playable. Pressing the
 * gear in fullscreen has to open something.
 *
 * Nothing here is decorative — a wrong verifier URL or a stale simulator switch
 * is the difference between a score landing and a mystifying failure — so it is
 * one keystroke away, not removed.
 */
export function Settings({
  onClose,
  address,
  player,
  onConnect,
  connecting,
  where,
  verifier,
  onVerifier,
  simulated,
  onToggleSimulation,
  lines,
  attestation,
}: Props) {
  const sheet = useRef<HTMLDivElement | null>(null);
  const tail = useRef<HTMLDivElement | null>(null);

  // Move focus into the sheet on open, so it is dismissable and navigable from
  // the keyboard rather than only by pointer.
  useEffect(() => {
    sheet.current?.focus();
  }, []);

  // Escape closes it. Bound on the sheet, not the document: in fullscreen the
  // browser reserves Escape for leaving fullscreen, and a document handler would
  // fight it.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
  };

  // Keep the newest line in view. The log is read while something is happening,
  // and the interesting line is always the last one.
  useEffect(() => {
    tail.current?.scrollIntoView({ block: "nearest" });
  }, [lines.length]);

  return (
    <div
      className="sheet"
      role="dialog"
      aria-modal="true"
      aria-label="Session settings and log"
      tabIndex={-1}
      ref={sheet}
      onKeyDown={onKeyDown}
    >
      <div className="sheet-head">
        <h2>Session</h2>
        <span className="note">{where}</span>
        <button className="ghost tiny" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="sheet-body">
        <div className="field">
          <span className="label">Account</span>
          {address ? (
            <span className="identity">
              <span>{short(address)}</span>
              <span className="arrow">→ plays as</span>
              <span>{player ? short(player) : "—"}</span>
            </span>
          ) : (
            <button className="ghost" onClick={onConnect} disabled={connecting}>
              {connecting ? "Connecting…" : "Connect wallet"}
            </button>
          )}
        </div>

        <div className="field">
          <label htmlFor="verifier">Verifier enclave</label>
          <input
            id="verifier"
            value={verifier}
            spellCheck={false}
            disabled={simulated}
            placeholder="https://verifier.example.com"
            onChange={(e) => onVerifier(e.target.value)}
          />
          {simulated && <span className="hint">unused while the simulator is on</span>}
        </div>

        {/* Development only. This whole block is compiled away in a build, along
            with the simulator it switches on. */}
        {import.meta.env.DEV && (
          <div className="field">
            <span className="label">Development</span>
            <div className="dev-row">
              <button className="ghost" onClick={onToggleSimulation} aria-pressed={simulated}>
                {simulated ? "Simulator: on" : "Simulate the enclave"}
              </button>
              <span className="hint">
                {simulated
                  ? "Seeds, replay and the EIP-712 signature are computed here, by a key that is in the source. Play and attest work with nothing deployed; submitting is refused."
                  : "Runs the verifier in this tab so play and attest work without an Acurast job or a tunnel."}
              </span>
            </div>
          </div>
        )}

        <div className="field">
          <span className="label">Log · {lines.length} lines</span>
          <div className="trace">
            {lines.length === 0 && (
              <div className="empty">
                Connect an account, then start a session. Everything the app does lands here.
              </div>
            )}
            {lines.map((l, i) => (
              <div key={i} className={l.kind}>
                {l.text}
              </div>
            ))}
            {attestation && (
              <details>
                <summary>Signed attestation</summary>
                <pre>{JSON.stringify(attestation, null, 2)}</pre>
              </details>
            )}
            <div ref={tail} />
          </div>
        </div>
      </div>
    </div>
  );
}
