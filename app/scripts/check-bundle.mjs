// Fail the build if the bundle contains a chain connection or a signer of its own.
//
// A Product is supposed to get every chain connection and every signature from
// the host container. A review flagged this app for "direct chain access" and
// was wrong about the mechanism — there has never been a WebSocket here — but
// right that something had leaked: the SDK's `DevProvider`, with its dev seed
// phrase and keypair derivation, was being constructed at module load and so
// shipped in the published bundle. See `docs/host-api-conformance.md`.
//
// The gate that fixed it is one ternary on `import.meta.env.DEV`, which is the
// kind of thing a later refactor removes without noticing. Grepping the built
// artifact is the only check that cannot be fooled by intent: whatever the
// source says, these bytes are what gets uploaded to the Bulletin chain and run
// inside someone's wallet.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "..", "dist");

// Two groups, reported separately, because they answer different questions: the
// first is "does this app talk to a chain behind the host's back", the second is
// "does this app hold keys". A reviewer asks both.
const BANNED = [
  {
    what: "direct chain access",
    why: "chain connections must come from `app.chain`, which routes through the host",
    patterns: [
      "wss://",
      "ws://",
      "getWsProvider",
      "WsProvider",
      "ApiPromise",
      "@polkadot/api",
      "smoldot",
      "new WebSocket",
    ],
  },
  {
    what: "local signer",
    why: "the app must construct no signer of its own; the host lends the only one",
    patterns: ["Rainbow (dev)"],
  },
];

// On the narrowness of that second list, which is one string:
//
// The obvious markers — `Ferdie`, the SDK's dev seed phrase, the `DevProvider`
// class itself — are all present in a correct build and cannot be removed.
// `SignerManager.createProvider()` has a `case "dev": return new DevProvider(…)`
// arm (`@parity/product-sdk-signer/dist/index.js:822`), so the class is
// reachable from the host path and no bundler will ever shake it out. Every
// Product built on this SDK ships those bytes.
//
// What that arm needs is an explicit `connect("dev")`. The app only ever calls
// `connect()`, which defaults to the host provider. So the question worth
// asking of a bundle is not "are the dev bytes present" — they always are — but
// "does this app build a dev signer". `dappName: "Rainbow (dev)"` is the string
// that answers it, and it is ours, so it survives minification intact.
//
// Also deliberately absent: `sr25519`, `mnemonic`, `entropy`. Same reasoning —
// `@parity/product-sdk-contracts` pulls hdkd-helpers legitimately, and
// `entropy` appears in the chain-metadata descriptor chunks. A check that
// fires on every correct build gets `--no-verify`'d, which is worse than no
// check at all.

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    // The publish step leaves its receipts here; they are not shipped code.
    if (entry === ".bulletin-deploy") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.(js|html)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

let files;
try {
  files = walk(DIST);
} catch {
  console.error(`\ncheck-bundle: cannot read ${DIST}`);
  console.error("Build it first:\n  npm run build\n");
  process.exit(1);
}

// A stale or half-written dist would otherwise pass by having nothing to find,
// which is the one failure mode a grep-based check is blind to.
if (!files.some((f) => path.basename(f) === "index.html") || files.length < 5) {
  console.error(`\ncheck-bundle: ${DIST} looks empty or stale (${files.length} files, no index.html)`);
  console.error("Rebuild it:\n  rm -rf dist && npm run build\n");
  process.exit(1);
}

const hits = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const group of BANNED) {
    for (const pattern of group.patterns) {
      let at = text.indexOf(pattern);
      while (at !== -1) {
        hits.push({
          group,
          pattern,
          file: path.relative(DIST, file),
          // Enough either side to recognise the call site in minified output.
          window: text.slice(Math.max(0, at - 30), at + pattern.length + 30).replace(/\s+/g, " "),
        });
        at = text.indexOf(pattern, at + pattern.length);
      }
    }
  }
}

if (hits.length === 0) {
  console.log(`check-bundle: ${files.length} files scanned, no direct-chain or local-signer markers`);
  process.exit(0);
}

console.error(`\ncheck-bundle: ${hits.length} banned marker(s) in ${DIST}\n`);
for (const group of BANNED) {
  const mine = hits.filter((h) => h.group === group);
  if (mine.length === 0) continue;
  console.error(`  ${group.what} — ${group.why}`);
  // One example per pattern is enough to find it; minified chunks repeat.
  for (const pattern of new Set(mine.map((h) => h.pattern))) {
    const first = mine.find((h) => h.pattern === pattern);
    const n = mine.filter((h) => h.pattern === pattern).length;
    console.error(`    "${pattern}" ×${n}  ${first.file}`);
    console.error(`      …${first.window}…`);
  }
  console.error("");
}
console.error("Do not publish this bundle. See docs/host-api-conformance.md.\n");
process.exit(1);
