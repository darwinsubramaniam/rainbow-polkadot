import { useCallback, useState } from "react";

/**
 * Preferences persisted in the browser's own localStorage.
 *
 * `localStorage` is available on every Polkadot surface, including inside the
 * sandboxed cross-origin iframe the web gateway delivers a Product into —
 * E0.1 measured it directly and recorded "localStorage writable"
 * (`docs/E0.1-product-sandbox.md`, `probe/index.html`).
 *
 * The reason to use it rather than the SDK's host-backed storage is not
 * availability, then, but scope: host storage requires a host, and this app
 * supports running standalone with no container at all. The verifier URL and
 * the attempt number are local conveniences, not user data the host needs to
 * own, so they should survive in both modes.
 *
 * Access stays wrapped anyway. E0.1 tested only the desktop web gateway and
 * explicitly leaves the Android/iOS native webview "unverified rather than
 * assumed-passing", and private-browsing modes refuse storage on any surface.
 * A preference that cannot be saved must still not stop the app from starting.
 */

const read = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const write = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore: the value still applies for this session.
  }
};

/**
 * `migrate` rewrites a value that was stored by an *earlier build* of the app,
 * before the first render sees it. A stored preference always beats a new
 * default — that is the point of persisting it — so a default that changes
 * meaning between builds cannot reach anyone who has already set one, and they
 * are stuck on a value the app no longer considers reachable.
 *
 * It must be conservative and idempotent: return `stored` unchanged unless the
 * value is one this build can show is obsolete. It runs on every mount, and
 * React re-runs the initialiser under StrictMode, so it must not depend on
 * running exactly once. The rewrite is written back so storage converges rather
 * than being re-migrated forever.
 */
export function useStoredString(
  key: string,
  fallback = "",
  migrate?: (stored: string) => string,
): [string, (value: string) => void] {
  const [value, setValue] = useState(() => {
    const stored = read(key);
    if (stored === null) return fallback;
    const next = migrate?.(stored) ?? stored;
    if (next !== stored) write(key, next);
    return next;
  });

  const set = useCallback(
    (next: string) => {
      setValue(next);
      write(key, next);
    },
    [key],
  );

  return [value, set];
}

/**
 * The same, for a JSON-serialisable record.
 *
 * Anything unparseable falls back rather than throwing: the stored value is a
 * cache the app can always rebuild by asking the enclave for a new session, so
 * a corrupt entry should cost a round trip, never a broken page.
 */
export function useStoredJson<T>(key: string, fallback: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const raw = read(key);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  });

  const set = useCallback(
    (next: T) => {
      setValue(next);
      write(key, JSON.stringify(next));
    },
    [key],
  );

  return [value, set];
}
