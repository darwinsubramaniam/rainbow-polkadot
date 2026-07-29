#!/bin/sh
# Entrypoint for the E0.3 / E0.4 Acurast Shell deployment.
#
# DESIGN RULE: the webhook is the ONLY channel back. Acurast DevTools targets
# mainnet, so a canary deployment's stdout is unreachable — anything not POSTed
# is lost. Run 1 died between two notifies and left no trace of why. So every
# step reports, and the EXIT trap reports the exit code plus a log tail, which
# turns "the job went silent" into an actual message.
#
# `set -e` is deliberately NOT used. It made run 1 exit silently on a failure
# that was never reported; explicit checks that notify are strictly better here.

set -u

PORT="${PORT:-3000}"
LOG=/tmp/e0-probe.log
: > "$LOG"

# GOTCHA 1: the executor leaks its Android cache path as TMPDIR and that path
# does not exist in the rootfs, so every mktemp-based tool breaks
# (ca-certificates postinst fails, apt exits 100). Must be first.
export TMPDIR=/tmp
export HOME="${HOME:-/root}"
export DEBIAN_FRONTEND=noninteractive
mkdir -p /tmp

say() { echo "[e0] $*" >>"$LOG" 2>&1; echo "[e0] $*"; }

# GOTCHA 2: every curl needs -m. An un-timeouted request to a listening but
# unresponsive endpoint hangs forever and the job goes silent.
post() { # path, body
  command -v curl >/dev/null 2>&1 || return 0
  [ -n "${WEBHOOK_URL:-}" ] || return 0
  curl -m 20 -s -X POST -H 'content-type: application/json' \
    --data-binary "$2" "${WEBHOOK_URL}$1" >/dev/null 2>&1 || true
}

# JSON-safe: strip quotes/backslashes and fold newlines, so a log tail can never
# produce a body the sink refuses to parse.
esc() { tr -d '"\\' | tr '\n\r' '  ' | sed 's/  */ /g' | cut -c1-1200; }

note() { # stage, detail
  say "$1: $2"
  post "" "$(printf '{"stage":"%s","detail":"%s"}' "$1" "$(printf '%s' "$2" | esc)")"
}

fail() { # stage, detail
  say "FAILED $1: $2"
  post "" "$(printf '{"stage":"FAILED:%s","detail":"%s","logTail":"%s"}' \
    "$1" "$(printf '%s' "$2" | esc)" "$(tail -25 "$LOG" | esc)")"
}

on_exit() {
  code=$?
  say "exiting with code $code"
  post "" "$(printf '{"stage":"exit","code":%d,"logTail":"%s"}' \
    "$code" "$(tail -40 "$LOG" | esc)")"
  [ -n "${TUNNEL_PID:-}" ] && kill "$TUNNEL_PID" 2>/dev/null
  [ -n "${PY_PID:-}" ] && kill "$PY_PID" 2>/dev/null
  return 0
}
# GOTCHA 3: without an explicit TERM/INT trap the EXIT trap never runs on
# teardown, so the exit report would be lost exactly when it matters most.
trap on_exit EXIT
trap 'exit 143' TERM INT

say "boot: pwd=$(pwd) \$0=$0 BRIDGE_SOCKET=${BRIDGE_SOCKET:-<unset>} PORT=$PORT"

# --- curl first, so reporting works as early as possible ------------------
# The base proot image has no curl, which means failures before this point can
# only be seen on stdout — which we cannot read. Keep this step minimal.
if ! command -v curl >/dev/null 2>&1; then
  apt-get update -y >>"$LOG" 2>&1
  apt-get install -y --no-install-recommends curl ca-certificates >>"$LOG" 2>&1
fi
if ! command -v curl >/dev/null 2>&1; then
  say "curl unavailable after apt — no channel back, aborting"
  exit 1
fi
note "boot" "curl available; pwd=$(pwd) argv0=$0"

# --- locate the bundle ----------------------------------------------------
# GOTCHA 4: do NOT trust `dirname $0`. It is a `set -e` hazard and the launcher
# may invoke the entrypoint in ways that make it useless. Search instead, and
# report what was actually on disk if the search fails.
SRC=""
for cand in \
  "$(dirname "$0" 2>/dev/null)/verifier.mjs" \
  "./verifier.mjs" \
  "/acurast/app/verifier.mjs" \
  "$HOME/verifier.mjs" \
  "$HOME/app/verifier.mjs"
do
  [ -f "$cand" ] && { SRC="$cand"; break; }
done
if [ -z "$SRC" ]; then
  FOUND="$(find / -name verifier.mjs -maxdepth 6 2>/dev/null | head -5)"
  if [ -n "$FOUND" ]; then
    SRC="$(printf '%s' "$FOUND" | head -1)"
    note "locate" "found via find: $SRC"
  else
    fail "locate" "verifier.mjs not found. cwd listing: $(ls -la . 2>&1 | head -20)"
    exit 1
  fi
fi
note "locate" "verifier.mjs at $SRC"

# GOTCHA 5: the bundle is extracted to /root/app, which IS $HOME/app — so the
# usual "copy out of the bundle dir" step becomes `cp X X` and fails. Copy only
# when the paths genuinely differ; otherwise run in place. (The copy exists to
# dodge bind-mounted Android dirs with symlink quirks, which does not apply
# when the source is already inside the rootfs.)
real() { readlink -f "$1" 2>/dev/null || echo "$1"; }
DEST="$HOME/app/verifier.mjs"
if [ "$(real "$SRC")" = "$(real "$DEST")" ]; then
  note "stage" "verifier.mjs already at $DEST; running in place"
else
  mkdir -p "$HOME/app"
  # Copy the whole bundle dir: verifier.mjs needs sim.wasm and keccak.mjs beside it.
  if ! cp -f "$(dirname "$SRC")"/* "$HOME/app/" 2>>"$LOG"; then
    fail "stage" "cp $(dirname "$SRC")/* -> $HOME/app/ failed"
    exit 1
  fi
  note "stage" "staged bundle -> $HOME/app/"
fi

# --- python ---------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  note "apt" "installing nodejs"
  apt-get install -y --no-install-recommends nodejs procps >>"$LOG" 2>&1
fi
if ! command -v node >/dev/null 2>&1; then
  fail "apt" "node unavailable after install"
  exit 1
fi
note "apt" "node $(node --version 2>&1)"

# GOTCHA 5: all jobs on a processor share ONE network namespace, so ports are
# global across job sandboxes and a leaked child EADDRINUSEs this run.
# /proc/net is blocked so fuser/ss are blind — kill by name.
pkill -9 -f "verifier.mjs" >/dev/null 2>&1
pkill -9 -f "cloudflared" >/dev/null 2>&1
sleep 1

# --- E0.3 -----------------------------------------------------------------
# Started before any tunnel work: the signing result must not share a fate with
# E0.4. No pipe to tee here — piping made $! the tee PID in run 1, so the
# liveness loop was watching the wrong process.
note "server" "launching verifier.mjs"
node "$DEST" >>"$LOG" 2>&1 &
PY_PID=$!
sleep 10

if ! kill -0 "$PY_PID" 2>/dev/null; then
  fail "server" "verifier.mjs exited immediately"
  exit 1
fi

if curl -m 10 -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  note "server" "healthy on $PORT (pid $PY_PID)"
else
  note "server" "health check failed but process alive; continuing"
fi

# The report is the deliverable. POST it raw and unescaped to its own path so
# it stays valid JSON — the generic note() escaping would mangle it.
REPORT="$(curl -m 40 -s "http://127.0.0.1:$PORT/report" 2>/dev/null)"
if [ -n "$REPORT" ]; then
  post "/report" "$REPORT"
  note "report" "posted ${#REPORT} bytes to /report"
else
  fail "report" "empty response from /report"
fi

# --- E0.4 -----------------------------------------------------------------
note "tunnel" "fetching cloudflared arm64"
if curl -m 180 -sfL -o /tmp/cloudflared \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64
then
  chmod +x /tmp/cloudflared
  note "tunnel" "cloudflared $(/tmp/cloudflared --version 2>&1 | head -1)"

  # GOTCHA 6: flag order. `--no-autoupdate` after `run` dumps help and exits 1.
  # A quick tunnel needs no token, no account and no DNS.
  /tmp/cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" \
    >/tmp/cf.log 2>&1 &
  TUNNEL_PID=$!

  TUNNEL_URL=""
  i=0
  while [ $i -lt 40 ]; do
    TUNNEL_URL="$(grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' /tmp/cf.log 2>/dev/null | head -1)"
    [ -n "$TUNNEL_URL" ] && break
    i=$((i + 1))
    sleep 3
  done

  if [ -n "$TUNNEL_URL" ]; then
    note "tunnel" "READY $TUNNEL_URL"
  else
    fail "tunnel" "no hostname; cf.log: $(tail -20 /tmp/cf.log 2>/dev/null | esc)"
  fi
else
  fail "tunnel" "cloudflared download failed"
fi

# --- stay alive for the scheduled window ---------------------------------
note "serve" "entering serve loop until maxExecutionTimeInMs"
n=0
while kill -0 "$PY_PID" 2>/dev/null; do
  sleep 60
  n=$((n + 1))
  [ $((n % 5)) -eq 0 ] && note "heartbeat" "alive ${n}min ${TUNNEL_URL:-no-tunnel}"
done
fail "serve" "verifier.mjs died after ${n} minutes"
