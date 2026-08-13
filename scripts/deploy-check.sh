#!/usr/bin/env bash
# The single command that actually deploys this repo and proves it: builds a
# throwaway Linux container, then inside it runs
# examples/example-machine/alchemy.container.ts through
# plan -> deploy -> plan (must be empty) -> drift every resource kind ->
# plan (must catch it) -> destroy (must leave the machine untouched).
#
# See docs/deploy-notes.md for what running this actually found, and
# scripts/container/entrypoint.sh for the sequence itself (that script runs
# *inside* the container; this one only builds the image and runs it).
#
# Usage: scripts/deploy-check.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

IMAGE_TAG="machine-run-deploy-check:latest"
CONTAINER_NAME="machine-run-deploy-check-$$"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required (this repo uses OrbStack; run 'orb start' if the daemon is down)." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "The Docker daemon isn't reachable. On this machine: 'orb start', then re-run." >&2
  exit 1
fi

# Built on the host, not inside the image — see .dockerignore and
# docker/Dockerfile's comments. `examples/example-machine`'s own project
# graph (this command) is what this repo currently guarantees is green; the
# whole workspace's `tsc -b` is a separate, stricter bar (see
# docs/deploy-notes.md) that the "check" CI job covers instead.
echo "==> Building examples/example-machine (npx tsc -b examples/example-machine)"
npx tsc -b examples/example-machine

echo "==> Building $IMAGE_TAG from docker/Dockerfile"
docker build -f docker/Dockerfile -t "$IMAGE_TAG" .

echo "==> Running scripts/container/entrypoint.sh inside a throwaway container ($CONTAINER_NAME)"
# --rm: the container is deleted the moment it exits, whether it passes or
# fails, so nothing from this run lingers. --name is unique per invocation
# (this script's own pid) so concurrent runs, or a crashed one, never collide
# with — or get mistaken for — anything else on this machine.
docker run --rm --name "$CONTAINER_NAME" "$IMAGE_TAG"
