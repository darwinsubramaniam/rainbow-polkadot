#!/usr/bin/env python3
"""Mock Acurast bridge for local iteration on server.py.

Binds an abstract Unix socket and answers the JSON-RPC methods the real
processor exposes, so server.py can be exercised without burning a 30-minute
deployment slot on a syntax error.

It signs with a FIXED throwaway key using the "raw32" convention (input bytes
treated as a pre-computed digest). That makes it a control for verify.mjs: run
the mock's output through the detector and it must report `raw32`. If it does
not, the bug is in our tooling, not in Acurast.

    python3 local-test/mock-bridge.py &
    BRIDGE_SOCKET=acurast-mock PORT=3000 python3 app/server.py

Abstract sockets are Linux-only, so this runs under Docker on macOS:
    ./local-test/test.sh
"""

import json
import os
import socket
import threading

SOCKET_NAME = os.environ.get("BRIDGE_SOCKET", "acurast-mock")

# Fixed test key. Throwaway, never used anywhere real — the point is that the
# host side can predict the address and check recovery against it.
PRIV_HEX = "4c0883a69102937d6231471b5dbb6204fe512961708279cd5e2f2f4a1b2c3d4e"

try:
    from ecdsa import SigningKey, SECP256k1  # type: ignore
    from ecdsa.util import sigencode_string

    _sk = SigningKey.from_string(bytes.fromhex(PRIV_HEX), curve=SECP256k1)
    _pub = b"\x02" + _sk.get_verifying_key().to_string()[:32]
    if _sk.get_verifying_key().to_string()[63] % 2 == 1:
        _pub = b"\x03" + _sk.get_verifying_key().to_string()[:32]
    HAVE_ECDSA = True
except Exception:  # pragma: no cover - dependency is optional
    HAVE_ECDSA = False
    _sk = None
    _pub = b"\x02" + b"\x11" * 32


def handle(req):
    method = req.get("method")
    params = (req.get("params") or [{}])
    p = params[0] if params else {}
    rid = req.get("id", "1")

    def ok(result):
        return {"jsonrpc": "2.0", "result": result, "id": rid}

    if method == "processor_version":
        return ok({"platform": 0, "buildNumber": 128})

    if method == "deployment_getId":
        return ok({"origin": {"kind": "Acurast", "source": "mock"}, "id": "380393"})

    if method == "deployment_publicKeys":
        return ok({"publicKeys": {"secp256k1": _pub.hex()}})

    if method == "signer_publicKey":
        return ok({"publicKey": _pub.hex()})

    if method == "deployment_assignedProcessors":
        return ok({"processors": {"5MockProcessor": {"secp256k1": _pub.hex()}}})

    if method == "signer_sign":
        raw = bytes.fromhex(p.get("bytes", ""))
        if not HAVE_ECDSA:
            return {"jsonrpc": "2.0", "error": "ecdsa module unavailable", "id": rid}
        # "raw32" convention: sign the given bytes as a digest, no extra hashing.
        # Deterministic (RFC 6979) so repeat calls are byte-identical.
        sig = _sk.sign_digest_deterministic(
            raw.ljust(32, b"\0")[:32], sigencode=sigencode_string
        )
        return ok({"bytes": sig.hex()})

    return {"jsonrpc": "2.0", "error": f"unknown method {method}", "id": rid}


def serve():
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.bind("\0" + SOCKET_NAME)
    s.listen(16)
    print(f"[mock-bridge] listening on abstract socket \\0{SOCKET_NAME}", flush=True)
    while True:
        conn, _ = s.accept()
        threading.Thread(target=one, args=(conn,), daemon=True).start()


def one(conn):
    try:
        buf = b""
        while not buf.endswith(b"\n"):
            c = conn.recv(65536)
            if not c:
                break
            buf += c
        req = json.loads(buf.decode().strip())
        resp = handle(req)
        conn.sendall((json.dumps(resp) + "\n").encode())
    except Exception as e:
        print("[mock-bridge] error:", e, flush=True)
    finally:
        conn.close()


if __name__ == "__main__":
    serve()
