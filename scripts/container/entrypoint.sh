#!/usr/bin/env bash
# Runs *inside* the container built by docker/Dockerfile — this is the actual
# proof-of-life for machine-run: plan, deploy, plan-again-must-be-empty,
# drift-every-resource-kind, destroy-must-leave-things-alone. See
# scripts/deploy-check.sh for the host-side entry point, and
# docs/deploy-notes.md for what running this actually found.
#
# $HOME is /home/runner (see docker/Dockerfile) — a real directory, but one
# that exists nowhere outside this throwaway container.
set -euo pipefail

WORKSPACE=/workspace
RECIPE_DIR="$WORKSPACE/examples/example-machine"
RECIPE="alchemy.container.ts"
ALCHEMY="$WORKSPACE/node_modules/.bin/alchemy"
export USER="${USER:-runner}"

FAILURES=0
LOG_DIR="$(mktemp -d)"

note() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# Runs `alchemy plan`, saving output to `$LOG_DIR/plan-<label>.log` and also
# streaming it to this script's own stdout via `tee`.
#
# Deliberately does NOT return the log path via `echo` + command
# substitution: `tee` writes that same output to *this function's* stdout
# too, so a caller doing `out="$(run_plan foo)"` would capture the whole
# multi-line alchemy transcript into `$out`, not just the path — which is
# exactly the bug an earlier version of this script had (see
# docs/deploy-notes.md: it produced `grep: <transcript text>: No such file or
# directory` instead of ever actually checking the log). The path is
# deterministic from `label` alone, so callers compute it themselves instead.
plan_log() { echo "$LOG_DIR/plan-$1.log"; }
deploy_log() { echo "$LOG_DIR/deploy-$1.log"; }

run_plan() {
  local label="$1"
  "$ALCHEMY" plan "$RECIPE" 2>&1 | tee "$(plan_log "$label")"
}

# `alchemy deploy` prompts for approval unless `--yes` is passed (see
# alchemy's own Cli/LoggingCli.ts: a non-interactive terminal always answers
# "no" to that prompt otherwise) — so this is not optional.
run_deploy() {
  local label="$1"
  "$ALCHEMY" deploy "$RECIPE" --yes 2>&1 | tee "$(deploy_log "$label")"
}

assert_contains() {
  local desc="$1" file="$2" pattern="$3"
  if grep -qE "$pattern" "$file"; then
    printf '[PASS] %s\n' "$desc"
  else
    printf '[FAIL] %s (pattern %q not found in %s)\n' "$desc" "$pattern" "$file"
    FAILURES=$((FAILURES + 1))
  fi
}

assert_not_contains() {
  local desc="$1" file="$2" pattern="$3"
  if grep -qE "$pattern" "$file"; then
    printf '[FAIL] %s (pattern %q unexpectedly found in %s)\n' "$desc" "$pattern" "$file"
    FAILURES=$((FAILURES + 1))
  else
    printf '[PASS] %s\n' "$desc"
  fi
}

assert_true() {
  local desc="$1"; shift
  if "$@"; then
    printf '[PASS] %s\n' "$desc"
  else
    printf '[FAIL] %s\n' "$desc"
    FAILURES=$((FAILURES + 1))
  fi
}

cd "$RECIPE_DIR"

note "Setup: a Symlink source must already exist — Symlink never fabricates content"
mkdir -p "$HOME/vault"
printf 'reviewed motd, provisioned before deploy\n' > "$HOME/vault/motd"

# `Machine.SecretFile`'s `env` backend reads this at *apply* time and never
# lets it reach Alchemy's state — see @machine-run/secrets/src/backends/Env.ts.
export MACHINE_RUN_TEST_SECRET="deploy-check-test-secret-$(date +%s)"

note "Setup: local git origin for Git.Repo — no dependency on the real internet"
git init -q -b main "$HOME/vault/origin-repo"
git -C "$HOME/vault/origin-repo" -c user.email=test@example.com -c user.name="Deploy Check" \
  commit -q --allow-empty -m "initial"

note "Setup: local HTTP server for Machine.Download — no dependency on the real internet"
printf 'machine-run download fixture\n' > "$HOME/vault/download-fixture.txt"
python3 -m http.server 8765 --bind 127.0.0.1 --directory "$HOME/vault" \
  >/tmp/deploy-check-http-server.log 2>&1 &
HTTP_SERVER_PID=$!
for _ in $(seq 1 30); do
  curl -sf http://127.0.0.1:8765/download-fixture.txt >/dev/null && break
  sleep 0.2
done

note "apt-get update (this container's own network, needed for System.Package below)"
if ! sudo apt-get update -qq; then
  echo "WARNING: apt-get update failed — the System.Package steps below will" \
       "likely fail too. Recorded as a harness/network finding, not faked."
fi

note "alchemy plan (first run — expect a full create plan)"
run_plan initial
plan1="$(plan_log initial)"
assert_contains "initial plan proposes creates" "$plan1" "to create"
assert_contains "initial plan proposes to create the Template" "$plan1" "greeting-template"
assert_contains "initial plan proposes to create the LineInFile" "$plan1" "greeting-line"
assert_contains "initial plan proposes to create the Download" "$plan1" "download-fixture"
assert_contains "initial plan proposes to create the Git.Config key" "$plan1" "git-config-username"
assert_contains "initial plan proposes to create the Git.Repo clone" "$plan1" "demo-repo-clone"

note "alchemy deploy --yes"
run_deploy initial
deploy1="$(deploy_log initial)"
assert_not_contains "deploy did not error" "$deploy1" "ERROR"

note "alchemy plan (post-deploy — THE idempotence assertion: must be empty)"
run_plan post-deploy
plan2="$(plan_log post-deploy)"
assert_not_contains "plan after deploy proposes no creates" "$plan2" "to create"
assert_not_contains "plan after deploy proposes no updates" "$plan2" "to update"
assert_not_contains "plan after deploy proposes no deletes" "$plan2" "to delete"
assert_not_contains "plan after deploy proposes no replaces" "$plan2" "to replace"

note "Drift: hand-edit Machine.File's content (persona-config)"
echo "# tampered by deploy-check" >> "$HOME/.gitconfig-personal"

note "Drift: hand-edit Machine.ManagedBlock's region content, not its markers (shell-path)"
sed -i 's#\.local/bin#tampered#' "$HOME/.bashrc"

note "Drift: chmod Machine.Directory away from its declared mode"
chmod 0755 "$HOME/.config/machine-run-demo"

note "Drift: remove Machine.Symlink"
rm -f "$HOME/.motd"

note "Drift: remove Machine.SecretFile"
rm -f "$HOME/.config/machine-run-demo/secret"

note "Drift: remove Machine.Exec's 'creates' marker"
rm -f "$HOME/.exec-marker"

note "Drift: uninstall the System.Package"
sudo apt-get remove -y -qq cowsay || true

note "Drift: hand-edit Machine.Template's rendered content (greeting-template)"
echo "# tampered by deploy-check" >> "$HOME/.config/machine-run-demo/greeting.txt"

note "Drift: hand-edit Machine.LineInFile's owned line, in place (greeting-line)"
sed -i 's/^GREETING=.*/GREETING=tampered/' "$HOME/.config/machine-run-demo/one-line.conf"

note "Drift: corrupt Machine.Download's fetched bytes (download-fixture)"
echo "tampered" >> "$HOME/.config/machine-run-demo/downloaded-fixture.txt"

note "Drift: hand-edit Git.Config's value directly (git-config-username)"
git config --global user.name "Tampered Name"

note "Drift: repoint Git.Repo's origin remote (demo-repo-clone)"
git -C "$HOME/demo-repo-clone" remote set-url origin /tmp/not-the-real-origin

note "alchemy plan (post-drift — every drifted resource must be reported)"
run_plan post-drift
plan3="$(plan_log post-drift)"
# `persona-config`, not `gitconfig-personal`: `plan` prints resource *ids*, and
# this resource's id is `persona-config` while `~/.gitconfig-personal` is only
# its path. The other six assertions below pass because each of those resources
# happens to be named after the thing it manages; this one is not, so the
# original pattern could never match and reported a false failure for a drift
# that was in fact detected every time.
assert_contains "drifted Machine.File is detected" "$plan3" "persona-config"
assert_contains "drifted Machine.ManagedBlock is detected" "$plan3" "shell-path"
assert_contains "drifted Machine.Directory is detected" "$plan3" "config-dir"
assert_contains "drifted Machine.Symlink is detected" "$plan3" "motd-link"
assert_contains "drifted Machine.SecretFile is detected" "$plan3" "demo-secret"
assert_contains "drifted Machine.Exec is detected" "$plan3" "marker-exec"
assert_contains "drifted System.Package is detected" "$plan3" "apt-cowsay"
assert_contains "drifted Machine.Template is detected" "$plan3" "greeting-template"
assert_contains "drifted Machine.LineInFile is detected" "$plan3" "greeting-line"
assert_contains "drifted Machine.Download is detected" "$plan3" "download-fixture"
assert_contains "drifted Git.Config is detected" "$plan3" "git-config-username"
assert_contains "drifted Git.Repo is detected" "$plan3" "demo-repo-clone"

note "Re-deploy to converge before destroy"
run_deploy reconverge >/dev/null

note "Snapshot managed content before destroy (for the 'untouched' assertion)"
before_gitconfig="$(sha256sum "$HOME/.gitconfig-personal" | cut -d' ' -f1)"
before_bashrc="$(sha256sum "$HOME/.bashrc" | cut -d' ' -f1)"
before_secret="$(sha256sum "$HOME/.config/machine-run-demo/secret" | cut -d' ' -f1)"
before_motd_target="$(readlink -f "$HOME/.motd")"
before_pkg="$(dpkg-query -W -f='${Status}' cowsay 2>/dev/null || echo "not-installed")"
before_greeting="$(sha256sum "$HOME/.config/machine-run-demo/greeting.txt" | cut -d' ' -f1)"
before_line="$(sha256sum "$HOME/.config/machine-run-demo/one-line.conf" | cut -d' ' -f1)"
before_download="$(sha256sum "$HOME/.config/machine-run-demo/downloaded-fixture.txt" | cut -d' ' -f1)"
before_git_username="$(git config --global --get user.name)"
before_repo_remote="$(git -C "$HOME/demo-repo-clone" remote get-url origin)"

note "alchemy destroy --yes"
"$ALCHEMY" destroy "$RECIPE" --yes 2>&1 | tee "$LOG_DIR/destroy.log"

note "Assert the machine is untouched (retain is the default — see toProvider.ts)"
after_gitconfig="$(sha256sum "$HOME/.gitconfig-personal" 2>/dev/null | cut -d' ' -f1 || echo MISSING)"
after_bashrc="$(sha256sum "$HOME/.bashrc" 2>/dev/null | cut -d' ' -f1 || echo MISSING)"
after_secret="$(sha256sum "$HOME/.config/machine-run-demo/secret" 2>/dev/null | cut -d' ' -f1 || echo MISSING)"
after_motd_target="$(readlink -f "$HOME/.motd" 2>/dev/null || echo MISSING)"
after_pkg="$(dpkg-query -W -f='${Status}' cowsay 2>/dev/null || echo "not-installed")"
after_greeting="$(sha256sum "$HOME/.config/machine-run-demo/greeting.txt" 2>/dev/null | cut -d' ' -f1 || echo MISSING)"
after_line="$(sha256sum "$HOME/.config/machine-run-demo/one-line.conf" 2>/dev/null | cut -d' ' -f1 || echo MISSING)"
after_download="$(sha256sum "$HOME/.config/machine-run-demo/downloaded-fixture.txt" 2>/dev/null | cut -d' ' -f1 || echo MISSING)"
after_git_username="$(git config --global --get user.name)"
after_repo_remote="$(git -C "$HOME/demo-repo-clone" remote get-url origin 2>/dev/null || echo MISSING)"

assert_true "Machine.File content unchanged after destroy" \
  test "$before_gitconfig" = "$after_gitconfig"
assert_true "Machine.ManagedBlock content unchanged after destroy" \
  test "$before_bashrc" = "$after_bashrc"
assert_true "Machine.SecretFile unchanged after destroy" \
  test "$before_secret" = "$after_secret"
assert_true "Machine.Symlink still points at the same target after destroy" \
  test "$before_motd_target" = "$after_motd_target"
assert_true "System.Package still installed after destroy (retain, not reverted)" \
  test "$before_pkg" = "$after_pkg"
assert_true "Machine.Template content unchanged after destroy" \
  test "$before_greeting" = "$after_greeting"
assert_true "Machine.LineInFile content unchanged after destroy" \
  test "$before_line" = "$after_line"
assert_true "Machine.Download content unchanged after destroy" \
  test "$before_download" = "$after_download"
assert_true "Git.Config value unchanged after destroy (retain, not reverted)" \
  test "$before_git_username" = "$after_git_username"
assert_true "Git.Repo clone still exists with the same remote after destroy" \
  test "$before_repo_remote" = "$after_repo_remote"

kill "$HTTP_SERVER_PID" 2>/dev/null || true

note "Summary"
if [ "$FAILURES" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
else
  echo "$FAILURES CHECK(S) FAILED"
fi
exit "$FAILURES"
