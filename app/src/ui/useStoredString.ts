import { useCallback, useState } from "react";

/**
 * A string persisted in the browser's own localStorage.
 *
 * Not the SDK's `useLocalStorageString`: that one is backed by host storage and
 * throws outside the Polkadot container, which would defeat the point of the
 * standalone fallback. The verifier URL is a local convenience setting, not
 * user data the host needs to own.
 */
export function useStoredString(
  key: string,
  fallback = "",
): [string, (value: string) => void] {
  const [value, setValue] = useState(() => {
    try {
      return window.localStorage.getItem(key) ?? fallback;
    } catch {
      // Private-browsing modes and sandboxed frames can refuse storage
      // entirely; an unusable preference must not stop the app from starting.
      return fallback;
    }
  });

  const set = useCallback(
    (next: string) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, next);
      } catch {
        // Ignore: the value still applies for this session.
      }
    },
    [key],
  );

  return [value, set];
}
