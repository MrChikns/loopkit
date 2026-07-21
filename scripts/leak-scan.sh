#!/bin/sh
# leak-scan.sh — tripwire for the PUBLIC repo. Fails (exit 1) if a scan target
# contains secrets, credentials, or operator-private residue.
#
# Three pattern sources:
#   1. GENERIC classes below — safe to publish (no real names), catch the usual
#      leak shapes: private keys, cloud/CI/chat tokens, and `secret = "…"` literals.
#   2. DECISIONID below — a concrete `D-NNN` operator-private decision-log citation
#      (e.g. `D-172`, `D-144 clause 3`). This repo's OWN decision log uses a different,
#      local `ADR-NNN` id scheme (docs/decisions/); a bare `D-\d{2,}` token is residue
#      from the operator's private, pre-loopkit decision log and must never land here —
#      describe the behavior instead, or cite the local `ADR-NNN` if one exists.
#      Excludes `ADR-NNN` (word-boundary: the `D` isn't preceded by a non-word char in
#      `ADR-`) and ids immediately followed by a comma, which is how this repo's own
#      docs/tests illustrate the generic `PREFIX-NNN` convention with bare example ids
#      (`D-10, D-100, etc.`) rather than citing a real decision.
#   3. An OPTIONAL, git-ignored `.leakpatterns.local` at the repo root — one
#      extended-regex per line (`#` comments allowed). This is where the operator's
#      real private terms live (product names, personal email, this host's home
#      path). It is NEVER committed, so the denylist itself can't leak.
#
# Modes:  --staged  scan the git index (pre-commit)   [default: --worktree]
#         --head    scan the committed HEAD tree (pre-push)
#         --worktree scan tracked files in the working tree
#         --range <rev-range>  scan `git log` SUBJECT+BODY text for the given
#                  range (e.g. `origin/main..HEAD`, or `HEAD --not --remotes`)
#                  — tree scans never see commit-message-only residue.
#
# Usage:  scripts/leak-scan.sh [--staged|--head|--worktree]
#         scripts/leak-scan.sh --range <rev-range...>
set -eu

MODE="--worktree"
[ $# -gt 0 ] && MODE="$1"
RANGE=""
if [ "$MODE" = "--range" ]; then
  [ $# -ge 2 ] || { echo "leak-scan: --range requires a rev-range argument" >&2; exit 2; }
  shift
  RANGE="$*"
fi

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

# --- generic pattern classes (publishable — contain no private data) ----------
# Precision over recall: each line is a high-signal leak shape, not a broad guess.
GENERIC='-----BEGIN [A-Z ]*PRIVATE KEY-----
AKIA[0-9A-Z]{16}
ghp_[0-9A-Za-z]{36}
github_pat_[0-9A-Za-z_]{22,}
xox[baprs]-[0-9A-Za-z-]{10,}
glpat-[0-9A-Za-z_-]{20,}
[0-9]{8,10}:AA[0-9A-Za-z_-]{33}
(secret|password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret)["'"'"' ]*[:=][ ]*["'"'"'][^"'"'"']{8,}["'"'"']'

# Real email addresses, minus obvious placeholders: reserved/demo TLDs
# (.local/.invalid/.example/.test) and example/noreply/your- sender domains.
EMAIL='[A-Za-z0-9._%+-]+@(?!example\.|test\.|your-|noreply)[A-Za-z0-9.-]+\.(?!local\b|invalid\b|example\b|test\b)[A-Za-z]{2,}'

# Concrete private decision-log citation: `D-NNN` (optionally `D-NNN-SUFFIX`, e.g.
# `D-128-H-CHAT`), word-bounded so `ADR-NNN` never matches, and not immediately
# followed by a comma so a bare format-token example list (`D-10, D-100, etc.`)
# doesn't trip it either.
DECISIONID='\bD-\d{2,}(-[A-Z0-9]+)?\b(?!,)'

# --- build the -e argument list ----------------------------------------------
set --
# generic classes
OLDIFS=$IFS; IFS='
'
for p in $GENERIC; do set -- "$@" -e "$p"; done
IFS=$OLDIFS
# email + decision-id classes (PCRE: negative lookahead)
EMAIL_ARG="$EMAIL"
DECISIONID_ARG="$DECISIONID"

# operator-private denylist (git-ignored, optional)
LOCAL_PATTERNS=""
if [ -f .leakpatterns.local ]; then
  LOCAL_PATTERNS=$(grep -vE '^[[:space:]]*(#|$)' .leakpatterns.local || true)
fi

# --- choose the scan corpus ---------------------------------------------------
# docs/knowledge.md documents the generic `PREFIX-NNN` decision-id convention with
# bare example ids (`D-001`); the two test files exercise the SAME public, documented
# convention (the decision-log markdown parser, the `linkifyDecisionRefs` helper) with
# synthetic ids — none of these three cite a real private decision.
EXCLUDES=":!LICENSE :!*.lock :!*.png :!*.gif :!scripts/leak-scan.sh :!docs/knowledge.md :!packages/console/test/server.test.ts :!packages/ui/test/components.test.ts"
case "$MODE" in
  --staged)   GREP="git grep -I -nE --cached";   GREP_P="git grep -I -nP --cached"; REV="" ;;
  --head)     GREP="git grep -I -nE";            GREP_P="git grep -I -nP";          REV="HEAD" ;;
  --worktree) GREP="git grep -I -nE";            GREP_P="git grep -I -nP";          REV="" ;;
  --range)    GREP="";                           GREP_P="";                        REV="" ;;
  *) echo "leak-scan: unknown mode '$MODE'" >&2; exit 2 ;;
esac

HITS=""
if [ "$MODE" = "--range" ]; then
  # Commit SUBJECT+BODY text for the range — tree scans never see this. No path
  # excludes here (there is no "tree" to path-exclude); a subject line quoting the
  # doc/test exclusions above verbatim is vanishingly unlikely and still worth a look.
  LOG=$(git log --format='%H %s%n%b' $RANGE 2>/dev/null || true)
  if [ -n "$LOG" ]; then
    G=$(printf '%s\n' "$LOG" | grep -inE "$@" 2>/dev/null || true)
    [ -n "$G" ] && HITS="$HITS$G
"
    E=$(printf '%s\n' "$LOG" | grep -inP "$EMAIL_ARG" 2>/dev/null || true)
    [ -n "$E" ] && HITS="$HITS$E
"
    D=$(printf '%s\n' "$LOG" | grep -inP "$DECISIONID_ARG" 2>/dev/null || true)
    [ -n "$D" ] && HITS="$HITS$D
"
    if [ -n "$LOCAL_PATTERNS" ]; then
      LOCAL_HITS=$(printf '%s\n' "$LOCAL_PATTERNS" | while IFS= read -r pat; do
        [ -n "$pat" ] || continue
        printf '%s\n' "$LOG" | grep -inE -e "$pat" 2>/dev/null || true
      done)
      [ -n "$LOCAL_HITS" ] && HITS="$HITS$LOCAL_HITS
"
    fi
  fi
else
  # generic multi-pattern pass
  G=$($GREP -i "$@" $REV -- $EXCLUDES 2>/dev/null || true)
  [ -n "$G" ] && HITS="$HITS$G
"
  # email pass (PCRE)
  E=$($GREP_P "$EMAIL_ARG" $REV -- $EXCLUDES 2>/dev/null || true)
  [ -n "$E" ] && HITS="$HITS$E
"
  # decision-id pass (PCRE)
  D=$($GREP_P "$DECISIONID_ARG" $REV -- $EXCLUDES 2>/dev/null || true)
  [ -n "$D" ] && HITS="$HITS$D
"
  # operator-private denylist pass, one regex at a time (case-insensitive).
  # Pipe→`while IFS= read` so only the read splits on newline — inside the body IFS stays
  # default, or `$GREP`/`$EXCLUDES` word-splitting collapses into one bogus command word.
  if [ -n "$LOCAL_PATTERNS" ]; then
    LOCAL_HITS=$(printf '%s\n' "$LOCAL_PATTERNS" | while IFS= read -r pat; do
      [ -n "$pat" ] || continue
      $GREP -i -e "$pat" $REV -- $EXCLUDES 2>/dev/null || true
    done)
    [ -n "$LOCAL_HITS" ] && HITS="$HITS$LOCAL_HITS
"
  fi
fi

HITS=$(printf '%s' "$HITS" | sed '/^$/d')
if [ -n "$HITS" ]; then
  echo "leak-scan BLOCKED ($MODE) — sensitive residue found:" >&2
  printf '%s\n' "$HITS" | head -40 >&2
  echo "--- fix the content, or (if a false positive) narrow the pattern. Override only after review." >&2
  exit 1
fi
exit 0
