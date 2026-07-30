#!/bin/sh
# Run the verifier's entrypoint against a local stand-in for the processor.
#
#   ./run.sh            # stream breadcrumbs; sits in the serve loop until Ctrl-C
#   ./run.sh --smoke    # run until the serve loop is reached, then exit. CI-usable.
#   ./run.sh --keep     # like the default, but leave everything up afterwards
#   ./run.sh --shell    # drop into the container instead of running start.sh
#
# Why --smoke exists: the serve loop is meant to run until
# maxExecutionTimeInMs, and locally nothing ever ends it. So "the run finished"
# is not a signal that exists here — reaching `serve` is, and that is what the
# smoke mode waits for.
set -eu

cd "$(dirname "$0")"
chmod +x stub-cloudflared.sh 2>/dev/null || true

DC="docker compose -f compose.yml"
MODE=default
SMOKE_TIMEOUT=${SMOKE_TIMEOUT:-600}

case "${1:-}" in
  --smoke) MODE=smoke ;;
  --keep)  MODE=keep ;;
  --shell) exec $DC run --rm --entrypoint /bin/sh verifier ;;
  "") ;;
  *) echo "unknown option: $1" >&2; exit 2 ;;
esac

cleanup() { [ "$MODE" = keep ] || $DC down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

echo "building (first run pulls ubuntu + node:22-slim)…"
$DC build verifier >/dev/null
echo "starting sink and bridge…"
$DC up -d sink bridge >/dev/null

if [ "$MODE" != smoke ]; then
  $DC logs -f sink &
  LOGS=$!
  set +e; $DC up --exit-code-from verifier verifier; RC=$?; set -e
  kill "$LOGS" 2>/dev/null || true
  echo; echo "verifier container exited $RC"
  [ "$MODE" = keep ] && echo "left up (--keep). Stop with: $DC down -v"
  exit $RC
fi

# --- smoke ----------------------------------------------------------------
$DC up -d verifier >/dev/null
echo "waiting up to ${SMOKE_TIMEOUT}s for the job to reach the serve loop…"

i=0
RC=2
while [ "$i" -lt "$SMOKE_TIMEOUT" ]; do
  out=$($DC logs sink 2>&1 || true)

  # Any reported failure is decisive: the whole point of the breadcrumb channel
  # is that a broken run says so rather than just failing to arrive.
  if printf '%s' "$out" | grep -q "FAILED:"; then
    echo; printf '%s\n' "$out" | sed -E 's/^sink-1 *\| ?//'
    echo; echo "SMOKE FAIL — a step reported failure"
    RC=1; break
  fi

  if printf '%s' "$out" | grep -q "entering serve loop"; then
    echo; printf '%s\n' "$out" | sed -E 's/^sink-1 *\| ?//'
    echo; echo "SMOKE PASS — reached the serve loop in ${i}s"
    RC=0; break
  fi

  # A container that died without reporting is the silent-failure case; catch it
  # rather than sitting here until the timeout.
  if [ -z "$($DC ps -q verifier)" ]; then
    echo; printf '%s\n' "$out" | sed -E 's/^sink-1 *\| ?//'
    echo; echo "SMOKE FAIL — verifier container exited without reaching serve"
    RC=1; break
  fi

  i=$((i + 5))
  sleep 5
done

[ "$RC" = 2 ] && echo "SMOKE FAIL — timed out after ${SMOKE_TIMEOUT}s"
exit $RC
