#!/bin/sh
# serve.sh — hold the job open for the scheduled window.
#
# The loop watches the server process rather than sleeping blindly, so if
# verifier.mjs dies mid-window that is reported as a failure instead of being
# hidden behind a tunnel that is still happily connected.

serve_loop() {
  note "serve" "entering serve loop until maxExecutionTimeInMs"

  n=0
  while kill -0 "$SERVER_PID" 2>/dev/null; do
    sleep 60
    n=$((n + 1))
    # Every 5 minutes: often enough to localise a silent death, rare enough not
    # to flood the sink over an hour-long window.
    [ $((n % 5)) -eq 0 ] && note "heartbeat" "alive ${n}min ${TUNNEL_URL:-no-tunnel}"
  done

  fail "serve" "verifier.mjs died after ${n} minutes"
}
