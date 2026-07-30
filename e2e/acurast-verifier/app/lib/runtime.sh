#!/bin/sh
# runtime.sh — the node runtime, and clearing the ground before we bind a port.

ensure_node() {
  if ! command -v node >/dev/null 2>&1; then
    note "runtime" "installing nodejs"
    # Bounded like every other apt call: by this point we can report a timeout,
    # but we still must not spend the execution window inside one.
    bounded 300 apt-get install -y --no-install-recommends nodejs procps >>"$LOG" 2>&1
    rc=$?
    [ $rc -ne 0 ] && say "apt install nodejs returned $rc (124 = timed out)"
  fi

  if ! command -v node >/dev/null 2>&1; then
    fail "runtime" "node unavailable after install"
    return 1
  fi

  note "runtime" "node $(node --version 2>&1)"
  return 0
}

# GOTCHA 6: all jobs on a processor share ONE network namespace, so ports are
# global across job sandboxes and a child leaked by a dead run EADDRINUSEs this
# one. /proc/net is blocked so fuser and ss are blind — kill by name instead.
kill_strays() {
  pkill -9 -f "verifier.mjs" >/dev/null 2>&1
  pkill -9 -f "cloudflared"  >/dev/null 2>&1
  sleep 1
  note "runtime" "cleared any strays from earlier runs"
}
