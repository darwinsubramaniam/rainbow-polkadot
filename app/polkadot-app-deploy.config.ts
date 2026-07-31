/**
 * What the Polkadot app browser shows about this Product.
 *
 * Without this file a deploy publishes the bundle and nothing else: the domain
 * resolves, the app runs, and it appears in a store as a bare name with no icon
 * and no explanation. `pad` walks up from the build directory looking for a
 * `polkadot-app-deploy.config.{ts,js,mjs}`, and when it finds one it also writes
 * the manifest text records — `manifest` on the domain itself, and `executable`
 * on its `app.` subname.
 *
 * Every path here resolves **relative to this file's own directory**, not to the
 * build directory passed on the command line. So `dist` and `public/…` below are
 * `app/dist` and `app/public/…`.
 *
 * No import of `defineConfig`: it is only an identity helper for editor
 * completion, and `pad` is installed globally rather than as a dependency of
 * this package, so importing from it would be a specifier this project cannot
 * resolve. A plain object is exactly what the loader wants.
 *
 * Two constraints worth knowing before editing:
 *
 *   - **The icon must be a PNG or a JPEG.** The schema admits no others, so the
 *     SVG favicon cannot be used here — hence the 180×180 touch icon, which is
 *     already opaque and padded and therefore survives being masked into a
 *     rounded tile.
 *   - **The manifest is a text record with a 1024-byte budget.** That covers the
 *     whole JSON — display name, description, and the icon's CID — so the
 *     description has room to be a sentence or two and not a page.
 */

export default {
  domain: "rainbow-dev.dot",

  displayName: "Rainbow",

  // Kept to the claim the project actually makes. The score is not asserted by
  // the player and not taken on trust from a server; it is recomputed by
  // hardware neither of them controls, and checked on-chain.
  description:
    "A platformer whose score is proven, not claimed. Play a run, then watch a TEE on the Acurast network replay your keypresses, recompute the score itself, and sign it for a contract on Polkadot Asset Hub.",

  icon: {
    path: "public/apple-touch-icon.png",
    format: "png",
  },

  executables: [
    {
      kind: "app",
      // A directory is allowed here, and is the same `dist` handed to `pad`.
      path: "dist",
      // [major, minor, patch]. Bump this together with the version in
      // package.json — this is the number the store compares across deploys.
      appVersion: [0, 1, 0],
    },
  ],
} as const;
