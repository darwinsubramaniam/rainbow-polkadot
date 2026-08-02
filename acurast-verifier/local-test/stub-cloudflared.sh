#!/bin/sh
# Stand-in for the cloudflared binary, so the harness exercises tunnel.sh's
# branching without opening a real tunnel from a development machine.
#
# It mimics only what start.sh actually depends on: the `--version` line, a
# quick-tunnel hostname written to the log it greps, and a process that stays
# alive so the liveness check and the EXIT trap's reaping have something real
# to act on.

case "$*" in
  *--version*)
    echo "cloudflared version 0.0.0-stub (local harness)"
    exit 0
    ;;
esac

case "$*" in
  *--token*)
    # Named-tunnel branch: a real connector prints this and keeps running.
    echo "INF Registered tunnel connection connIndex=0 (stub)" >&2
    ;;
  *)
    # Quick-tunnel branch: tunnel.sh greps stdout/stderr for this hostname.
    echo "INF |  https://stub-local-harness.trycloudflare.com  |"
    ;;
esac

# Stay up: a stub that exited would make tunnel.sh report the connector as dead,
# which is a different code path than the one under test.
while true; do sleep 3600; done
