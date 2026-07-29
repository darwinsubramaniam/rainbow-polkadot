#!/bin/sh
# Pull the newest E0.3 report out of the local webhook sink and analyse it.
#
# The sink (docker container `cargopod-sink`) persists every request as a JSON
# envelope in /data with the raw payload in `.body`. That is a cleaner source
# than scraping `docker logs`, which interleaves pretty-printing.
#
#   ./pull-report.sh            # newest report -> verify.mjs
#   ./pull-report.sh --raw      # just print the report JSON
set -eu

CONTAINER="${SINK_CONTAINER:-cargopod-sink}"
OUT="${OUT:-/tmp/e0-report.json}"

# Newest record whose path is the report endpoint. Fall back to any record whose
# body mentions "signatures", in case the path changes.
FILE="$(docker exec "$CONTAINER" sh -c '
  grep -l "\"path\": \"/e0-signer/report\"" /data/*.json 2>/dev/null | tail -1
  ' | tr -d "\r" | tail -1)"

if [ -z "$FILE" ]; then
  FILE="$(docker exec "$CONTAINER" sh -c '
    grep -l "signatures" /data/*.json 2>/dev/null | tail -1
    ' | tr -d "\r" | tail -1)"
fi

if [ -z "$FILE" ]; then
  echo "No report found in $CONTAINER:/data yet." >&2
  echo "Stages received so far:" >&2
  docker exec "$CONTAINER" sh -c 'grep -h "\"stage\"" /data/*.json 2>/dev/null | tail -10' >&2 || true
  exit 1
fi

echo "source: $CONTAINER:$FILE" >&2

# `.body` is the payload as a JSON string; unwrap it to get the report itself.
docker exec "$CONTAINER" cat "$FILE" \
  | node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        const env = JSON.parse(s);
        process.stdout.write(typeof env.body === "string" ? env.body : JSON.stringify(env.body));
      });
    ' > "$OUT"

echo "report: $OUT ($(wc -c < "$OUT") bytes)" >&2

if [ "${1:-}" = "--raw" ]; then
  cat "$OUT"
else
  node "$(dirname "$0")/verify.mjs" "$OUT"
fi
