#!/usr/bin/env node
// Mock Acurast bridge for local iteration on verifier.mjs.
//
// Binds the abstract Unix socket the runtime provides and answers the JSON-RPC
// methods the verifier uses. `signer_sign` returns a deterministic fake — real
// signatures are not needed to validate the part that matters locally, which is
// that the EIP-712 digest the enclave computes matches the deployed contract's
// `scoreDigest`. A mismatch there would make every attestation fail on-chain
// with no useful error, so it is worth catching before spending a deploy.

import net from "node:net";
import crypto from "node:crypto";

const SOCKET = process.env.BRIDGE_SOCKET ?? "acurast-mock";

// Deterministic stand-in: sha512(input) truncated to 64 bytes, so repeat calls
// match (mirroring the real RFC 6979 behaviour measured in E0.3).
const fakeSign = (hex) =>
  crypto.createHash("sha512").update(Buffer.from(hex, "hex")).digest().subarray(0, 64)
    .toString("hex");

const handle = (req) => {
  const id = req.id ?? "1";
  const ok = (result) => ({jsonrpc: "2.0", result, id});
  const p = (req.params ?? [{}])[0] ?? {};
  switch (req.method) {
    case "processor_version":
      return ok({version: "1.26.0-canary-mock"});
    case "deployment_publicKeys":
      return ok({publicKeys: {secp256k1: "02" + "11".repeat(32)}});
    case "signer_publicKey":
      return ok({publicKey: "02" + "11".repeat(32)});
    case "signer_sign":
      return ok({bytes: fakeSign(p.bytes ?? "")});
    default:
      return {jsonrpc: "2.0", error: {code: -32601, message: "Method not found"}, id};
  }
};

net.createServer((sock) => {
  let buf = "";
  sock.on("data", (d) => {
    buf += d.toString();
    if (!buf.includes("\n")) return;
    try {
      sock.write(JSON.stringify(handle(JSON.parse(buf.trim()))) + "\n");
    } catch (e) {
      sock.write(JSON.stringify({jsonrpc: "2.0", error: String(e), id: "1"}) + "\n");
    }
    sock.end();
  });
}).listen("\0" + SOCKET, () =>
  console.log(`[mock-bridge] listening on abstract socket \\0${SOCKET}`));
