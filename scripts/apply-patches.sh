#!/usr/bin/env bash
# Applies the patches in `patches/` to `node_modules`, after every install.
#
# This is not a fork. Every patch here is a handful of lines against a pinned
# version, kept in the open, and expected to be deleted the moment upstream
# ships the fix. What it deliberately avoids is the alternative — vendoring
# `alchemy` — which would put a second copy of its identity-sensitive
# `Resource`/`Provider` classes in the tree. That dual-package hazard has
# already bitten this repo twice; see docs/SYSTEM-DESIGN.md.
#
# There is no auto-sync, and claiming otherwise would be a lie. What there is:
# a patch either applies to the pinned version or this script fails the install
# with the file that moved. A version bump that touches patched code cannot pass
# silently, which is the property that actually matters.
set -euo pipefail

cd "$(dirname "$0")/.."

shopt -s nullglob
patches=(patches/*.patch)
if [ ${#patches[@]} -eq 0 ]; then
  exit 0
fi

for patch in "${patches[@]}"; do
  target_pkg="$(basename "$patch" .patch)"

  # Already applied — the common case on a repeat `npm install` that did not
  # actually rewrite node_modules. Reverse-check rather than tracking state.
  if git apply --reverse --check "$patch" 2>/dev/null; then
    echo "patches: $target_pkg already applied"
    continue
  fi

  if ! git apply --check "$patch" 2>/dev/null; then
    echo "patches: $patch NO LONGER APPLIES." >&2
    echo >&2
    echo "  Upstream has changed the code this patch targets, the dependency" >&2
    echo "  version moved, or — on Windows — the patch was line-ending" >&2
    echo "  converted on checkout. \`.gitattributes\` marks *.patch as -text to" >&2
    echo "  prevent the last one; check it is still there before assuming drift." >&2
    echo "  Do not force it. Check whether the bug it works around" >&2
    echo "  is fixed upstream — if it is, delete the patch and the workaround it" >&2
    echo "  supports. If it is not, regenerate the patch against the new source." >&2
    echo "  Each patch's header says what it fixes and where that is documented." >&2
    exit 1
  fi

  git apply "$patch"
  echo "patches: applied $target_pkg"
done
