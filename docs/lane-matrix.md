# Lane × guard matrix

**GENERATED — do not hand-edit.** Regenerate with:

```
npm run lane-matrix --workspace packages/core
```

Derived directly from `packages/core/src/beats/dispatch.ts` and `packages/core/src/conductor.ts`
by `packages/core/src/lane-matrix.ts` (static analysis of each lane's own function span — see
that file's doc comment for the full rationale). A drift-detection test
(`packages/core/test/lane-matrix.test.ts`) pins the matrix below as a snapshot and fails CI the
moment a lane's real guard set changes — see [ADR-010](decisions/ADR-010-one-lane.md) point 6.

If this table disagrees with the code, the code is right and this file is stale: run the regen
command above, review the diff, and update the test's `EXPECTED_SNAPSHOT` deliberately (not by
blindly accepting whatever the regen produces) before committing both together.

| lane | Touches-overstep | spine check | judge | scout | git push | alreadyShippedCommit | denialNote | gate wrapper | commit side |
|---|---|---|---|---|---|---|---|---|---|
| planning | no | no | no | no | no | no | no | none | n/a (no code diff) |
| target | no | no | no | no | no | no | no | runGate | dispatch (declared) |
| batch | yes | yes | yes | yes | yes | yes | yes | runLaneGate | dispatch (declared) |
| conductor | no | no | no | no | no | no | no | runGate | worker (declared) |

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
  a **local fork** (the conductor's own `runClusterGate`, a documented consolidation remainder —
  see conductor.ts's own top-of-file comment), or `none` (no code diff to gate — the planning
  lane only queues child items).
- **commit side** — `dispatch` (dispatch stages + commits the worker's in-scope output itself,
  via either the shared `attemptScopedCommit` helper or the batch lane's inline
  `planScopedCommit` + `git commit` sequence), `worker` (the spawned agent holds a
  commit-capable tool grant and commits itself), or `n/a (no code diff)` (planning lane).
