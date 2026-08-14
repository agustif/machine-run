#!/usr/bin/env bash
# `MacOS.Default` through plan -> deploy -> plan-again -> drift -> destroy, on a
# real macOS.
#
# The one resource kind no Linux container can exercise: it drives `defaults` and
# `plutil`. So unlike the other two checks this runs *directly on the host*, which
# is why it confines itself to `com.machine-run.deploycheck` — a domain no real
# application owns — and deletes it on the way out, including when an assertion
# fails. The machine being reconciled may be a developer's own.
#
# Usage: scripts/deploy-check-macos.sh
set -uo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This check only means anything on macOS (uname -s = $(uname -s))." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DOMAIN=com.machine-run.deploycheck
ALCHEMY="$ROOT/node_modules/.bin/alchemy"
RECIPE="$ROOT/examples/example-machine/lib/alchemy.macos.js"
LOG_DIR="$(mktemp -d)"

FAILURES=0
note() { printf "\n\033[1m==> %s\033[0m\n" "$1"; }
assert_contains() {
  if grep -qF "$3" "$2"; then echo "[PASS] $1"; else
    echo "[FAIL] $1 (pattern $3 not found in $2)"; FAILURES=$((FAILURES + 1)); fi
}
assert_true() {
  local label="$1"; shift
  if "$@"; then echo "[PASS] $label"; else echo "[FAIL] $label"; FAILURES=$((FAILURES + 1)); fi
}

# Runs on every exit path, so a failed assertion cannot leave a stray domain
# behind on someone's Mac.
cleanup() {
  defaults delete "$DOMAIN" >/dev/null 2>&1 || true
  rm -rf "$LOG_DIR"
}
trap cleanup EXIT

note "Start from a clean domain"
defaults delete "$DOMAIN" >/dev/null 2>&1 || true

echo "==> Building examples/example-machine"
npx tsc -b examples/example-machine

note "alchemy plan (first run — expect a create)"
"$ALCHEMY" plan "$RECIPE" 2>&1 | tee "$LOG_DIR/plan-1.log"
assert_contains "initial plan proposes to create the MacOS.Default" "$LOG_DIR/plan-1.log" "demo-macos-default"

note "alchemy deploy"
"$ALCHEMY" deploy "$RECIPE" --yes 2>&1 | tee "$LOG_DIR/deploy.log"
assert_true "deploy did not error" test "${PIPESTATUS[0]}" -eq 0
assert_true "the key holds the declared value" \
  test "$(defaults read "$DOMAIN" sampleKey)" = "expected"

note "alchemy plan (second run — THE idempotence assertion: must be empty)"
"$ALCHEMY" plan "$RECIPE" 2>&1 | tee "$LOG_DIR/plan-2.log"
assert_true "plan after deploy proposes no creates" \
  test "$(grep -c 'to create' "$LOG_DIR/plan-2.log" || true)" -eq 0
assert_true "plan after deploy proposes no updates" \
  test "$(grep -c 'to update' "$LOG_DIR/plan-2.log" || true)" -eq 0

note "Drift: change the key out from under it"
defaults write "$DOMAIN" sampleKey -string tampered

note "alchemy plan (post-drift — the drift must be reported)"
"$ALCHEMY" plan "$RECIPE" 2>&1 | tee "$LOG_DIR/plan-3.log"
assert_contains "drifted MacOS.Default is detected" "$LOG_DIR/plan-3.log" "demo-macos-default"

note "Re-deploy to converge before destroy"
"$ALCHEMY" deploy "$RECIPE" --yes >/dev/null 2>&1

note "alchemy destroy (retain is the default — the key must survive)"
"$ALCHEMY" destroy "$RECIPE" --yes 2>&1 | tee "$LOG_DIR/destroy.log"
# `MacOS.Default` now *has* an `unapply` — it captures the prior value in state, so
# it can restore rather than guess. This still asserts the value survives, which is
# the point: retain is the default, so having an `unapply` is not enough to make
# `destroy` destructive. The `unapply` path itself is covered by unit tests, since
# exercising it here would need a destroy policy this check deliberately does not
# pass.
assert_true "the key still holds its value after destroy" \
  test "$(defaults read "$DOMAIN" sampleKey)" = "expected"

note "Summary"
if [ "$FAILURES" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "$FAILURES CHECK(S) FAILED"; fi
exit "$FAILURES"
