#!/bin/sh
# Bare-metal bootstrap for machine-run — gets a fresh Mac from "just cloned
# this repo" to "ready to run `bun run plan`/`bun run deploy` from an app
# directory." Everything after this point is machine-run's own job; this
# script only exists to install the two things it depends on (Homebrew, bun)
# before it can run at all.
set -eu

echo "==> machine-run bootstrap"

if ! xcode-select -p >/dev/null 2>&1; then
  echo "==> Installing Xcode Command Line Tools (a GUI dialog will open)"
  echo "    Finish that install, then re-run this script."
  xcode-select --install
  exit 1
fi

if ! command -v brew >/dev/null 2>&1; then
  echo "==> Installing Homebrew"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi

if [ -x /opt/homebrew/bin/brew ]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
elif [ -x /usr/local/bin/brew ]; then
  eval "$(/usr/local/bin/brew shellenv)"
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "==> Installing bun"
  brew install oven-sh/bun/bun
fi

echo "==> Installing workspace dependencies"
bun install

cat <<'EOF'

Bootstrap complete. Next steps:

  cd apps/<this-machine>          # e.g. apps/macbook-neo
  bun run plan                    # preview what would change — changes nothing
  bun run deploy                  # apply for real

If this machine doesn't have an apps/<name>/ directory yet, copy an existing
one and adjust its alchemy.run.ts first.
EOF
