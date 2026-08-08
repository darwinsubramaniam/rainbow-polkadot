import { useEffect, useRef, useState } from "react";

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
 * The log as one block of text, which is the form it is useful in elsewhere.
 *
 * The attestation goes in too, and expanded rather than as the collapsed
 * `<details>` the sheet shows: a copy is taken to be pasted into a bug report or
 * an issue, and the signed claim is the part that makes the rest checkable.
 */
function asText(lines: readonly Line[], attestation: Attestation | null): string {
  const body = lines.map((l) => l.text).join("\n");
  if (!attestation) return `${body}\n`;
  return `${body}\n\nSigned attestation:\n${JSON.stringify(attestation, null, 2)}\n`;
}

/**
 * Put text on the clipboard, by whichever route this host allows.
 *
 * `navigator.clipboard` needs a secure context, and this app runs in more than
 * one: a browser on localhost has it, an `http://` deployment does not, and a
 * host webview may or may not expose it at all. The deprecated `execCommand`
 * path covers the rest, and being deprecated matters less than a copy button
 * that silently does nothing on the one build a player is trying to report a
 * bug from.
 */
async function toClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall through to the textarea.
  }

  try {
    const area = document.createElement("textarea");
    area.value = text;
    // Off-screen rather than hidden: `display: none` and `visibility: hidden`
    // are both unselectable, and the selection is what gets copied.
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.setAttribute("readonly", "");
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
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

  // The button says what happened, because a copy is otherwise invisible: the
  // clipboard is somewhere else, and a button that looks identical before and
  // after leaves the only way to check being to paste and see.
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");
  const revert = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (revert.current) clearTimeout(revert.current);
  }, []);

  const copy = async () => {
    const ok = await toClipboard(asText(lines, attestation));
    setCopied(ok ? "ok" : "fail");
    if (revert.current) clearTimeout(revert.current);
    revert.current = setTimeout(() => setCopied("idle"), 2000);
  };

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
        <button
          className="ghost tiny"
          onClick={copy}
          disabled={lines.length === 0}
          // The label changes under the pointer, so the accessible name is
          // pinned to the action rather than to its outcome.
          aria-label="Copy log"
        >
          {copied === "ok" ? "Copied" : copied === "fail" ? "Copy failed" : "Copy"}
        </button>
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
