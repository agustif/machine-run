# Deploys examples/example-machine/alchemy.container.ts end to end, inside a
# throwaway container, so this repo's claims about live-state observation and
# idempotence are actually exercised instead of reasoned about from source.
# See scripts/deploy-check.sh (the single entry point anyone should run) and
# docs/deploy-notes.md (what running this actually found).
#
# Node 22+ per this repo's package.json "engines" — bookworm gives us a real
# Debian machine underneath, which is what @machine-run/system-packages'
# `apt` backend and detect.ts's distro probes are actually written against.
FROM node:22-bookworm

# `sudo` because `System.Package`'s apt backend runs `install`/`addRepo` via
# `sudo apt-get ...` unconditionally (see packages/system-packages/src/backends/linux/Apt.ts) —
# it assumes either root or passwordless sudo, and provides no terminal or
# password itself. `ca-certificates` for npm's/apt's own TLS. Lists are left
# in place (no `rm -rf /var/lib/apt/lists/*`) rather than cleaned up: the
# recipe's own `System.Package` step needs a working `apt-get install` at
# *container run time*, not just at image build time, and there is no reason
# to make it pay for a redundant `apt-get update` when the image already has
# a fresh index from the build that just happened.
# `cron` is here for `Git.Maintenance`: `git maintenance start` schedules through
# systemd timers or crontab, and a plain container has neither, so the resource
# correctly refuses with `GitMaintenanceSchedulerUnavailable`. Installing cron is
# what its own error message tells you to do, and it turns "cannot be tested here"
# into real coverage.
RUN apt-get update \
    && apt-get install -y --no-install-recommends sudo ca-certificates cron \
    && apt-get clean

# A throwaway user with its own real $HOME. Every `~`-expanded path any
# resource in this repo writes resolves through `os.homedir()`
# (`@machine-run/core`'s `MachinePaths`), so this is what makes "nothing can
# touch a real home directory" true by construction rather than by care:
# this image is never bind-mounted over a host path (see
# scripts/deploy-check.sh), so /home/runner is the only home directory that
# exists anywhere this process can see.
RUN useradd --create-home --shell /bin/bash runner \
    && echo "runner ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/runner \
    && chmod 0440 /etc/sudoers.d/runner

WORKDIR /workspace

# Copied in, not bind-mounted: a bind mount would share the host's
# node_modules (built for macOS/ARM) into a Linux container and would make
# "nothing touches the real machine" depend on remembering not to mount
# anything writable, rather than being structurally true. See
# .dockerignore for what's excluded (host node_modules, lib/, .git/).
#
# `--chown` only affects the files COPY itself creates, not `/workspace`
# itself — that directory was created by `WORKDIR` above, while still root,
# so it stays root-owned even after this. Without the explicit `chown`
# below, `npm install` as `runner` fails with `EACCES` trying to `mkdir
# node_modules` in a directory it cannot write to (found by actually running
# this — see docs/deploy-notes.md).
COPY --chown=runner:runner . .
RUN chown runner:runner /workspace

USER runner
ENV HOME=/home/runner
ENV NPM_CONFIG_FUND=false
ENV NPM_CONFIG_AUDIT=false

# A real, fresh `npm install`, not a copy of the host's. This repo does not
# commit package-lock.json (see the root .gitignore's neighbouring comments),
# so this is the only install this image can do; it also happens to be the
# thing that first surfaced a real bug (see docs/deploy-notes.md) — the host
# had accumulated a second, mismatched `alchemy` install for
# examples/example-machine alone.
RUN npm install

# `alchemy.run.ts`/`alchemy.container.ts` import `@machine-run/*` via each
# package's `"import"` export condition, which points at `./lib/index.js` —
# there is no dev-mode fallback to `./src` under plain `node` (only the
# `"bun"` condition points there). That `lib/` is built on the *host*, before
# `docker build` runs (see scripts/deploy-check.sh:
# `npx tsc -b examples/example-machine`), and copied in by the `COPY` above
# rather than rebuilt here: building the whole workspace's `tsc -b` inside
# this image would fail on packages this example does not even import, while
# other agents' packages are mid-flight elsewhere in this monorepo during
# this session (see docs/deploy-notes.md). `examples/example-machine`'s own
# project graph is what stays green.

ENTRYPOINT ["scripts/container/entrypoint.sh"]
