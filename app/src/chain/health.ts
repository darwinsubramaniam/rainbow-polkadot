import { useCallback, useEffect, useRef, useState } from "react";

import { identity } from "./enclave";

/**
 * Is the Acurast Processor there?
 *
 * Worth asking before the player commits to anything, because the failure it
 * catches is not theirs. An Acurast job is a job: it runs for a while and then
 * it ends, the phone can drop off the network, and the deployment behind the
 * hostname can be replaced. Any of those leave the app pointing at a tunnel
 * with nothing on the far end — and without a probe the first the player hears
 * of it is a "Play" button that fails after they pressed it.
 *
 * Note what a green light here does and does not mean. It means something
 * answered `/identity` — nothing more. It is not a statement about whether that
 * something is registered as a verifier with the contract, which is a separate
 * fact and a separate failure (a score signed by an unregistered key attests
 * fine and reverts on submit).
 */
export type Health = "unknown" | "checking" | "online" | "offline";

export interface ProcessorHealth {
  status: Health;
  /** Why it is not answering, when it is not. */
  reason: string | null;
  /** When the last probe settled, for "checked 3 min ago". */
  checkedAt: number | null;
  /** Probe now — the retry button, and used after a manual URL change. */
  recheck: () => void;
}

/** Long enough not to badger a phone; short enough to notice a job ending. */
const EVERY_MS = 15 * 60_000;

/**
 * A probe should conclude quickly.
 *
 * Eight seconds, against the 30 the real calls get. A Processor that needs
 * longer than this to say who it is cannot usefully serve a run either, so
 * treating slow as down is the honest reading rather than an impatient one.
 */
const PROBE_TIMEOUT_MS = 8_000;

export function useProcessorHealth(verifier: string | null): ProcessorHealth {
  const [status, setStatus] = useState<Health>("unknown");
  const [reason, setReason] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  // Bumped to force a probe. A counter rather than a boolean because two
  // rechecks in a row must both run, and a flag flipped twice looks like one.
  const [nonce, setNonce] = useState(0);
  const recheck = useCallback(() => setNonce((n) => n + 1), []);

  // Which probe is the current one. An in-flight probe against the old URL
  // must not be allowed to report, or editing the verifier mid-check paints
  // the previous host's answer onto the new one.
  const run = useRef(0);

  useEffect(() => {
    // No URL, or the enclave is simulated in this tab: nothing to reach, and
    // "offline" would be a wrong thing to say about it.
    if (!verifier) {
      setStatus("unknown");
      setReason(null);
      return;
    }

    const mine = ++run.current;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const probe = async () => {
      setStatus((s) => (s === "online" ? s : "checking"));
      try {
        await identity(verifier, PROBE_TIMEOUT_MS);
        if (run.current !== mine) return;
        setStatus("online");
        setReason(null);
      } catch (e) {
        if (run.current !== mine) return;
        setStatus("offline");
        setReason(e instanceof Error ? e.message : String(e));
      } finally {
        if (run.current === mine) setCheckedAt(Date.now());
      }
    };

    void probe();
    const interval = setInterval(() => void probe(), EVERY_MS);

    // A laptop shut at lunch and opened at four would otherwise still be
    // showing the green light it was given four hours ago. Coming back to the
    // tab is exactly the moment the answer is most likely to have gone stale.
    const onVisible = () => {
      if (document.visibilityState === "visible") void probe();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(interval);
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [verifier, nonce]);

  return { status, reason, checkedAt, recheck };
}
