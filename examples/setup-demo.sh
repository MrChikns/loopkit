#!/usr/bin/env bash
#
# setup-demo.sh — materialize the notes-target template into a real, registerable target repo.
#
# The template under examples/notes-target/ is deliberately NOT a git repo (no nested .git), so
# it can live inside this repo. This script copies it to a standalone directory, `git init`s it
# with a `main` branch, and makes the initial commit — leaving a repo ready for:
#
#     node packages/core/dist/cli.js target add <dir>
#     node packages/core/dist/cli.js new "add a deleteNote helper"   # stamps the sole target
#
# Usage:  examples/setup-demo.sh [target-dir]
#   target-dir  where to materialize the demo (default: ~/loopkit-demo/notes).
#   Avoid /tmp on macOS: its symlink canonicalization confuses worker sandboxes.
set -euo pipefail

TARGET_DIR="${1:-$HOME/loopkit-demo/notes}"

case "$TARGET_DIR" in
  /tmp/*|/private/tmp/*)
    echo "refusing a target dir under /tmp — macOS symlink canonicalization breaks worker sandboxes" >&2
    exit 1
    ;;
esac
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="$SCRIPT_DIR/notes-target"

if [ ! -d "$TEMPLATE_DIR" ]; then
  echo "template not found at $TEMPLATE_DIR" >&2
  exit 1
fi

if [ -e "$TARGET_DIR" ]; then
  echo "refusing to overwrite existing path: $TARGET_DIR" >&2
  echo "remove it first, or pass a different target-dir" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"
# Copy the template contents (not the containing dir). The template carries no .git, so nothing
# to strip.
cp -R "$TEMPLATE_DIR"/. "$TARGET_DIR"/

cd "$TARGET_DIR"
git init -b main -q
git add -A
git -c user.email="demo@loopkit.local" -c user.name="loopkit demo" commit -q -m "chore: initial notes-demo target"

echo "Demo target ready at: $TARGET_DIR"
echo
echo "Next:"
echo "  node packages/core/dist/cli.js target add $TARGET_DIR"
echo "  node packages/core/dist/cli.js target list"
