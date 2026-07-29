import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Chain metadata this app actually connects to.
 *
 * The SDK reaches every supported chain through dynamic imports keyed by
 * environment, so Rollup emits a chunk for all of them — Kusama, Polkadot,
 * Paseo, plus Bulletin and Individuality for each. That is ~6 MB of the build
 * for chains this app never opens a connection to.
 *
 * It matters because the bundle is uploaded to the Bulletin chain against a
 * *byte quota*, not a fee: the deploying account here is authorized for 20 MB,
 * so shipping the dead metadata would leave room for barely two deploys.
 */
const USED_METADATA = ["devnet_asset_hub"];

/**
 * Replace unused chain metadata with an empty module.
 *
 * Deliberately narrow: it matches only the descriptors package's generated
 * `*_metadata` modules, and only those not on the allowlist above. Anything
 * that then tried to connect to a stubbed chain would fail loudly at that call
 * rather than silently misbehave — and nothing in this app does, because the
 * only `chain.connect` is Asset Hub on devnet.
 */
function dropUnusedChainMetadata(): Plugin {
  const dropped = new Set<string>();

  return {
    name: "rainbow:drop-unused-chain-metadata",
    apply: "build",
    enforce: "pre",
    load(id) {
      const m = /([a-z0-9]+_(?:asset_hub|bulletin|individuality))_metadata/.exec(id);
      if (!m || !id.includes("product-sdk-descriptors")) return null;

      const chain = m[1]!;
      if (USED_METADATA.includes(chain)) return null;

      dropped.add(chain);
      return "export default undefined;";
    },
    buildEnd() {
      if (dropped.size) {
        this.info(`dropped unused chain metadata: ${[...dropped].sort().join(", ")}`);
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), dropUnusedChainMetadata()],

  // Relative asset URLs. A published Product is resolved client-side by the
  // gateway and served out of a service-worker VFS rather than from a real
  // origin root, so absolute "/assets/…" paths do not reliably resolve.
  base: "./",

  build: {
    outDir: "dist",
    // The bundle is uploaded to the Bulletin chain against a byte quota, so
    // size is a real constraint rather than a nicety. Inlining is disabled for
    // sim.wasm's sake — it must stay a separate fetchable artifact whose bytes
    // hash to the on-chain rulesHash.
    assetsInlineLimit: 0,
    target: "es2022",
    sourcemap: false,
  },

  server: { port: 5173 },
});
