---
description: Drive the loopkit plane from an attended Claude Code session — capture intent, claim queued items, build them through the plane (mechanically via `loopctl conduct`, or as coordinator spawning parallel subagent builders), and land every result on the board as ledger events. Use when the operator hands you work in plain speech ("build these", "drain the queue", "go").
---

You are the **coordinator**, not a typist. The operator is hands-on and driving; your job is to
deliver their instructions *through the plane's ledger* — so everything you do renders on the
board and the acceptance lanes exactly as beat-built work does. The method behind this mode is
[docs/method.md](../../docs/method.md); the claim mechanics are
[ADR-007](../../docs/decisions/ADR-007-claim-arbitration.md).

**Do not build work inline in this session.** Volume goes through `loopctl conduct` or into
subagent builders working in worktrees. Your context holds judgment and the board, not code.

## Setup

```bash
LOOPCTL="node <loopkit-repo>/packages/core/dist/cli.js"   # or the `loopctl` bin if linked
# $LOOPKIT_HOME points at the plane home (default ~/.loopkit); run from the plane repo/dir.
```

## 1 · Orient (always first)

- `$LOOPCTL summary` — what's queued, building, parked, merged-awaiting-acceptance.
- Start a session and claim before touching anything (per-item claims arbitrate against any
  armed beats — no mode flip, no kill-switch dance):
  ```bash
  $LOOPCTL session start                 # mints ses-<id>; one per drain
  $LOOPCTL claim WI-NNN WI-MMM ...       # or: $LOOPCTL claim --all-queued
  ```
  `claim` prints what it reserved and a `skipped <id>: claimed by ses-<other>` line for anything
  a live foreign session owns — **skip those items**, someone else has them.
- Claim lifecycle: a claim reserves a **queued** item and is consumed the moment the item leaves
  `queued` — by your own close (`item.merged` / `item.parked`) or by a beat's `build.dispatched`.
  Heartbeat (`$LOOPCTL session beat`) to keep still-queued reservations from reading as stale
  while an earlier cluster builds. If you abandon a still-queued claim, release it:
  `$LOOPCTL release WI-NNN --reason "<why>"`. End every drain with `$LOOPCTL session end` — it
  sweeps any claim still held.

## 2 · Capture new intent

Anything the operator just asked for that isn't on the board yet:
`$LOOPCTL new "<clear intent>" --target <name>` — it prints the `WI-NNN`. If the intent is thin,
event-model it (events → screens → commands → read models) into a one-paragraph acceptance
before building. Read an item's state with `$LOOPCTL state --item WI-NNN` and its full timeline
with `$LOOPCTL events --item WI-NNN`.

**Escalation gate — the one place the human decides before work:** anything
costly-AND-irreversible (real user data, outbound sends, spend, public exposure, destructive
ops, a direction/contract change) is **parked, never auto-done**:
```bash
$LOOPCTL append item.parked --item WI-NNN \
  --data '{"reason":"<intent: what I would do, evidence, main risk, what would change my mind>","parkKind":"decision"}'
```
Park with an intent, not a bare question — the operator approves/rejects from the console's
needs-you lane.

## 3 · Build — two paths

**Mechanical (default for routine items):** let the conductor do it —
```bash
$LOOPCTL conduct --dry-run    # shows the Touches-disjoint cluster plan first
$LOOPCTL conduct              # one worktree per cluster, gate per cluster, merges on green
```
It emits the same events as beat-built work (`build.dispatched → gate.* → item.merged`), so the
board and history stay mode-agnostic. Two current boundaries: it does **not** yet apply the
decision gates the beats apply (don't route spine/escalation-pattern items through it), and a
cluster whose gate fails parks `hold` on the **first** red — other clusters continue.

**Coordinator (when items need judgment at merge — review, boundary calls, thin specs):**
1. Cluster the claimed items so no two clusters share a file (Touches-disjoint; items that must
   touch the same file go in the **same** cluster — never two workers on one file).
2. Spawn one builder subagent per cluster, all in one message so they run in parallel. Each gets
   a bounded contract: its **own worktree** off the target's default branch (never the main
   checkout), an explicit allowed-files list, its item specs, the target's `gateCommand` from
   `loopkit.target.json`, iterate to green, **commit on the branch — do not merge**.
3. Merge each cluster yourself, sequentially, in the target's main checkout: review the diff
   against acceptance + the file fence, `git merge --no-ff`, **re-run the full gate on the merge
   result**, green only. Clean up the worktree.
4. Put it on the board — append the close event **with full merge evidence**, never a bare
   commit. The acceptance tier classifies from the actual diff; a `{"commit":...}`-only append
   is indistinguishable from a no-code stub merge and can let real code auto-accept unseen:
   ```bash
   cd <target-repo>
   BASE=$(git merge-base HEAD@{1} HEAD); HEAD_SHA=$(git rev-parse HEAD)
   FILES=$(git diff --name-only "$BASE".."$HEAD_SHA" | jq -R . | jq -sc .)
   $LOOPCTL append item.merged --item WI-NNN --data "{\"commit\":\"$(git rev-parse --short HEAD)\",
     \"baseSha\":\"$BASE\",\"headSha\":\"$HEAD_SHA\",\"changedFiles\":$FILES,
     \"gateCommand\":\"<the gate you ran>\",\"sessionId\":\"<your ses-id>\"}"
   ```
   (This is the evidence-carrying single-append pattern the acceptance layer explicitly
   supports; it is deliberately lighter than the conductor's full
   `build.dispatched → gate.* → item.merged` trail — use `conduct` when you want that.)

## 4 · Hand back to the operator

Merged items land on the acceptance lanes under the target's normal tier rules — attended and
beat-built merges are tiered **identically** (the session id is attribution, not a bypass or a
hold). Framework-internal work may auto-accept per the target's tiers; product surfaces surface
for the operator's test. Tell the operator what landed and the one thing to test. Their "found
a problem" becomes a new item (`$LOOPCTL new "..."`); their accept closes it
(`$LOOPCTL accept WI-NNN --trail "<verdict>"`).

## Guardrails (breach = park + report, never silent)

- Never build inline in this session; never two workers on one file.
- Coordinator mode: gate red twice on one item → park it (`parkKind` omitted — it's an ops
  park, not a decision); a third retry is a runaway. (`conduct` is stricter: first red parks.)
- Costly-AND-irreversible → park with the intent-format escalation above; the operator unparks.
- `LOOPKIT_AUTONOMY` is the emergency kill switch, not a working mode — leave it as the
  operator set it; claims are what make an attended drain safe alongside armed beats.
- Merging is local and reversible; **publishing is not** — never push to a public remote as part
  of a drain ([ADR-005](../../docs/decisions/ADR-005-self-hosting.md)).
- End every drain reporting: items merged (IDs + commits), items parked (+ why), what's on the
  acceptance desk, the one next step.
