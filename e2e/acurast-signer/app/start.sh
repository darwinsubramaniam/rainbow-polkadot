#!/bin/sh
# Entrypoint for the E0.3 / E0.4 Acurast Shell deployment.
#
# Every workaround below is here because it was needed, not defensively. The
# comments name the failure each one prevents, because from the outside all of
# them look like the job silently doing nothing.
#
# E0.3  Answered by server.py printing a signature report to stdout. It does
#       this FIRST, before any tunnel work, so a tunnel failure cannot take the
#       signing result down with it.
# E0.4  Cloudflare quick tunnel: outbound-only, no CF account, no DNS, and a
#       real certificate a browser will accept.

set -eu

PORT="${PORT:-3000}"
LOG=/tmp/e0-probe.log

# GOTCHA 1: the executor leaks its Android cache path as TMPDIR, and that path
# does not exist inside the rootfs. Every mktemp-based tool then breaks —
# ca-certificates' postinst fails and apt exits 100. Must be the first thing.
export TMPDIR=/tmp
export HOME="${HOME:-/root}"
export DEBIAN_FRONTEND=noninteractive
mkdir -p /tmp

say() {
  echo "[e0] $*" 2>&1 | tee -a "$LOG"
}

# GOTCHA 2: every curl needs -m. A listening-but-unresponsive endpoint hangs an
# un-timeouted request forever and the job goes silent instead of reporting.
notify() {
  [ -n "${WEBHOOK_URL:-}" ] || return 0
  command -v curl >/dev/null 2>&1 || return 0
  curl -m 15 -s -X POST -H 'content-type: application/json' \
    --data "$(printf '{"stage":"%s","detail":"%s"}' "$1" "$(echo "$2" | tr -d '"' | tr '\n' ' ')")" \
    "$WEBHOOK_URL" >/dev/null 2>&1 || true
}

cleanup() {
  say "cleanup: reaping children"
  [ -n "${TUNNEL_PID:-}" ] && kill "$TUNNEL_PID" 2>/dev/null || true
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
}
# GOTCHA 3: without an explicit TERM/INT trap the EXIT trap never runs on
# teardown, and leaked children squat the port for the next run.
trap cleanup EXIT
trap 'exit 143' TERM INT

say "starting; BRIDGE_SOCKET=${BRIDGE_SOCKET:-<unset>} PORT=$PORT"
say "uname: $(uname -a 2>/dev/null || echo unknown)"

# --- dependencies ---------------------------------------------------------
# The base proot image has no curl, no python3, no procps. Nothing can be
# reported to a webhook until curl exists, so failures before this point are
# only visible in stdout via `acurast devtools`.
say "apt: updating"
apt-get update -y >>"$LOG" 2>&1 || say "apt update returned $?"
say "apt: installing python3 curl ca-certificates procps"
apt-get install -y --no-install-recommends \
  python3 curl ca-certificates procps >>"$LOG" 2>&1 || {
  say "apt install FAILED (tail below)"
  tail -30 "$LOG" || true
  exit 1
}
say "python3: $(python3 --version 2>&1)"
notify "deps" "python3 + curl installed"

# --- stage the app --------------------------------------------------------
# GOTCHA 4: the bundle directory may be a bind-mounted Android path with
# symlink quirks. Copy into $HOME before running anything from it.
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
say "bundle dir: $APP_DIR"
mkdir -p "$HOME/app"
cp -f "$APP_DIR/server.py" "$HOME/app/server.py" 2>/dev/null || {
  say "could not stage server.py from $APP_DIR"; ls -la "$APP_DIR" || true; exit 1
}

# --- clear port squatters -------------------------------------------------
# GOTCHA 5: all jobs on a processor share ONE network namespace, so ports are
# global across job sandboxes. A child leaked by a dead run will EADDRINUSE
# this one. /proc/net is blocked so fuser/ss are blind — kill by name.
say "clearing port squatters"
pkill -9 -f "server.py" 2>/dev/null || true
pkill -9 -f "cloudflared" 2>/dev/null || true
sleep 1

# --- E0.3: the signing report --------------------------------------------
# Runs before the tunnel deliberately. The signature result is the answer to
# E0.3 and must not depend on E0.4 succeeding.
say "launching server.py (prints the E0.3 report to stdout first)"
python3 -u "$HOME/app/server.py" 2>&1 | tee -a "$LOG" &
SERVER_PID=$!
sleep 8

if curl -m 10 -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  say "http server is up on $PORT"
  notify "server" "listening on $PORT"
else
  say "WARNING: health check failed; server may still be starting"
  notify "server" "health check failed"
fi

REPORT="$(curl -m 25 -s "http://127.0.0.1:$PORT/report" 2>/dev/null || echo '{}')"
say "--- E0.3 REPORT BEGIN ---"
echo "$REPORT" | tee -a "$LOG"
say "--- E0.3 REPORT END ---"
notify "report" "$(echo "$REPORT" | head -c 1500)"

# --- E0.4: Cloudflare quick tunnel ---------------------------------------
# GOTCHA 6: there is no apt package for cloudflared; fetch the static binary.
say "fetching cloudflared (arm64)"
if curl -m 120 -sfL -o /tmp/cloudflared \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64; then
  chmod +x /tmp/cloudflared
  say "cloudflared: $(/tmp/cloudflared --version 2>&1 | head -1)"

  # GOTCHA 7: flag order matters. `--no-autoupdate` AFTER `run` makes it dump
  # help text and exit 1. A quick tunnel needs no token, no account, no DNS.
  /tmp/cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" \
    >/tmp/cf.log 2>&1 &
  TUNNEL_PID=$!

  say "waiting for the trycloudflare hostname"
  TUNNEL_URL=""
  i=0
  while [ $i -lt 40 ]; do
    TUNNEL_URL="$(grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' /tmp/cf.log 2>/dev/null | head -1 || true)"
    [ -n "$TUNNEL_URL" ] && break
    i=$((i + 1))
    sleep 3
  done

  if [ -n "$TUNNEL_URL" ]; then
    say "TUNNEL READY: $TUNNEL_URL"
    notify "tunnel" "$TUNNEL_URL"
  else
    say "tunnel did NOT come up; cloudflared log tail:"
    tail -25 /tmp/cf.log 2>/dev/null | tee -a "$LOG" || true
    notify "tunnel" "failed to obtain hostname"
  fi
else
  say "cloudflared download FAILED"
  notify "tunnel" "cloudflared download failed"
fi

say "entering serve loop; job ends at maxExecutionTimeInMs"
while kill -0 "$SERVER_PID" 2>/dev/null; do
  sleep 30
  say "heartbeat: server alive${TUNNEL_URL:+ ; $TUNNEL_URL}"
done
say "server exited"
