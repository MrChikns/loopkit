#!/bin/sh
# Install the leak-scan git hooks by pointing core.hooksPath at the tracked
# scripts/git-hooks directory. Idempotent; run once per clone.
set -eu
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
chmod +x scripts/git-hooks/pre-commit scripts/git-hooks/pre-push scripts/leak-scan.sh 2>/dev/null || true
git config core.hooksPath scripts/git-hooks
echo "installed: core.hooksPath -> scripts/git-hooks (pre-commit + pre-push leak-scan)"
if [ ! -f .leakpatterns.local ]; then
  echo "note: no .leakpatterns.local found — generic secret/PII patterns are active, but"
  echo "      add a git-ignored .leakpatterns.local (one regex per line) to also block your"
  echo "      own private names/paths. See scripts/leak-scan.sh for the format."
fi
