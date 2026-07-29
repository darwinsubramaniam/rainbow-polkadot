#!/usr/bin/env python3
"""E0.3 + E0.4 probe running inside an Acurast Shell deployment.

Answers two questions that the contract design depends on:

E0.3  Does `signer_sign` hash its input, or sign the 32 bytes it is given as a
      pre-computed digest?  EIP-712 requires a signature over
      keccak256(0x1901 || domainSeparator || structHash).  If the runtime
      applies its own hash, the Solidity side has to compensate, and getting
      this wrong produces a contract that silently never verifies anything.
      We do not guess: we sign several inputs and let the host work out which
      hypothesis survives.

E0.4  Can a Shell job expose an HTTPS endpoint a *browser* will accept?  The
      Acurast native tunnel needs Android build 122, which is ~7 devices
      network-wide.  A Cloudflare quick tunnel needs only outbound network and
      yields a real certificate.

Protocol per the Cargo runtime docs: abstract Unix socket at "\\0$BRIDGE_SOCKET",
JSON-RPC 2.0, newline-delimited, **one call per connection**.
"""

import json
import os
import socket
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(os.environ.get("PORT", "3000"))

# A fixed, arbitrary 32-byte value standing in for an EIP-712 digest. Constant
# so results are comparable across runs and devices.
DIGEST32 = "1901" + "a" * 60  # 32 bytes as hex
SHORT_MSG = "deadbeef42"  # 5 bytes: cannot be a digest, so a success here is
# itself evidence that the runtime hashes its input.


def rpc(method, params=None, timeout=20):
    """One JSON-RPC call. New connection each time, as the runtime requires."""
    name = os.environ.get("BRIDGE_SOCKET")
    if not name:
        return {"error": "BRIDGE_SOCKET is not set"}
    req = json.dumps(
        {"jsonrpc": "2.0", "method": method, "params": params or [], "id": "1"}
    )
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(timeout)
        s.connect("\0" + name)
        s.sendall((req + "\n").encode())
        buf = b""
        while not buf.endswith(b"\n"):
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
        s.close()
        return json.loads(buf.decode().strip())
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}"}


def sign(hex_bytes, curve="secp256k1"):
    r = rpc("signer_sign", [{"curve": curve, "bytes": hex_bytes}])
    out = {"input": hex_bytes, "inputBytes": len(hex_bytes) // 2}
    if "result" in r and isinstance(r["result"], dict):
        sig = r["result"].get("bytes")
        out["signature"] = sig
        out["signatureBytes"] = len(sig) // 2 if sig else None
    else:
        out["error"] = r.get("error", r)
    return out


def collect():
    """Everything the host needs to settle E0.3, gathered in one shot."""
    report = {"collectedAt": int(time.time())}

    report["bridgeSocketSet"] = bool(os.environ.get("BRIDGE_SOCKET"))
    report["processorVersion"] = rpc("processor_version")
    report["deploymentId"] = rpc("deployment_getId")
    report["deploymentPublicKeys"] = rpc("deployment_publicKeys")
    report["assignedProcessors"] = rpc("deployment_assignedProcessors")

    # The signing key we would register with the contract's verifier set.
    report["signerPublicKeySecp256k1"] = rpc(
        "signer_publicKey", [{"curve": "secp256k1"}]
    )

    # The E0.3 matrix. Signing the same key over inputs of differing length
    # tells us whether the runtime treats `bytes` as a message or as a digest.
    report["signatures"] = {
        "digest32": sign(DIGEST32),
        "digest32_again": sign(DIGEST32),  # is it deterministic (RFC 6979)?
        "short5": sign(SHORT_MSG),
    }
    return report


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj, indent=2).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        # The browser client is served from a different origin, so the probe
        # needs to be readable cross-origin to be useful from a Product.
        self.send_header("access-control-allow-origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        try:
            path = self.path.split("?")[0]
            if path == "/health":
                self._send(200, {"ok": True, "ts": int(time.time())})
            elif path == "/report":
                self._send(200, collect())
            elif path == "/keys":
                self._send(
                    200,
                    {
                        "deploymentPublicKeys": rpc("deployment_publicKeys"),
                        "signerPublicKeySecp256k1": rpc(
                            "signer_publicKey", [{"curve": "secp256k1"}]
                        ),
                    },
                )
            else:
                self._send(404, {"error": "try /health, /report, /keys"})
        except Exception:
            self._send(500, {"error": traceback.format_exc()[-800:]})

    def log_message(self, fmt, *args):
        sys.stderr.write("[http] " + (fmt % args) + "\n")


def main():
    # Print the report to stdout immediately, so E0.3 has an answer even if the
    # tunnel (E0.4) never comes up. The two experiments must not share a fate.
    try:
        print("=== ACURAST_REPORT_BEGIN ===", flush=True)
        print(json.dumps(collect(), indent=2), flush=True)
        print("=== ACURAST_REPORT_END ===", flush=True)
    except Exception:
        traceback.print_exc()

    # Bind 0.0.0.0 explicitly: the proot's dual-stack "::" binding is unreliable.
    srv = HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[http] listening on 0.0.0.0:{PORT}", flush=True)
    threading.Thread(target=srv.serve_forever, daemon=False).start()


if __name__ == "__main__":
    main()
