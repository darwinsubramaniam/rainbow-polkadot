#!/usr/bin/env node
// E0.3 — determine empirically what Acurast's `signer_sign` does with its input.
//
// EIP-712 needs a signature over keccak256(0x1901 || domainSeparator ||
// structHash). If the runtime applies its own hash before signing, the Solidity
// side must compensate. Getting this wrong produces a contract that compiles,
// deploys, and then silently rejects every attestation forever — so it is
// settled by experiment, never by assumption.
//
// The Node.js runtime is documented to force an envelope
// (keccak256("acusig" || SCRIPT_HASH || msg)). The Cargo/Shell runtime's
// `signer_sign` is documented as signing "a hex-encoded byte string" with no
// stated envelope. This checks which is actually true.
//
//   node verify.mjs report.json
//   curl -s https://<tunnel>/report | node verify.mjs
//   node verify.mjs --selftest      # validate the detector itself

import { readFileSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

const strip = (h) => String(h ?? "").replace(/^0x/, "").toLowerCase();

/** Ethereum address = last 20 bytes of keccak256(uncompressed pubkey minus 0x04). */
function toAddress(pubHex) {
  const pt = secp256k1.Point.fromHex(strip(pubHex));
  const uncompressed = pt.toBytes(false).slice(1);
  return "0x" + bytesToHex(keccak_256(uncompressed).slice(-20));
}

/**
 * Try to recover `expectedAddr` from `sigHex` over `msgHash`.
 *
 * Acurast returns raw signature bytes without documenting the layout, so try
 * every plausible one: 64-byte r||s with both recovery ids, and 65-byte with
 * the recovery byte either leading or trailing, normalised from 27/28 if need be.
 */
function recovers(sigHex, msgHash, expectedAddr) {
  const sig = hexToBytes(strip(sigHex));
  const attempts = [];

  if (sig.length === 64) {
    for (const rec of [0, 1]) attempts.push({ rec, rs: sig, layout: "r||s" });
  } else if (sig.length === 65) {
    const trailing = sig[64];
    const leading = sig[0];
    const norm = (v) => (v >= 27 ? v - 27 : v) & 1;
    attempts.push({ rec: norm(trailing), rs: sig.slice(0, 64), layout: "r||s||v" });
    attempts.push({ rec: 1 - norm(trailing), rs: sig.slice(0, 64), layout: "r||s||v(flipped)" });
    attempts.push({ rec: norm(leading), rs: sig.slice(1), layout: "v||r||s" });
    attempts.push({ rec: 1 - norm(leading), rs: sig.slice(1), layout: "v||r||s(flipped)" });
  } else {
    return null;
  }

  for (const a of attempts) {
    try {
      // noble v2 "recovered" format is [recovery, r(32), s(32)].
      const packed = new Uint8Array(65);
      packed[0] = a.rec;
      packed.set(a.rs, 1);
      const pub = secp256k1.recoverPublicKey(packed, msgHash, { prehash: false });
      const addr = toAddress(bytesToHex(pub));
      if (addr.toLowerCase() === expectedAddr.toLowerCase()) {
        return { recoveryId: a.rec, layout: a.layout, address: addr };
      }
    } catch {}
  }
  return null;
}

/** Candidate pre-hash strategies the runtime might apply to `bytes`. */
const HYPOTHESES = [
  {
    id: "raw32",
    label: "signs the input bytes directly as a pre-computed digest",
    verdict: "EIP-712 works as designed — pass the typed-data digest straight in",
    apply: (b) => b,
  },
  {
    id: "keccak256",
    label: "keccak256(input), then signs",
    verdict: "the contract must hash once more, or the job must pass a pre-image",
    apply: (b) => keccak_256(b),
  },
  {
    id: "sha256",
    label: "sha256(input), then signs",
    verdict: "plain ECDSA.recover over the EIP-712 digest will NOT work",
    apply: (b) => sha256(b),
  },
  {
    id: "eth_personal",
    label: 'keccak256("\\x19Ethereum Signed Message:\\n" + len + input)',
    verdict: "use ECDSA.toEthSignedMessageHash() in the contract",
    apply: (b) => {
      const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${b.length}`);
      const joined = new Uint8Array(prefix.length + b.length);
      joined.set(prefix, 0);
      joined.set(b, prefix.length);
      return keccak_256(joined);
    },
  },
];

// ---------------------------------------------------------------------------
// Self-test: prove the detector can actually distinguish the hypotheses.
// A detector that always reports "raw32" would send us down the wrong path
// with full confidence, so validate it against known-answer cases first.
// ---------------------------------------------------------------------------
function selftest() {
  const priv = secp256k1.utils.randomSecretKey();
  const pub = bytesToHex(secp256k1.getPublicKey(priv, true));
  const addr = toAddress(pub);
  const input = hexToBytes("1901" + "ab".repeat(30));

  let failures = 0;
  for (const h of HYPOTHESES) {
    const sig = secp256k1.sign(h.apply(input), priv, { prehash: false, format: "recovered" });
    // Re-pack as trailing-v, the layout most producers emit, to exercise the
    // layout search rather than the format we happened to generate.
    const rs = sig.slice(1);
    const trailing = new Uint8Array(65);
    trailing.set(rs, 0);
    trailing[64] = sig[0];

    const matched = HYPOTHESES.filter(
      (cand) => recovers(bytesToHex(trailing), cand.apply(input), addr) !== null,
    ).map((c) => c.id);

    const ok = matched.length === 1 && matched[0] === h.id;
    console.log(`  ${ok ? "PASS" : "FAIL"}  signed as ${h.id.padEnd(13)} -> detected [${matched.join(", ") || "none"}]`);
    if (!ok) failures++;
  }

  // A wrong key must not match anything.
  const other = secp256k1.utils.randomSecretKey();
  const otherAddr = toAddress(bytesToHex(secp256k1.getPublicKey(other, true)));
  const sig = secp256k1.sign(input, priv, { prehash: false, format: "recovered" });
  const rs = new Uint8Array(65);
  rs.set(sig.slice(1), 0);
  rs[64] = sig[0];
  const wrong = HYPOTHESES.some((c) => recovers(bytesToHex(rs), c.apply(input), otherAddr));
  console.log(`  ${wrong ? "FAIL" : "PASS"}  signature from a different key matches nothing`);
  if (wrong) failures++;

  console.log(failures === 0 ? "\nself-test PASSED\n" : `\nself-test FAILED (${failures})\n`);
  return failures === 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
if (process.argv.includes("--selftest")) {
  console.log("E0.3 detector self-test — can it tell the hypotheses apart?\n");
  process.exit(selftest() ? 0 : 1);
}

const report = process.argv[2]
  ? JSON.parse(readFileSync(process.argv[2], "utf8"))
  : JSON.parse(readFileSync(0, "utf8"));

const dep = report.deploymentPublicKeys?.result?.publicKeys ?? {};
const signer = report.signerPublicKeySecp256k1?.result ?? {};
const pubHex = dep.secp256k1 ?? signer.publicKey;

if (!pubHex) {
  console.error("No secp256k1 public key in the report. Raw fields:");
  console.error(JSON.stringify({ dep, signer }, null, 2).slice(0, 900));
  process.exit(1);
}

const address = toAddress(pubHex);
console.log("E0.3 — signer_sign semantics\n");
console.log(`secp256k1 pubkey : 0x${strip(pubHex)}`);
console.log(`ethereum address : ${address}`);
console.log("  ^ this is the value that goes into the contract's isVerifier set\n");

const sigs = report.signatures ?? {};
let solved = null;
let layout = null;

for (const [name, entry] of Object.entries(sigs)) {
  if (!entry?.signature) {
    console.log(`${name}: NO SIGNATURE — ${JSON.stringify(entry?.error ?? entry).slice(0, 200)}`);
    continue;
  }
  const input = hexToBytes(strip(entry.input));
  console.log(`${name}: input ${input.length}B, signature ${entry.signatureBytes}B`);
  let any = false;
  for (const h of HYPOTHESES) {
    const hit = recovers(entry.signature, h.apply(input), address);
    if (hit) {
      any = true;
      console.log(`   MATCH ${h.id.padEnd(13)} layout=${hit.layout} recoveryId=${hit.recoveryId} — ${h.label}`);
      if (!solved) { solved = h; layout = hit.layout; }
    }
  }
  if (!any) console.log("   no hypothesis matched this signature");
  console.log();
}

if (sigs.digest32?.signature && sigs.digest32_again?.signature) {
  const same = strip(sigs.digest32.signature) === strip(sigs.digest32_again.signature);
  console.log(`nonce generation : ${same ? "deterministic (RFC 6979)" : "randomised k"}\n`);
}

// The 5-byte probe. Be careful with this one: "it signed a non-32-byte input"
// does NOT by itself prove the runtime hashes, because it may equally have
// padded or truncated to 32 bytes. Only a hypothesis match is real evidence.
const short = sigs.short5;
if (short) {
  if (!short.signature) {
    console.log("5-byte input REJECTED — consistent with expecting a pre-computed 32-byte digest");
  } else {
    const shortInput = hexToBytes(strip(short.input));
    const hashingMatch = HYPOTHESES.filter((h) => h.id !== "raw32").find(
      (h) => recovers(short.signature, h.apply(shortInput), address),
    );
    if (hashingMatch) {
      console.log(`5-byte input signed via ${hashingMatch.id} — the runtime hashes its input`);
    } else {
      console.log(
        "5-byte input signed, but under no tested hypothesis — the runtime likely\n" +
          "pads or truncates short inputs to 32 bytes. Inconclusive on its own;\n" +
          "trust the 32-byte result above.",
      );
    }
  }
  console.log();
}

console.log("=".repeat(70));
if (solved) {
  console.log(`CONCLUSION : signer_sign ${solved.label}.`);
  console.log(`SIG LAYOUT : ${layout}`);
  console.log(`CONTRACT   : ${solved.verdict}`);
  console.log("=".repeat(70));
  if (solved.id === "raw32") {
    console.log(`
Goal.md's design stands unchanged. The enclave computes
    digest = keccak256(0x1901 || domainSeparator || structHash)
passes those 32 bytes to signer_sign, and the contract verifies with
    ECDSA.recover(_hashTypedDataV4(structHash), sig)

${layout === "r||s" ? "signer_sign returned 64 bytes (r||s), so the job MUST append the\nrecovery id to make the 65-byte signature ECDSA.recover expects." : `signature layout is ${layout} — normalise to r||s||v (v in {27,28}) before\npassing it to OpenZeppelin's ECDSA.`}`);
  }
} else {
  console.log("NO HYPOTHESIS MATCHED — do not design the contract yet.");
  console.log("Most likely the Shell runtime also applies the Node runtime's");
  console.log('envelope: keccak256("acusig" || SCRIPT_HASH || input).');
  console.log("Re-run with the deployment's script hash (its IPFS hash) to test that.");
}
console.log("=".repeat(70));
