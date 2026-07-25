# ADR-010 — One build lane, parameterised (collapse the four-lane topology)

**Status:** active

## Context

The plane's conceptual model is a single pipeline: intent arrives, a planner slices it into
work items, a prioritised queue drains in parallel, and anything needing human judgement is
escalated. Self-heal and calibration ride underneath. Every one of those concepts is
implemented and working — priority ordering is real (`dispatch.ts` `PRIORITY_ORDER`, the
picker sorts on it), the planner really does decompose and queue children, the Touches-disjoint
parallel drain is real, and parks/acceptance-tiers really do route judgement.

The defect is not the model. It is that the model is implemented **four separate times**:

| lane | entry | commit path | guards present |
|---|---|---|---|
| planning | `dispatch.ts` planning lane | worker | (n/a — queues children) |
| target | `runTargetLane` / `finalizeTargetBuild` | worker → *now* dispatch-side | no Touches-overstep, no spine, no judge, no push |
| batch / engineering | inlined in `runDispatch` | dispatch-side (inline copy) | full set, incl. `alreadyShippedCommit`, `denialNote` |
| conductor (attended) | `conductor.ts` (`loopctl conduct`) | worker — and the prompt now forbids it | no spine, no overstep, no judge; local forks of `runGate`/`persistWorkerLog` |

`buildPrompt` takes nine positional parameters; the batch lane passes nine, target five,
conductor three. **Every new feature therefore lands in one lane and silently skips the
others.** That is a structural guarantee of divergence, not an accident of tidiness.

Three separate production defects on 2026-07-25 were this one cause wearing three costumes:

1. A shared-prompt edit (WI-161) told workers *"you do not hold a git-commit tool"* while the
   target lane still granted `BUILDER_TOOLS` and depended on worker-side commits. 19 historical
   `no commit` parks (~14% of dispatches) became 3-of-3 after the change. The suite of 1921
   tests passed throughout — the one target-lane E2E test's fake provider commits *on the
   worker's behalf*, so it asserted a property the harness supplied, not the system.
2. The scout (`item.briefed`) and judge (`review.verdict`) have **never** fired in 2,627 ledger
   events. Not config, not a stale build: they live in the batch lane, and `finalizeTargetBuild`
   has no judge stage at all. All real work goes through the target lane.
3. The conductor lane is broken by mechanism (1) and still is — same shared prompt, still grants
   commit tools, no dispatch-side commit, hard-parks at `'cluster produced no commit'`.

The conductor lane is also not vestigial: it is the codified form of the attended coordinator
workflow that is the operator's *default* mode. Hand-executing that procedure instead has its
own measured failure modes (on 2026-07-25 two builder agents edited the primary checkout
instead of their worktree before self-correcting; merge ordering and `item.merged` appends were
done by hand). More code here means *less* improvisation.

## Decision

Collapse the four lanes into **one parameterised build path**. Concretely:

1. **One commit contract, explicit in the type system.** `buildPrompt` takes a
   `commitMode: 'worker' | 'dispatch'` and the spawn's toolset is derived from it, so prompt
   text and granted tools cannot disagree. A test pairs mode against tools; that single
   assertion catches defects (1) and (3).
2. **One implementation per concept.** `runGate`/`persistWorkerLog` are exported from the beat
   and the conductor's local forks deleted. The batch lane's inline scoped-commit is replaced by
   the shared `attemptScopedCommit`. Guards (spine, Touches-overstep, judge, scout) become
   properties of the single path, configured per lane — never re-implemented per lane.
3. **Lane becomes a parameter, not a code path.** What differs between attended and unattended
   is configuration (who commits, which guards escalate vs. auto-handle, whether a human is
   present), not a forked procedure.
4. **The attended coordinator routes through the conductor** rather than re-deriving the
   procedure from prose each session.
5. **Flow tests own the composition rules.** One behaviourally-named end-to-end test per plane
   flow, and a fake worker in a lane test is **forbidden to commit** — a fake may write files
   only. A fake that supplies the behaviour under test is worse than no test, because it sells
   confidence.
6. **The lane × guard matrix is generated from the code**, not drawn. A hand-drawn flow diagram
   in this repo demonstrably rots within a day (`method.md`'s "workers return commits" was false
   for two of four lanes within 24 hours of being written). A generated matrix fails CI when a
   lane silently loses a guard.

## Consequences

**Falsifiable success criterion:** the plane's line count must go **down**. `dispatch.ts` (4147)
+ `reactor.ts` (4839) + `conductor.ts` (590) is 31% of `packages/core/src`. If this refactor
grows the plane rather than shrinking it, the premise is wrong and the four-lane topology should
be re-examined rather than defended.

**What improves:** a feature added once applies everywhere. The `no commit` class — the plane's
most common historical failure — becomes unreachable wherever `commitMode: 'dispatch'` is set.
The dark subsystems light up as a side effect, because "the target lane has no judge" stops
being a sentence that can be true.

**What we accept:** `commitMode: 'worker'` is retained rather than abolished, because dispatch-side
commit produces one commit per item and the operator's doctrine wants one independently-revertable
unit per commit. Multi-commit slices stay possible where a human is present. The cost is that two
commit contracts persist — which is why the pairing test in (1) is load-bearing and must never be
deleted.

**Risk and sequencing.** This touches the plane's hot path days before a public release. It is
staged: the commit-contract fix and the conductor repair land first and independently (each
unbreaks something today), guard unification second, lane-as-parameter last. Every stage keeps the
full gate green and is independently revertable. If the weekend runs out mid-way, the landed
stages are still net improvements and the remainder is a normal queued item — no half-migrated
state is left armed.

**Rollback.** Each stage is its own merge commit on `main`; reverting a stage restores the prior
lane behaviour exactly. The `commitMode` parameter defaults to the current per-lane behaviour, so
an unset value is byte-for-byte today's semantics.

## Supersedes / relates

Extends the consolidation instinct of [ADR-001](ADR-001-one-plane.md) (one plane) to the build
path itself. Does not alter [ADR-007](ADR-007-claim-arbitration.md) claims or
[ADR-008](ADR-008-detached-dispatch-staging.md) staging — both remain properties of the single
path once collapsed.
