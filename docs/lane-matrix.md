# Lane × guard matrix

**GENERATED — do not hand-edit.** Regenerate with:

```
npm run lane-matrix --workspace packages/core
```

Derived directly from `packages/core/src/beats/dispatch.ts`
by `packages/core/src/lane-matrix.ts` (static analysis of each lane's own function span — see
that file's doc comment for the full rationale). A drift-detection test
(`packages/core/test/lane-matrix.test.ts`) pins the matrix below as a snapshot and fails CI the
moment a lane's real guard set changes — see [ADR-010](decisions/ADR-010-one-lane.md) point 6.

If this table disagrees with the code, the code is right and this file is stale: run the regen
command above, review the diff, and update the test's `EXPECTED_SNAPSHOT` deliberately (not by
blindly accepting whatever the regen produces) before committing both together.

| lane | Touches-overstep | spine check | judge | scout | git push | alreadyShippedCommit | denialNote | gate wrapper | commit side | claim arbitration | post-integration re-gate |
|---|---|---|---|---|---|---|---|---|---|---|---|
| planning | no | no | no | no | no | no | no | none | n/a (no code diff) | claim (shared pick, via batch) | n/a (no merge) |
| target | yes | no | yes | no | no | no | no | runGate (declared) | dispatch (declared) | claim (shared pick, via batch) | re-gate |
| batch | yes | yes | yes | yes | yes | yes | yes | runLaneGate | dispatch (declared) | arbitrate+claim | re-gate |

## Reading the columns

- **Touches-overstep / spine check / judge / scout** — present (`yes`) iff the lane's own code
  calls that guard's real function (`checkTouchesOverstep`, `checkSpine`, `runJudge`,
  `buildScoutPrompt`). A comment merely naming the guard does not count — the generator strips
  comments before matching.
- **git push / alreadyShippedCommit / denialNote** — narrower markers for specific historical
  defect classes (ADR-010 context: WI-161's "no commit" park class, the push step, the
  reality-check fallback).
- **gate wrapper** — which gate-running helper the lane calls: `runLaneGate` (lane-aware
  dispatcher, picks the item's gate id), `runGate` (the plain shell-gate runner, called directly),
  a **local fork** (a gate helper a lane's own file defines while the canonical one lives in
  `dispatch.ts` — no lane does this today), or `none` (no code diff to gate — the planning
  lane only queues child items).
- **commit side** — `dispatch` (dispatch stages + commits the worker's in-scope output itself,
  via either the shared `attemptScopedCommit` helper or the batch lane's inline
  `planScopedCommit` + `git commit` sequence), `worker` (the spawned agent holds a
  commit-capable tool grant and commits itself — no lane declares this since ADR-013 deleted the
  conductor), or `n/a (no code diff)` (planning lane).
- **claim arbitration** — how the lane reserves an item before building it (ADR-007
  claim-before-pick): `arbitrate+claim` (the lane's own span runs the inline arbitration —
  `decideClaimArbitration`, yielding items a foreign session claimed *or* a foreign in-flight
  build holds — and appends its own `item.claimed`, whether inline or by calling the shared
  `claimBeforePick` closure against its own candidate list), `claim (claimItems)` (reserves
  through the shared session verb, which re-folds under the ledger lock and skips what another
  session actively holds — it yields to a foreign *claim*, but not to a foreign in-flight
  *build*; no lane reports this since ADR-013), `claim (shared pick, via batch)` (reserved, but
  NOT by this lane's own code — the
  reservation call site names this lane's candidate list from inside `runDispatch`, i.e. the
  batch lane's span; today this is the **target** lane, whose reservation moved into the shared
  `makeClaimBeforePick` factory under WI-186 without the target lane's own functions
  `finalizeTargetBuild`/`runTargetLane` ever calling it directly), `defer-read` (reads
  `isClaimActive` to skip claimed items — a read, not a reservation, so it cannot close the
  read-to-spawn race), or `none` (reserves nowhere — neither its own span nor, for planning/target, the
  shared pick site). A `none`/`claim (shared pick, via batch)` swap on this cell is exactly the
  class of regression this column exists to catch — see
  [`limitations.md`](limitations.md).
- **post-integration re-gate** — whether the lane re-verifies the *combined* state when its merge
  destination moves during the build: `re-gate` (replays the branch onto the fresh tip — `git
  rebase`, or the push-race `git reset` + re-merge — and runs the gate again before merging),
  `gate-once` (gates on its own untouched branch and merges regardless, so the merged result is
  a combination nothing ever tested), or `n/a (no merge)` (no merge step at all — the planning
  lane only queues child items). Detection requires the gate call to appear *after* the replay,
  not merely somewhere in the lane.
