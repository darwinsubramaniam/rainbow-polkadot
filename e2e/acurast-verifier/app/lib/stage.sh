#!/bin/sh
# stage.sh — put the bundle where the server will run from.
#
# Consumes BUNDLE_DIR and VERIFIER_SRC from the bootstrap; sets VERIFIER_DEST.

# GOTCHA 5: the bundle is extracted to /root/app, which IS $HOME/app — so the
# usual "copy out of the bundle dir" step becomes `cp X X` and fails. Copy only
# when the paths genuinely differ; otherwise run in place. (The copy exists to
# dodge bind-mounted Android dirs with symlink quirks, which does not apply when
# the source is already inside the rootfs.)
_real() { readlink -f "$1" 2>/dev/null || echo "$1"; }

stage_bundle() {
  VERIFIER_DEST="$HOME/app/verifier.mjs"

  if [ "$(_real "$VERIFIER_SRC")" = "$(_real "$VERIFIER_DEST")" ]; then
    note "stage" "verifier.mjs already at $VERIFIER_DEST; running in place"
    return 0
  fi

  mkdir -p "$HOME/app"
  # Copy the whole bundle dir: verifier.mjs needs sim.wasm and keccak.mjs beside
  # it, so staging the one file it was found by would leave it unable to start.
  if ! cp -f "$BUNDLE_DIR"/* "$HOME/app/" 2>>"$LOG"; then
    fail "stage" "cp $BUNDLE_DIR/* -> $HOME/app/ failed"
    return 1
  fi

  note "stage" "staged bundle -> $HOME/app/"
  return 0
}
