#!/bin/sh
# leak-scan.sh — tripwire for the PUBLIC repo. Fails (exit 1) if a scan target
# contains secrets, credentials, or operator-private residue.
#
# Five pattern sources:
#   0. AGENTSESSION below — an AI-agent session/conversation handle: a
#      `X-Session: <url>` commit trailer, an account-scoped agent console URL,
#      or a bare `session_<opaque>` id. Not a secret — a *tooling artifact* — but
#      it links published history to one operator's private agent account, and the
#      agent commit convention re-acquires it on every single commit, so it lands
#      in bulk. It is committed here (unlike the venture-specific terms in
#      `.leakpatterns.local`) precisely so every clone and CI runner inherits it.
#      Per-line escape hatch: `leak-scan:allow-agent-session`.
#   1. GENERIC classes below — safe to publish (no real names), catch the usual
#      leak shapes: private keys, cloud/CI/chat tokens, and `secret = "…"` literals.
#   2. DECISIONID below — a concrete `D-NNN` operator-private decision-log citation
#      (e.g. `D-042`, `D-042 clause 3`). This repo's OWN decision log uses a different,
#      local `ADR-NNN` id scheme (docs/decisions/); a bare `D-\d{2,}` token is residue
#      from the operator's private, pre-loopkit decision log and must never land here —
#      describe the behavior instead, or cite the local `ADR-NNN` if one exists.
#      Excludes `ADR-NNN` (word-boundary: the `D` isn't preceded by a non-word char in
#      `ADR-`) and ids immediately followed by a comma, which is how this repo's own
#      docs/tests illustrate the generic `PREFIX-NNN` convention with bare example ids
#      (`D-10, D-100, etc.`) rather than citing a real decision.
#      DECISIONID_CONCAT alongside it catches the same id assembled at runtime instead
#      of written as a literal token — `['D', '000'].join('-')`, `'D-' + n`, a template
#      literal `` `D-${n}` ``, or `.concat(...)` — shapes the literal-token check
#      above cannot see. A line that needs to build a `D-`-shaped
#      string for a legitimate reason (documenting or exercising the detector regex
#      itself, e.g. in a test) can carry the id anyway by appending the marker comment
#      `leak-scan:allow-decision-id` to that line.
#   3. An OPTIONAL, git-ignored `.leakpatterns.local` at the repo root — one
#      extended-regex per line (`#` comments allowed). This is where the operator's
#      real private terms live (product names, personal email, this host's home
#      path). It is NEVER committed, so the denylist itself can't leak.
#   4. `leak-scan:allow-decision-id` — the per-line escape hatch from #2, opt-in
#      and reviewable in the diff, unlike a blanket file exclude.
#
# Modes:  --staged  scan the git index (pre-commit)   [default: --worktree]
#         --head    scan the committed HEAD tree (pre-push)
#         --worktree scan tracked files in the working tree
#         --range <rev-range>  scan COMMIT MESSAGES + AUTHOR/COMMITTER METADATA
#                  (name + email) for the given range (e.g. `origin/main..HEAD`,
#                  or `HEAD --not --remotes`) — tree scans never see this residue.
#                  The range is ALWAYS explicit: there is no inferred default,
#                  because a wrong default that scans nothing looks identical to
#                  a clean result. Merge commits ARE included (the pre-commit
#                  hook never runs for them, so this is their only tripwire).
#                  A commit made on a misconfigured machine (a real personal
#                  email, a real hostname baked into `user.name`) leaks through
#                  `git log`'s author/committer fields even when the message
#                  and diff are spotless, so those fields are part of the
#                  materialized corpus, not just the subject/body.
#
# Exit:   0  clean — a corpus was scanned and nothing matched
#         1  hit — sensitive residue found (details on stderr)
#         2  usage error: unknown mode, missing/invalid rev-range, or a
#            required regex engine is unavailable
#         3  NOTHING SCANNED — `--range` resolved to zero commits. Deliberately
#            NOT 0: "I scanned nothing" must never read as "it's clean".
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

# --- agent session/conversation handles (publishable — no private data) -------
# The class that reaches history through COMMIT MESSAGES, not diffs: coding-agent
# commit conventions append a session trailer, so one un-scrubbed convention puts
# an account-scoped handle on every commit an agent makes. Three shapes, each
# high-signal (prose that merely *names* the class, e.g. "a Claude-Session
# trailer", does not match — a URL or a long opaque id is required):
#   1. a `<Something>-Session:` trailer whose value is a URL
#   2. a deep link into an agent console, carrying an opaque handle
#   3. a bare `session_<16+ alphanumerics>` id, wherever it appears
AGENTSESSION='[A-Za-z][A-Za-z0-9]*-session:[[:space:]]*https?://
https?://(claude\.ai|chatgpt\.com|chat\.openai\.com)/[A-Za-z0-9._/-]*[A-Za-z0-9_-]{16,}
session_[A-Za-z0-9]{16,}'

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
# The leading `(?<!…)(?!no-?reply@)` completes an intent the domain-side lookahead
# already expressed but could not reach: a no-reply address identifies nobody, and
# the standard AI co-author trailer (`… <noreply@…>`) is on every agent commit, so
# without this the commit-message corpus below flags every single one and the
# tripwire gets routinely overridden. The lookbehind pins the match to the START of
# a local part, so `no-reply@…` can't be re-matched from a later offset.
# The trailing `(?<!users\.noreply\.github\.com)(?=[^A-Za-z0-9.]|$)` is the SAME
# idea for one specific, narrow host: GitHub's own commit-identity placeholder
# (`<id>+<username>@users.noreply.github.com`) contains no real identity beyond
# a public GitHub username, and became reachable by this class the moment --range
# started scanning AUTHOR/COMMITTER metadata (WI-243) — every commit an operator
# makes with GitHub's privacy setting on now carries this domain, so without the
# exemption --range self-wedges on the operator's own ordinary history. The
# exclusion is anchored to the domain's exact end (lookbehind matches only when
# `users.noreply.github.com` is immediately followed by a non-domain character or
# end-of-line), so `users.noreply.github.com` as a mere PREFIX of a longer, hostile
# domain (`…@users.noreply.github.com.evil.com`) still matches and blocks. This is
# deliberately narrow to ONE host, not a general "widen the noreply list" — do not
# add further hosts here without a fresh decision.
EMAIL='(?<![A-Za-z0-9._%+-])(?!no-?reply@)[A-Za-z0-9._%+-]+@(?!example\.|test\.|your-|noreply)[A-Za-z0-9.-]+\.(?!local\b|invalid\b|example\b|test\b)[A-Za-z]{2,}(?<!users\.noreply\.github\.com)(?=[^A-Za-z0-9.]|$)'

# Concrete private decision-log citation: `D-NNN` (optionally `D-NNN-SUFFIX`, e.g.
# `D-042-H-CHAT`), word-bounded so `ADR-NNN` never matches, and not immediately
# followed by a comma so a bare format-token example list (`D-10, D-100, etc.`)
# doesn't trip it either.
DECISIONID='\bD-\d{2,}(-[A-Z0-9]+)?\b(?!,)'

# Same private decision id, assembled at runtime instead of written as a literal
# token — shapes the literal-token check above cannot see. Four join/
# concat idioms, high-signal because each requires a quoted `D` or `D-` literal
# right next to a concat operator, not just any string containing the letter D:
#   1. array + join:  ['D', '000']            (join('-') call itself isn't required)
#   2. plus-concat:   'D-' + n   /   n + 'D-'
#   3. template lit:  `D-${n}`
#   4. .concat():     'D-'.concat(n)
DECISIONID_CONCAT='\[\s*["\x27]D["\x27]\s*,\s*["\x27][0-9]{2,}[A-Za-z0-9-]*["\x27]|["\x27]D-?["\x27]\s*\+|\+\s*["\x27]D-?["\x27]|`D-?\$\{|["\x27]D-?["\x27]\s*\.concat\('

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
DECISIONID_CONCAT_ARG="$DECISIONID_CONCAT"
# inline escape hatch for a legitimate `D-`-shaped example (fixtures/docs/tests
# exercising the detector itself): a line carrying this marker is exempt from
# BOTH decision-id checks above. Opt-in and per-line — unlike a whole-file
# EXCLUDES entry, a real leak can't hide behind "this file is just examples".
DECISIONID_ALLOW_MARKER='leak-scan:allow-decision-id'
# Same per-line idiom for the agent-session class, kept as a SEPARATE marker so
# neither escape hatch silently widens the other's reach.
AGENTSESSION_ALLOW_MARKER='leak-scan:allow-agent-session'

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

TMP=""
cleanup() { if [ -n "$TMP" ]; then rm -rf "$TMP"; fi; }
trap cleanup EXIT HUP INT TERM

case "$MODE" in
  --staged)   GREP="git grep -I -nE --cached";   GREP_P="git grep -I -nP --cached"; REV="" ;;
  --head)     GREP="git grep -I -nE";            GREP_P="git grep -I -nP";          REV="HEAD" ;;
  --worktree) GREP="git grep -I -nE";            GREP_P="git grep -I -nP";          REV="" ;;
  --range)
    # Materialise the commit-message-AND-metadata corpus as ONE FILE PER COMMIT,
    # named by its sha, then scan it with the very same `git grep` passes the
    # tree modes use. Two reasons this is not a plain `grep` over `git log` output:
    #   1. one regex engine everywhere. BSD/macOS `grep` has no `-P`, so piping
    #      the log through `grep -P` made the email and decision-id classes match
    #      NOTHING here — silently, because the error went to /dev/null.
    #   2. a hit is reported as `<sha>:<line-in-message>:<text>` — the same
    #      `path:line:text` shape as a tree hit, and it names the commit.
    # The materialized file carries author+committer name/email ahead of the
    # subject/body (`%an <%ae>` / `%cn <%ce>`, then `%s%n%b`): a commit made on a
    # misconfigured machine can have a spotless message yet a real personal
    # email or hostname-derived name in these fields, and that never reaches a
    # tree scan at all — it lives only in commit metadata.
    if ! SHAS=$(git rev-list $RANGE 2>&1); then
      echo "leak-scan: --range '$RANGE' is not a valid rev-range:" >&2
      printf '%s\n' "$SHAS" >&2
      exit 2
    fi
    if [ -z "$SHAS" ]; then NCOMMITS=0; else NCOMMITS=$(printf '%s\n' "$SHAS" | wc -l | tr -d ' '); fi
    if [ "$NCOMMITS" -eq 0 ]; then
      echo "leak-scan: NOTHING SCANNED — --range '$RANGE' resolved to 0 commits." >&2
      echo "  This is NOT a clean result. Check the range: typo, wrong remote, or" >&2
      echo "  already-pushed commits. Exit 3 (not 0) so green can't mean empty." >&2
      exit 3
    fi
    TMP=$(mktemp -d "${TMPDIR:-/tmp}/leak-scan.XXXXXX")
    printf '%s\n' "$SHAS" | while IFS= read -r sha; do
      [ -n "$sha" ] || continue
      git log -1 --format='%an <%ae>%n%cn <%ce>%n%s%n%b' "$sha" > "$TMP/$sha"
    done
    echo "leak-scan: --range '$RANGE' — scanning $NCOMMITS commit message(s)." >&2
    GREP="git grep --no-index -I -nE"; GREP_P="git grep --no-index -I -nP"; REV=""
    EXCLUDES="."          # no tree paths to exclude; the corpus IS the message set
    cd "$TMP"
    ;;
  *) echo "leak-scan: unknown mode '$MODE'" >&2; exit 2 ;;
esac

# Engine guard. Every PCRE pass below routes its own errors to /dev/null (a
# no-match is an error-free exit 1), which is exactly how a missing `-P` went
# undetected for the whole life of --range. Probe once, loudly, up front.
PCRE_ERR=$($GREP_P 'leak-scan-pcre-engine-probe' $REV -- $EXCLUDES 2>&1 >/dev/null || true)
if [ -n "$PCRE_ERR" ]; then
  echo "leak-scan: PCRE engine unavailable — the email/decision-id classes cannot run:" >&2
  printf '%s\n' "$PCRE_ERR" >&2
  exit 2
fi

# --- the passes. ONE block for every mode: the corpus (`$GREP`/`$REV`/`$EXCLUDES`)
# is whatever the case above selected, so a pattern class can never apply to the
# tree but not to commit messages, which is how the message channel went unwatched.
HITS=""
# generic multi-pattern pass
G=$($GREP -i "$@" $REV -- $EXCLUDES 2>/dev/null || true)
[ -n "$G" ] && HITS="$HITS$G
"
# agent session/conversation pass — one regex at a time (see the denylist pass
# below for why the pipe→`while read` shape), with its own per-line escape hatch
A=$(printf '%s\n' "$AGENTSESSION" | while IFS= read -r pat; do
  [ -n "$pat" ] || continue
  $GREP -i -e "$pat" $REV -- $EXCLUDES 2>/dev/null || true
done | sort -u | grep -vF "$AGENTSESSION_ALLOW_MARKER" 2>/dev/null || true)
[ -n "$A" ] && HITS="$HITS$A
"
# email pass (PCRE)
E=$($GREP_P "$EMAIL_ARG" $REV -- $EXCLUDES 2>/dev/null || true)
[ -n "$E" ] && HITS="$HITS$E
"
# decision-id pass (PCRE)
D=$($GREP_P "$DECISIONID_ARG" $REV -- $EXCLUDES 2>/dev/null | grep -vF "$DECISIONID_ALLOW_MARKER" 2>/dev/null || true)
[ -n "$D" ] && HITS="$HITS$D
"
# decision-id-via-concatenation pass (PCRE) — same escape hatch
C=$($GREP_P "$DECISIONID_CONCAT_ARG" $REV -- $EXCLUDES 2>/dev/null | grep -vF "$DECISIONID_ALLOW_MARKER" 2>/dev/null || true)
[ -n "$C" ] && HITS="$HITS$C
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

HITS=$(printf '%s' "$HITS" | sed '/^$/d')
if [ -n "$HITS" ]; then
  echo "leak-scan BLOCKED ($MODE) — sensitive residue found:" >&2
  printf '%s\n' "$HITS" | head -40 >&2
  echo "--- fix the content, or (if a false positive) narrow the pattern. Override only after review." >&2
  exit 1
fi
exit 0
