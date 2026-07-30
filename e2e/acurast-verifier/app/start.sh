#!/bin/sh
# Entrypoint for the Acurast Shell deployment of the Rainbow verifier.
#
# SHAPE OF THIS FILE. It is the bootstrap and the running order, and nothing
# else. Everything down to `source_modules` is deliberately self-contained,
# because that stretch runs in the one window where the job cannot report: the
# base proot image ships no curl, so a failure before curl exists produces not a
# bad message but *no* message. A failed `source` in there would be invisible —
# exactly the failure class that cost runs 380398 and 380401 an hour of billed
# silence each. So the blind window depends on nothing it has to find on disk,
# and the moment curl works the rest of the job is loaded from lib/, where a
# mistake reports itself.
#
# That is also why the reporting helpers below are not a module: the EXIT trap
# has to be armed before anything can go wrong, which is before there is any
# directory to source from.
#
# DESIGN RULE: the webhook is the ONLY channel back. Acurast DevTools targets
# mainnet, so a canary deployment's stdout is unreachable — anything not POSTed
# is lost. So every step reports, and the EXIT trap reports the exit code plus a
# log tail, which turns "the job went silent" into an actual message.
#
# `set -e` is deliberately NOT used. It made an early run exit silently on a
# failure that was never reported; explicit checks that notify are strictly
# better here.

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

# ---------------------------------------------------------------------------
# Reporting core. Inline by necessity — see the header.
# ---------------------------------------------------------------------------

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
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null
  return 0
}
# GOTCHA 3: without an explicit TERM/INT trap the EXIT trap never runs on
# teardown, so the exit report would be lost exactly when it matters most.
trap on_exit EXIT
trap 'exit 143' TERM INT

# ---------------------------------------------------------------------------
# Bootstrap helpers, used before any module exists.
# ---------------------------------------------------------------------------

T0=$(date +%s 2>/dev/null || echo 0)
elapsed() { if [ "$T0" = 0 ]; then echo "?"; else echo "$(( $(date +%s) - T0 ))s"; fi; }

# `timeout` is coreutils and is present in the base image, but guard rather than
# assume: silently losing the bound is precisely the failure being fixed here.
if command -v timeout >/dev/null 2>&1; then
  bounded() { limit=$1; shift; timeout "$limit" "$@"; }
else
  bounded() { shift; "$@"; }
fi

# Report which vars arrived, by NAME only. CF_TUNNEL_TOKEN is a credential and
# this line goes over the wire, so values are never printed.
present() { eval "v=\${$1:-}"; if [ -n "$v" ]; then printf '%s=set ' "$1"; else printf '%s=UNSET ' "$1"; fi; }

# ---------------------------------------------------------------------------
# ensure_curl — the blind window, and the only step that cannot report itself.
# ---------------------------------------------------------------------------
#
# Every apt call is bounded, so a hang becomes a fast failure that frees the
# assignment instead of consuming the whole of maxExecutionTimeInMs in silence.
# The instant curl exists we post a reconstruction of what just happened —
# attempts, exit codes, elapsed seconds, which env vars arrived — so the blind
# window is at least legible after the fact.
#
# Known limit, stated rather than hidden: if apt never yields curl, the abort
# below is silent too. It cannot be otherwise; curl is the thing that reports.
ensure_curl() {
  command -v curl >/dev/null 2>&1 && { note "preflight" "curl already present"; return 0; }

  # `timeout` caps each call as a whole; these keep one stalled mirror
  # connection from eating that entire budget before the useful work starts.
  apt_opts="-o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 -o Acquire::Retries=2"
  trace=""
  n=0
  while [ $n -lt 3 ]; do
    n=$((n + 1))
    bounded 150 apt-get $apt_opts update -y >>"$LOG" 2>&1
    rc_u=$?
    bounded 180 apt-get $apt_opts install -y --no-install-recommends curl ca-certificates >>"$LOG" 2>&1
    rc_i=$?
    trace="$trace try$n(update=$rc_u install=$rc_i at=$(elapsed))"
    command -v curl >/dev/null 2>&1 && break
    say "apt try $n yielded no curl (update=$rc_u install=$rc_i); retrying"
    sleep 5
  done

  if ! command -v curl >/dev/null 2>&1; then
    # Exit immediately rather than hold the assignment for the rest of the
    # window: a job that fails its SLA promptly is at least visible on-chain,
    # which silence is not.
    say "curl unavailable after apt —$trace — no channel back, aborting"
    return 1
  fi

  # The first thing said out loud, and the reason this run is diagnosable.
  # Exit 124 from a bounded call means it hit the timeout rather than failed.
  note "preflight" "curl after$trace total=$(elapsed); env: $(present WEBHOOK_URL; present CF_TUNNEL_TOKEN; present VERIFIER_HOSTNAME; present CONTRACT; present CHAIN_ID; present GAME_ID)"
  return 0
}

# ---------------------------------------------------------------------------
# locate_bundle — inline because it is how everything else is found, lib/
# included. Sets BUNDLE_DIR and VERIFIER_SRC.
# ---------------------------------------------------------------------------
#
# GOTCHA 4: do NOT trust `dirname $0`. It is a `set -e` hazard and the launcher
# may invoke the entrypoint in ways that make it useless. Search instead, and
# report what was actually on disk if the search fails.
locate_bundle() {
  VERIFIER_SRC=""
  for cand in \
    "$(dirname "$0" 2>/dev/null)/verifier.mjs" \
    "./verifier.mjs" \
    "/acurast/app/verifier.mjs" \
    "$HOME/verifier.mjs" \
    "$HOME/app/verifier.mjs"
  do
    [ -f "$cand" ] && { VERIFIER_SRC="$cand"; break; }
  done

  if [ -z "$VERIFIER_SRC" ]; then
    found="$(find / -name verifier.mjs -maxdepth 6 2>/dev/null | head -1)"
    if [ -n "$found" ]; then
      VERIFIER_SRC="$found"
      note "locate" "found via find: $VERIFIER_SRC"
    else
      fail "locate" "verifier.mjs not found. cwd listing: $(ls -la . 2>&1 | head -20)"
      return 1
    fi
  fi

  BUNDLE_DIR="$(dirname "$VERIFIER_SRC")"
  note "locate" "bundle at $BUNDLE_DIR"
  return 0
}

# ---------------------------------------------------------------------------
# source_modules — everything past here is reportable, so it can live in files.
# ---------------------------------------------------------------------------
source_modules() {
  missing=""
  for m in stage runtime server tunnel serve; do
    if [ -f "$BUNDLE_DIR/lib/$m.sh" ]; then
      . "$BUNDLE_DIR/lib/$m.sh"
    else
      missing="$missing $m.sh"
    fi
  done

  if [ -n "$missing" ]; then
    # Worth reporting precisely: the bundler zips the app dir verbatim, so a
    # module going missing means the bundle shipped wrong, not that the phone
    # misbehaved — a completely different thing to go and fix.
    fail "modules" "missing from $BUNDLE_DIR/lib:$missing (present: $(ls "$BUNDLE_DIR/lib" 2>&1 | tr '\n' ' '))"
    return 1
  fi

  note "modules" "loaded stage runtime server tunnel serve from $BUNDLE_DIR/lib"
  return 0
}

# ---------------------------------------------------------------------------
# The whole job, at a glance.
# ---------------------------------------------------------------------------
main() {
  say "boot: pwd=$(pwd) \$0=$0 BRIDGE_SOCKET=${BRIDGE_SOCKET:-<unset>} PORT=$PORT"

  ensure_curl           || exit 1
  locate_bundle         || exit 1
  source_modules        || exit 1

  stage_bundle          || exit 1
  ensure_node           || exit 1
  kill_strays

  start_server          || exit 1

  start_tunnel
  assert_sole_connector || exit 1

  serve_loop
}

main "$@"
