#!/bin/sh
# Bare-metal bootstrap for machine-run — gets a fresh machine from "just
# cloned this repo" to "ready to run `npm run plan`/`npm run deploy` from a
# machine directory." Node + npm are the default runtime; pass --bun or
# --deno to use one of those instead (both are opt-in, never required).
#
# Usage:
#   ./bootstrap.sh            # default: Node.js + npm
#   ./bootstrap.sh --bun      # opt in to bun
#   ./bootstrap.sh --deno     # opt in to deno
set -eu

RUNTIME="node"
for arg in "$@"; do
  case "$arg" in
    --bun) RUNTIME="bun" ;;
    --deno) RUNTIME="deno" ;;
  esac
done

echo "==> machine-run bootstrap (runtime: $RUNTIME)"

os_package_manager() {
  case "$(uname -s)" in
    Darwin) echo "brew" ;;
    Linux)
      if [ -f /etc/debian_version ]; then echo "apt"
      elif [ -f /etc/redhat-release ]; then echo "dnf"
      elif [ -f /etc/arch-release ]; then echo "pacman"
      else echo "brew"
      fi
      ;;
    *) echo "brew" ;;
  esac
}

PKG_MANAGER=$(os_package_manager)

ensure_package_manager() {
  case "$PKG_MANAGER" in
    brew)
      if [ "$(uname -s)" = "Darwin" ] && ! xcode-select -p >/dev/null 2>&1; then
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
      ;;
    apt|dnf|pacman)
      echo "==> Using the system's $PKG_MANAGER — already present on this distro."
      ;;
  esac
}

install_pkg() {
  name="$1"
  case "$PKG_MANAGER" in
    brew) brew install "$name" ;;
    apt) sudo apt-get install -y "$name" ;;
    dnf) sudo dnf install -y "$name" ;;
    pacman) sudo pacman -S --noconfirm "$name" ;;
  esac
}

ensure_package_manager

case "$RUNTIME" in
  node)
    if ! command -v node >/dev/null 2>&1; then
      echo "==> Installing Node.js"
      case "$PKG_MANAGER" in
        apt) install_pkg nodejs ;;
        *) install_pkg node ;;
      esac
    fi
    if ! command -v npm >/dev/null 2>&1; then
      echo "==> npm not found alongside node — install it via your OS's node package or nvm/fnm, then re-run."
      exit 1
    fi
    echo "==> Installing workspace dependencies (npm)"
    npm install
    RUN="npm run"
    ;;
  bun)
    if ! command -v bun >/dev/null 2>&1; then
      echo "==> Installing bun"
      install_pkg bun 2>/dev/null || curl -fsSL https://bun.sh/install | bash
    fi
    echo "==> Installing workspace dependencies (bun)"
    bun install
    RUN="bun run"
    ;;
  deno)
    if ! command -v deno >/dev/null 2>&1; then
      echo "==> Installing deno"
      install_pkg deno 2>/dev/null || curl -fsSL https://deno.land/install.sh | sh
    fi
    echo "==> deno support is opt-in and unverified — machine-run's own packages are only tested under node/bun so far."
    RUN="deno task"
    ;;
esac

cat <<EOF

Bootstrap complete ($RUNTIME). Next steps:

  cd <your-machines-repo>/<this-machine>   # e.g. a sibling machines-<you> repo's macbook-neo/
  $RUN plan                                # preview what would change — changes nothing
  $RUN deploy                              # apply for real

machine-run itself is the framework (see examples/example-machine/ here for
a demo recipe) — your own machine recipes belong in a separate repo that
depends on this one, so they can carry your real values without living in a
tool meant for public release.
EOF
