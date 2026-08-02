#!/bin/sh
# server.sh — run verifier.mjs and get its report out.
#
# Sets SERVER_PID, which the bootstrap's EXIT trap reaps.

start_server() {
  # Started before any tunnel work: the signing result must not share a fate
  # with the tunnel. Note there is no pipe to tee — piping made $! the tee PID
  # in an early run, so the liveness check watched the wrong process and thought
  # a dead server was healthy.
  note "server" "launching verifier.mjs"
  node "$VERIFIER_DEST" >>"$LOG" 2>&1 &
  SERVER_PID=$!
  sleep 10

  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    fail "server" "verifier.mjs exited immediately"
    return 1
  fi

  wait_healthy
  return 0
}

wait_healthy() {
  if curl -m 10 -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    note "server" "healthy on $PORT (pid $SERVER_PID)"
  else
    # Deliberately not fatal: the process is alive, and the tunnel plus the
    # sole-connector check downstream will exercise it again for real.
    note "server" "health check failed but process alive; continuing"
  fi
}

# There is deliberately no post_report step.
#
# One used to live here, carried over from the E0.3 signing probe, which really
# did serve /report. verifier.mjs does not: its routes are /health, /identity,
# POST /session and POST /attest. So the step fetched a 404 body, saw a
# non-empty string, and reported "posted 68 bytes" — success, every time.
#
# It was not only the local harness that this fooled. Run 380397, which had been
# treated as the healthy baseline, posted exactly 68 bytes to /report too. The
# lesson worth keeping: a check whose success condition is "the response was not
# empty" will pass on an error page. If a report step comes back, it should
# assert on the *shape* of what it got.
