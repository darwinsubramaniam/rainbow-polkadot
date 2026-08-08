// Which build is this?
//
// `__BUILD__` is replaced with a literal by `vite.config.ts` — see the long note
// there for why this exists. Kept as a leaf module with no imports so anything
// can report the stamp, including error paths that run before the app is up.

export interface BuildStamp {
  /** `package.json` version. Coarse — it rarely moves. */
  version: string;
  /** Short git sha, plus `+dirty` when the tree had uncommitted changes. */
  commit: string;
  /** ISO build time, to the second. The only field guaranteed to differ per deploy. */
  at: string;
  /** Host-protocol-bearing SDK ranges, as declared in `package.json`. */
  sdk: { core: string; tx: string };
}

/**
 * The stamp, or a harmless stand-in.
 *
 * `__BUILD__` is a compile-time substitution, so it is simply absent anywhere
 * the `define` did not run — most commonly a `vite dev` server that was already
 * running when the config gained it, but equally a unit test importing this
 * module directly.
 *
 * The fallback is not decoration. Reading through to an undefined `__BUILD__`
 * throws at module scope, and `main.tsx` logs the stamp before React mounts, so
 * a missing define would take the whole app down and show nothing but a blank
 * page — a diagnostic aid causing a strictly worse failure than the one it
 * exists to diagnose. `dev` is also honest: an un-stamped bundle is not a
 * deployment and should not claim a version.
 */
export const BUILD: BuildStamp =
  typeof __BUILD__ === "undefined"
    ? { version: "dev", commit: "dev", at: "unstamped", sdk: { core: "dev", tx: "dev" } }
    : __BUILD__;

/**
 * One line, dense enough to paste into a bug report.
 *
 * Deliberately not pretty: this is read when something is wrong, and the useful
 * form is the one that survives being copied out of a console.
 */
export const buildLine = (): string =>
  `rainbow ${BUILD.version} · ${BUILD.commit} · built ${BUILD.at} · sdk ${BUILD.sdk.core}/tx ${BUILD.sdk.tx}`;
