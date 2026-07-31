import { useEffect, useState } from "react";

/**
 * Whether a media query currently matches.
 *
 * Used to pick between the flow diagram and the linear rail rather than to
 * hide one with CSS, because the diagram measures itself: mounted inside a
 * `display: none` container it fits its view to a zero-sized box and stays
 * that way. Mounting only the one that will actually be seen avoids it.
 *
 * The initial read happens in the state initialiser so the first paint is
 * already correct — deciding in an effect would render the wrong one, then
 * swap it, which is a visible flash on every load.
 */
export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const sync = () => setMatches(mql.matches);
    sync();
    mql.addEventListener("change", sync);
    return () => mql.removeEventListener("change", sync);
  }, [query]);

  return matches;
}
