#!/usr/bin/env bash
# `System.Service` against a real, booted `systemd --user` instance.
#
# Separate from `scripts/deploy-check.sh` because the requirement is not a package
# but an init system: `systemctl --user` refuses without the *system* instance too
# (`sd_booted()` checks for it), so this needs systemd as PID 1, `--privileged`,
# and `/sys/fs/cgroup` mounted. Making the main image systemd-based and privileged
# for one resource kind would be a bad trade against a check that passes
# unprivileged today.
#
# `packages/system-services/src/backends/linux/SystemdUser.ts` records the setup
# this automates, and the exact command outputs it was verified against.
#
# Usage: scripts/deploy-check-systemd.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

IMAGE_TAG="machine-run-systemd-check:latest"
CONTAINER_NAME="machine-run-systemd-check-$$"

if ! docker info >/dev/null 2>&1; then
  echo "The Docker daemon isn't reachable. On this machine: 'orb start', then re-run." >&2
  exit 1
fi

echo "==> Building examples/example-machine"
npx tsc -b examples/example-machine

echo "==> Building $IMAGE_TAG from docker/Dockerfile.systemd"
docker build -f docker/Dockerfile.systemd -t "$IMAGE_TAG" .

# `--privileged` and the cgroup mount are what let systemd actually boot; without
# them PID 1 exits immediately and every assertion below would fail for a reason
# that has nothing to do with this repo.
echo "==> Booting systemd in $CONTAINER_NAME"
docker run -d --name "$CONTAINER_NAME" \
  --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  "$IMAGE_TAG" >/dev/null

# Always removed, even when the assertions fail — a leaked privileged container is
# worse than a failed check.
cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Running the check inside it"
docker exec "$CONTAINER_NAME" /usr/local/bin/systemd-entrypoint.sh
