import { useEffect, useState } from "react";

export type Route = "play" | "how";

/**
 * Two pages, no router dependency.
 *
 * Hash routing rather than history routing because a published Product is
 * resolved client-side by the gateway and served out of a service-worker VFS —
 * there is no origin server to rewrite `/how` back onto index.html, so a
 * path-based route would 404 on reload. The fragment never reaches a server.
 */
export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));

  useEffect(() => {
    const onChange = () => setRoute(parse(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  // Landing on a new page mid-scroll would otherwise keep the old offset.
  useEffect(() => {
    if (!window.location.hash.includes("#", 1)) window.scrollTo(0, 0);
  }, [route]);

  return route;
}

// `#/how#enclave` is a route plus an in-page anchor, so the route is only the
// part before the next delimiter.
const parse = (hash: string): Route => (hash.replace(/^#\/?/, "").split(/[/#?]/)[0] === "how" ? "how" : "play");
