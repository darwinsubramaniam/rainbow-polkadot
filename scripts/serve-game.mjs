#!/usr/bin/env node
// Dev server for the browser game.
//
//   node scripts/serve-game.mjs --verifier https://<tunnel> [--player 0x…] [--port 8080]
//
// Three jobs, and it is worth being precise about why each one is here rather
// than in the page itself:
//
//   1. Serve web/ over HTTP. `sim.wasm` has to arrive with the right MIME type
//      for instantiateStreaming, and a file:// page cannot fetch it at all.
//
//   2. Relay /session and /attest to the enclave. The verifier already sends
//      permissive CORS headers, so this is not strictly required — but routing
//      through here means the browser never needs to know the tunnel URL's
//      shape, and a tunnel that drops CORS on a bad day does not break the game.
//
//   3. Land the transaction. Submitting touches a Substrate-mapped account via
//      papi (see revive-call.mjs); there is no browser wallet that can sign for
//      it. So the page hands the finished attestation here and this process
//      relays it on-chain.
//
// This server is a convenience, not a trusted component. It never sees a score
// it can influence: the attestation is signed inside the enclave and the
// contract checks that signature. The worst a compromised relay can do is
// refuse to submit, or submit an attestation it was given — which is exactly
// what it was asked to do.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const PORT = Number(arg("port", "8080"));
const VERIFIER = (arg("verifier", "") || "").replace(/\/$/, "");
const PLAYER = arg("player", "0x00000000000000000000000000000000000000A1");
const CONTRACT = arg("contract", "0x9cc62a70E0d2ed75432C3d9c1F997a122eE976a0");
const RPC = arg("rpc", "https://paseo-assethub-rpc.laissez-faire.trade");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, "..", "web");
const WASM_SRC = path.join(
  HERE,
  "..",
  "target",
  "wasm32-unknown-unknown",
  "release",
  "sim_wasm.wasm",
);

const cast = (...args) =>
  execFileSync("cast", args, {encoding: "utf8", env: process.env}).trim();

const addressOf = (pub) =>
  "0x" +
  bytesToHex(
    keccak_256(
      secp256k1.Point.fromHex(pub.replace(/^0x/, "")).toBytes(false).slice(1),
    ).slice(-20),
  );

// ---------------------------------------------------------------------------
// Enclave relay
// ---------------------------------------------------------------------------

/** Where to send enclave traffic: whatever the page asked for, else the flag. */
const verifierFor = (body) => {
  const v = (body?.verifier || VERIFIER || "").replace(/\/$/, "");
  if (!v) throw new Error("no verifier URL configured — pass --verifier or set it in the page");
  return v;
};

async function forward(body, route, fields) {
  const target = verifierFor(body);
  const payload = Object.fromEntries(fields.map((f) => [f, body[f]]));
  const r = await fetch(`${target}${route}`, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify(payload),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j;
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

/**
 * Rebuild the recovery id and land the attestation on-chain.
 *
 * `signer_sign` returns 64 bytes of r||s with no recovery id (measured in E0.3),
 * so `v` is found by trying both candidates and keeping the one that recovers to
 * the enclave's published address. Guessing wrong is not a risk: a wrong `v`
 * recovers to a different address, the contract's `isVerifier` check fails, and
 * the submission reverts rather than being accepted as someone else's.
 */
async function submit(body) {
  const att = body?.attestation;
  if (!att?.claim || !att?.signature) throw new Error("no attestation supplied");

  const target = verifierFor(body);
  const id = await (await fetch(`${target}/identity`)).json();
  const encAddr = addressOf(id.secp256k1);

  const rs = hexToBytes(att.signature.replace(/^0x/, ""));
  if (rs.length !== 64) throw new Error(`expected 64-byte r||s, got ${rs.length}`);

  let v = null;
  for (const rec of [0, 1]) {
    const packed = new Uint8Array(65);
    packed[0] = rec;
    packed.set(rs, 1);
    try {
      const pub = secp256k1.recoverPublicKey(
        packed,
        hexToBytes(att.digest.replace(/^0x/, "")),
        {prehash: false},
      );
      if (addressOf(bytesToHex(pub)).toLowerCase() === encAddr.toLowerCase()) {
        v = 27 + rec;
        break;
      }
    } catch {}
  }
  if (v === null) throw new Error("no recovery id yields the enclave address");

  const sig65 = "0x" + bytesToHex(rs) + v.toString(16).padStart(2, "0");
  const c = att.claim;
  const tuple = `(${c.player},${c.gameId},${c.score},${c.epoch},${c.k},${c.rulesHash},${c.expiry})`;
  const data = cast(
    "calldata",
    "submit((address,uint64,uint64,uint64,uint32,bytes32,uint64),bytes)",
    tuple,
    sig65,
  );

  const output = execFileSync(
    "node",
    [path.join(HERE, "revive-call.mjs"), "--to", CONTRACT, "--data", data],
    {encoding: "utf8", env: process.env},
  );

  const best = cast(
    "call",
    CONTRACT,
    "best(uint64,address)(uint64)",
    String(c.gameId),
    c.player,
    "--rpc-url",
    RPC,
  );
  const bestVal = best.split(/\s/)[0];

  return {
    v,
    output: output.trim(),
    best: bestVal,
    matches: bestVal === String(c.score),
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
};

const send = (res, code, obj) => {
  res.writeHead(code, {"content-type": "application/json"});
  res.end(JSON.stringify(obj, null, 2));
};

const readBody = (req) =>
  new Promise((resolve) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      try {
        resolve(JSON.parse(b || "{}"));
      } catch {
        resolve({});
      }
    });
  });

const ROUTES = {
  "/api/session": (b) => forward(b, "/session", ["player", "k"]),
  "/api/attest": (b) => forward(b, "/attest", ["player", "epoch", "k", "inputLog"]),
  "/api/submit": submit,
};

http
  .createServer(async (req, res) => {
    const url = (req.url ?? "/").split("?")[0];

    if (url === "/api/config") {
      return send(res, 200, {verifier: VERIFIER, player: PLAYER, contract: CONTRACT});
    }

    const route = ROUTES[url];
    if (route) {
      if (req.method !== "POST") return send(res, 405, {error: "POST only"});
      try {
        return send(res, 200, await route(await readBody(req)));
      } catch (e) {
        // stderr from a failed `cast`/papi call is far more useful than the
        // Error's own message, which is just the exit status.
        const detail = e.stderr?.toString?.().trim();
        return send(res, 400, {error: detail ? `${e.message}\n${detail}` : e.message});
      }
    }

    // -- static ------------------------------------------------------------
    try {
      // sim.wasm is served straight from the cargo output rather than copied
      // into web/, so the page can never be running a stale build of the rules.
      if (url === "/sim.wasm") {
        const buf = await readFile(WASM_SRC);
        res.writeHead(200, {"content-type": "application/wasm"});
        return res.end(buf);
      }

      const rel = url === "/" ? "index.html" : url.replace(/^\//, "");
      const file = path.join(WEB, rel);
      if (!file.startsWith(WEB)) return send(res, 403, {error: "nope"});

      const buf = await readFile(file);
      res.writeHead(200, {"content-type": TYPES[path.extname(file)] ?? "application/octet-stream"});
      res.end(buf);
    } catch {
      send(res, 404, {error: "not found"});
    }
  })
  .listen(PORT, () => {
    console.log(`rainbow game    http://localhost:${PORT}`);
    console.log(`verifier        ${VERIFIER || "(none — set it in the page)"}`);
    console.log(`contract        ${CONTRACT}`);
    console.log(`sim.wasm        ${WASM_SRC}`);
  });
