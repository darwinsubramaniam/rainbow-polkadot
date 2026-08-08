import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * A stamp identifying exactly which build is running.
 *
 * Earned the hard way. A published Product is served out of a service-worker
 * VFS behind a gateway that can pin a CID in the URL, so an ordinary reload
 * will happily keep serving a bundle from several deploys ago — and every
 * symptom then belongs to code that is no longer on disk. Hours went into
 * debugging a submit failure that had already been fixed and republished
 * twice, because nothing on screen said which bundle was answering.
 *
 * So the answer ships *in* the bundle. Read it from the footer or the console
 * before trusting any bug report, including your own.
 *
 * `sdk` is here because it is not incidental: the app talks to Polkadot Desktop
 * over a versioned host protocol, and a mismatch between the two surfaces as a
 * misaligned SCALE decode (`Unknown enum discriminant: N`, N varying per
 * payload) rather than as anything resembling a version error.
 *
 * Note this makes builds non-reproducible on purpose — `at` changes every time,
 * so every build is a distinct CID even when the source did not move. That is
 * the point: a deploy you cannot tell apart from the last one is the failure
 * being fixed. `sim.wasm` is untouched by this and still hashes to the on-chain
 * `rulesHash`.
 */
function buildStamp() {
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

  // Never let stamping break the build: outside a checkout (a tarball, a clean
  // CI export) git is simply absent, and a missing sha is worth far less than a
  // failed deploy.
  const git = (cmd: string, fallback: string) => {
    try {
      return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      return fallback;
    }
  };

  const sha = git("git rev-parse --short HEAD", "nogit");
  // Every deploy so far has been from a dirty tree, which makes the sha alone a
  // half-truth — it names a commit the running code does not match.
  const dirty = git("git status --porcelain", "") !== "" ? "+dirty" : "";

  return {
    version: pkg.version as string,
    commit: `${sha}${dirty}`,
    at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    sdk: {
      core: pkg.dependencies["@parity/product-sdk"] as string,
      tx: pkg.dependencies["@parity/product-sdk-tx"] as string,
    },
  };
}

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
const NETWORK = process.env.VITE_NETWORK ?? "devnet";

if (!["devnet", "paseo", "polkadot"].includes(NETWORK)) {
  throw new Error(`VITE_NETWORK must be devnet, paseo or polkadot — got "${NETWORK}"`);
}

// Derived from the same flag `src/chain/network.ts` reads, so the metadata that
// ships and the chains the app asks for cannot drift apart. Polkadot has no
// Bulletin yet, and `network.ts` disables Cloud Storage there accordingly.
const USED_METADATA = [
  `${NETWORK}_asset_hub`,
  ...(NETWORK === "polkadot" ? [] : [`${NETWORK}_bulletin`]),
];

/**
 * Replace unused chain metadata with an empty module.
 *
 * Deliberately narrow: it matches only the descriptors package's generated
 * `*_metadata` modules, and only those not on the allowlist above. Anything
 * that then tried to connect to a stubbed chain would fail loudly at that call
 * rather than silently misbehave.
 *
 * `devnet_bulletin` is on the allowlist even though no code here calls Cloud
 * Storage, because `createApp` connects Bulletin while constructing the app —
 * see `SdkGate.tsx`. Stubbing it would break host connection itself, which is
 * a far worse failure than a slightly larger bundle: it is the difference
 * between a player landing a score and being told to run a CLI.
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

  // Inlined as a literal at build time, so it costs nothing at runtime and
  // cannot be out of step with the bundle it is describing.
  define: {
    __BUILD__: JSON.stringify(buildStamp()),
  },

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
    // No source maps in a published build, and it is a close call.
    //
    // Against: a Product runs inside someone else's container and the only
    // report you get is its console, which minified reads `TypeError: a is not
    // a function` — no file, no line, no name. Resolving Polkadot Desktop's
    // stack frames against *its* shipped maps is what finally located a fault
    // that had cost most of a day.
    //
    // For: the Bulletin authorization is a byte quota **spent per deploy**, not
    // a per-file cap. Measured, maps take this build from 4.1 MB to 13 MB — two
    // thirds of the 20 MB budget in a single publish, on 50 `.map` files most of
    // which describe generated chain metadata nobody will ever read.
    //
    // The deciding argument is that the debugging channel already exists and is
    // free: Polkadot Desktop loads `localhost` directly, unminified, with real
    // names in the stack. Reproduce there. Flip this to `true` only for a
    // deliberate debugging build, and do not publish it.
    sourcemap: false,
  },

  server: { port: 5173 },
});
