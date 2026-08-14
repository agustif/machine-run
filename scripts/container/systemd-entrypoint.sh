#!/usr/bin/env bash
# `System.Service`'s lifecycle against a real `systemd --user` instance.
#
# Runs *inside* the privileged systemd container that
# `scripts/deploy-check-systemd.sh` starts, after PID 1 has finished booting.
# Same four phases the main check applies to every other kind: create, drift,
# detect, and confirm `destroy` leaves things alone under the default policy.
set -uo pipefail

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

WORKSPACE=/workspace
ALCHEMY="$WORKSPACE/node_modules/.bin/alchemy"
RECIPE="$WORKSPACE/examples/example-machine/lib/alchemy.systemd.js"
LOG_DIR="$(mktemp -d)"
# World-writable because every alchemy invocation below runs as `runner` via
# `sudo -u`, while this script runs as root: a root-owned 0700 temp dir silently
# swallowed every `tee`, and the assertions then failed on a missing file rather
# than on anything the engine did.
chmod 0777 "$LOG_DIR"

note "Wait for the system instance to finish booting"
for _ in $(seq 1 60); do
  state="$(systemctl is-system-running 2>/dev/null || true)"
  # `degraded` is fine and expected in a container: some units cannot start
  # here. What matters is that the manager itself is up, which both `running`
  # and `degraded` mean and `starting` does not.
  case "$state" in running | degraded) break ;; esac
  sleep 1
done
echo "system state: ${state:-unknown}"

note "Give the runner a real user manager (loginctl enable-linger)"
loginctl enable-linger runner
for _ in $(seq 1 30); do
  systemctl is-active "user@$(id -u runner).service" >/dev/null 2>&1 && break
  sleep 1
done
systemctl is-active "user@$(id -u runner).service" || true

# `System.Service` reconciles a unit's enabled/running state and deliberately
# does not author unit files, so the unit has to exist before the recipe runs.
note "Install a throwaway unit for the recipe to reconcile"
install -d -o runner -g runner /home/runner/.config/systemd/user
cat > /home/runner/.config/systemd/user/mrtest.service <<'UNIT'
[Unit]
Description=machine-run deploy-check throwaway unit
[Service]
ExecStart=/bin/sleep infinity
[Install]
WantedBy=default.target
UNIT
chown runner:runner /home/runner/.config/systemd/user/mrtest.service

as_runner() {
  # `machinectl shell` would be the cleanest way in, but it needs a TTY. Setting
  # the two variables `systemctl --user` actually reads is enough, and is what
  # SystemdUser.ts's own verification transcript did.
  sudo -u runner env \
    XDG_RUNTIME_DIR="/run/user/$(id -u runner)" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u runner)/bus" \
    "$@"
}

as_runner systemctl --user daemon-reload

note "alchemy plan (first run — an update, not a create: the unit exists but is disabled)"
as_runner "$ALCHEMY" plan "$RECIPE" 2>&1 | tee "$LOG_DIR/plan-1.log"
assert_contains "initial plan reports the System.Service" "$LOG_DIR/plan-1.log" "demo-systemd-unit"

note "alchemy deploy"
as_runner "$ALCHEMY" deploy "$RECIPE" --yes 2>&1 | tee "$LOG_DIR/deploy.log"
assert_true "deploy did not error" test "${PIPESTATUS[0]}" -eq 0
assert_true "the unit is enabled" as_runner systemctl --user is-enabled mrtest.service
assert_true "the unit is running" as_runner systemctl --user is-active mrtest.service

note "alchemy plan (second run — must be empty)"
as_runner "$ALCHEMY" plan "$RECIPE" 2>&1 | tee "$LOG_DIR/plan-2.log"
assert_true "plan after deploy proposes no creates" \
  test "$(grep -c 'create' "$LOG_DIR/plan-2.log" || true)" -eq 0
assert_true "plan after deploy proposes no updates" \
  test "$(grep -c 'update' "$LOG_DIR/plan-2.log" || true)" -eq 0

note "Drift: stop and disable the unit out from under it"
as_runner systemctl --user stop mrtest.service
as_runner systemctl --user disable mrtest.service

note "alchemy plan (post-drift — the drift must be reported)"
as_runner "$ALCHEMY" plan "$RECIPE" 2>&1 | tee "$LOG_DIR/plan-3.log"
assert_contains "drifted System.Service is detected" "$LOG_DIR/plan-3.log" "demo-systemd-unit"

note "Re-deploy to converge before destroy"
as_runner "$ALCHEMY" deploy "$RECIPE" --yes >/dev/null 2>&1

note "alchemy destroy (retain is the default — the unit must be left alone)"
as_runner "$ALCHEMY" destroy "$RECIPE" --yes 2>&1 | tee "$LOG_DIR/destroy.log"
# `System.Service` *has* an `unapply` (disable + stop), so this proves the same
# thing the main check proves for the other kinds that have one: retain still
# wins unless an explicit destroy policy is in play.
assert_true "the unit is still enabled after destroy" as_runner systemctl --user is-enabled mrtest.service
assert_true "the unit is still running after destroy" as_runner systemctl --user is-active mrtest.service

note "Summary"
if [ "$FAILURES" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "$FAILURES CHECK(S) FAILED"; fi
exit "$FAILURES"
