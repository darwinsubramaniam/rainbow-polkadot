#!/bin/sh
# tunnel.sh — expose the verifier through Cloudflare, and refuse to serve under
# an identity that is not ours.
#
# Sets TUNNEL_PID (reaped by the bootstrap's EXIT trap) and TUNNEL_URL.

CF_BIN=/tmp/cloudflared
CF_LOG=/tmp/cf.log

install_cloudflared() {
  # Test hook, honoured only when a binary has already been placed at CF_BIN.
  # The local Docker harness uses it to exercise the tunnel branch without
  # minting a real public hostname; in a deployment nothing sets this and the
  # download below is the only path.
  if [ "${CF_SKIP_DOWNLOAD:-0}" = "1" ] && [ -x "$CF_BIN" ]; then
    note "tunnel" "using pre-placed $CF_BIN (CF_SKIP_DOWNLOAD=1 — local harness)"
    return 0
  fi

  # No apt package for it; fetch the static arm64 binary.
  if ! curl -m 180 -sfL -o "$CF_BIN" \
    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64
  then
    fail "tunnel" "cloudflared download failed"
    return 1
  fi
  chmod +x "$CF_BIN"
  note "tunnel" "cloudflared $("$CF_BIN" --version 2>&1 | head -1)"
  return 0
}

# A named tunnel we own. The public hostname is configured once in the Zero
# Trust dashboard and routed to http://localhost:$PORT *as resolved on whichever
# connector is currently attached* — so the URL survives this job ending,
# restarting, or being reassigned to another phone. That is the whole point: the
# app stops needing to be told a fresh hostname every run.
#
# The token is base64 JSON {"a":account,"t":tunnelId,"s":secret}, delivered
# encrypted via includeEnvironmentVariables. Never echo it into the log.
#
# GOTCHA 7: flag order. `--no-autoupdate` is a `tunnel` flag; placed after `run`,
# cloudflared dumps its help text and exits 1.
_start_named() {
  "$CF_BIN" tunnel --no-autoupdate run --token "$CF_TUNNEL_TOKEN" >"$CF_LOG" 2>&1 &
  TUNNEL_PID=$!
  sleep 8

  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    TUNNEL_URL=""
    fail "tunnel" "cloudflared exited: $(tail -20 "$CF_LOG" 2>/dev/null | esc)"
  elif [ -n "${VERIFIER_HOSTNAME:-}" ]; then
    TUNNEL_URL="https://$VERIFIER_HOSTNAME"
    note "tunnel" "READY $TUNNEL_URL (named)"
  else
    # The connector is up and the dashboard's hostname is already serving it; we
    # just have no way to name it in this report.
    TUNNEL_URL=""
    note "tunnel" "connector up, but VERIFIER_HOSTNAME is unset — set it to have the URL reported here"
  fi
}

# Fallback: an unauthenticated quick tunnel. No account, no DNS, no token — but
# the hostname is minted at boot and dies with the job, so someone has to read
# it out of this webhook and paste it into the app.
_start_quick() {
  "$CF_BIN" tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" >"$CF_LOG" 2>&1 &
  TUNNEL_PID=$!

  TUNNEL_URL=""
  i=0
  while [ $i -lt 40 ]; do
    TUNNEL_URL="$(grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "$CF_LOG" 2>/dev/null | head -1)"
    [ -n "$TUNNEL_URL" ] && break
    i=$((i + 1))
    sleep 3
  done

  if [ -n "$TUNNEL_URL" ]; then
    note "tunnel" "READY $TUNNEL_URL (quick — per-run hostname)"
  else
    fail "tunnel" "no hostname; cf.log: $(tail -20 "$CF_LOG" 2>/dev/null | esc)"
  fi
}

start_tunnel() {
  TUNNEL_URL=""
  install_cloudflared || return 0   # reported; the server is still useful locally

  if [ -n "${CF_TUNNEL_TOKEN:-}" ]; then
    _start_named
  else
    _start_quick
  fi
  return 0
}

# Ask a base URL who it is. Empty if it will not say.
_key_of() { # base-url -> secp256k1 hex, or empty
  curl -m 20 -s "$1/identity" 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try { process.stdout.write(String(JSON.parse(s).secp256k1 ?? "")); } catch {}
    });' 2>/dev/null
}

# A named tunnel accepts any number of connectors and load-balances across them.
# For a stateless website that is free redundancy; here it is a correctness bug.
# Every deployment mints its own secp256k1 key, so a connector left behind by a
# previous job would answer some fraction of requests with a signer the client
# never pinned — and the attestation is then rejected on-chain with nothing in
# either log to say which half of the round trip was wrong.
#
# So ask the public hostname who it is and compare with the local process. Same
# key means we are the only connector. Different means withdraw, rather than
# serve half the traffic under an identity that is not ours.
assert_sole_connector() {
  [ -n "${CF_TUNNEL_TOKEN:-}" ] || return 0
  [ -n "${TUNNEL_URL:-}" ]      || return 0

  local_key="$(_key_of "http://127.0.0.1:$PORT")"
  if [ -z "$local_key" ]; then
    # Nothing to compare against — and an empty string would differ from a
    # perfectly healthy edge answer and tear down our own tunnel. Skip the check
    # rather than act on a comparison that cannot be trusted.
    note "tunnel" "WARN local /identity returned no signer — skipping the single-connector check"
    return 0
  fi

  edge_key=""
  i=0
  while [ $i -lt 6 ]; do
    edge_key="$(_key_of "$TUNNEL_URL")"
    [ -n "$edge_key" ] && break
    i=$((i + 1))
    sleep 5
  done

  if [ -z "$edge_key" ]; then
    # Not fatal, and retrying further will not help: on first setup this is
    # almost always the public hostname route or the CNAME missing in the
    # dashboard, which is fixed there, not here.
    note "tunnel" "WARN $TUNNEL_URL did not answer /identity — check the public hostname route and the CNAME to <tunnel-id>.cfargotunnel.com"
    return 0
  fi

  if [ "$edge_key" != "$local_key" ]; then
    fail "tunnel" "another connector already serves $TUNNEL_URL (edge signer $edge_key, ours $local_key) — withdrawing to keep the hostname single-signer"
    kill "$TUNNEL_PID" 2>/dev/null
    return 1
  fi

  note "tunnel" "sole connector on $TUNNEL_URL (signer $local_key)"
  return 0
}
