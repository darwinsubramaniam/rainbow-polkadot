import { useEffect, useRef } from "react";

import type { Attestation } from "../chain/enclave";

export type LogKind = "info" | "ok" | "bad";
export interface Line {
  kind: LogKind;
  text: string;
}

interface Props {
  onClose: () => void;
  lines: readonly Line[];
  attestation: Attestation | null;
}

/**
 * The technical log, and nothing else.
 *
 * This was a Session sheet: the account, the verifier URL, a dev switch for the
 * simulator, and the log underneath them. Every one of those has since found a
 * better home — the account and the verifier are drawn in the proof diagram,
 * where they are part of the argument rather than a form field, and the
 * simulator is offered on the cabinet at the moment it is needed. What was left
 * here was a second copy of all three, which is worse than no copy: two places
 * showing one fact are two places that can disagree.
 *
 * So it is the log alone, and the button that opens it says "Log" instead of
 * wearing a gear. A gear promises settings, and there are none behind it.
 *
 * It renders *inside* the cabinet rather than on the page, for the same reason
 * the play controls do: the cabinet is what goes fullscreen, so anything outside
 * it becomes unreachable exactly when the game is most playable.
 */
export function Log({ onClose, lines, attestation }: Props) {
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
      aria-label="Session log"
      tabIndex={-1}
      ref={sheet}
      onKeyDown={onKeyDown}
    >
      <div className="sheet-head">
        <h2>Log</h2>
        <span className="note">{lines.length} lines</span>
        <button className="ghost tiny" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="sheet-body">
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
  );
}
