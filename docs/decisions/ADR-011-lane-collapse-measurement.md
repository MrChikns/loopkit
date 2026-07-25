# ADR-011 — Amend ADR-010's measurement clause; refuse the batch-lane migration

**Status:** active
**Amends:** [ADR-010](ADR-010-one-lane.md) (its "Consequences / falsifiable success criterion" only — the decision itself stands)

## Context

[ADR-010](ADR-010-one-lane.md) staked its premise on a falsifiable criterion: *"the plane's line count must go **down**"*, measured as `dispatch.ts` + `reactor.ts` + `conductor.ts`. A design review of stage 3 found that criterion cannot do the job it was written for.

**The criterion is satisfiable by moving code sideways.** Measured on the named files, stages 1–2 went 4737 → 5009 (+272). But stage 1b also added `lane-matrix.ts` (508), `render-lane-matrix.ts` (81) and `lane-matrix.test.ts` (243) — new files the clause does not count. The honest total for the work ADR-010 authorised is **4737 → 5598 (+861)**. A criterion that a refactor can pass by relocating code into files outside its own scope is not falsifiable, and quoting the smaller number would have been self-serving.

The same review established where the deletion actually is, and it is not where ADR-010 assumed:

- Extracting the genuinely twice-written pieces — the exit-file decoder, worktree creation, and the target/conductor merge tails — totals roughly **−110**.
- Routing the batch lane's 858-line Phase-2 body through the shared pipeline nets **≈ 0**: about 70 lines leave the lane and 70 enter the pipeline.
- The one large deletion available is replacing `lane-matrix.ts`'s static source analysis with the **declared lane-config registry** the lanes already consume — roughly **−740**.

That last item was always ADR-010's point 6 end-state; the static analyser was an explicit stopgap taken because `dispatch.ts` was frozen under a sibling agent at the time. It is no longer frozen.

## Decision

1. **Restate the criterion to cover every file the work touches** — `dispatch.ts`, `reactor.ts`, `conductor.ts`, plus any file added in service of the refactor (`lane-matrix.ts`, `render-lane-matrix.ts` and their tests). Baseline: **4737** production lines at `8496877~1`. The refactor succeeds only if the whole set ends below that.
2. **Refuse the batch-lane pipeline migration (ADR-010's implied final step) for now.** It is an 858-line hot path with three test-injection seams (`touchesDiffFiles`, `gateResult`, `judgeResults`) spanning ~59 `runDispatch` call sites in a 6,210-line test file, and `verifyWorktreeState` is *conditional* in the batch lane but unconditional in the shared pipeline — routing batch through it turns every synthetic-worktree fixture red. It buys **zero** lines. It becomes a normal queued item, not part of this refactor.
3. **Record what "one lane" turned out to mean.** ADR-010's framing — one system implemented four times — was wrong. It is one system implemented **once** (the batch/engineering lane) with three thinner lanes that were missing features rather than duplicating them. You cannot deduplicate what was never duplicated: stages 1–2 added capability three lanes lacked, which *has* to add lines. The consolidation available is smaller than the ADR assumed, and honest accounting had to come before further work.
4. **The judge must be recorded, not merely run.** Stage 2 enabled the judge on the target and conductor lanes while the shared pipeline wrote its verdict to `stderr` only — no `review.verdict`, no `cost.usage`. Because the reactor's judge backstop deliberately excludes targeted items, the target lane paid full judge latency per build for a verdict nobody stored, invisible to the daily budget gate; the conductor double-spent via the backstop. ADR-010's claim that the dark subsystems would "light up as a side effect" was false: the judge ran in two more lanes and stayed dark in the ledger. **A subsystem that runs without recording is worse than one that is off** — it costs quota and produces no evidence. Recording the verdict is the first slice of stage 3 and ships independently.

## Consequences

The refactor's remaining value is concentrated in two places: making the judge's output real (capability, not lines), and replacing the observation scaffolding with the declared registry (lines). If the registry step is not taken, the honest conclusion is that **the line-count criterion should be abandoned rather than pursued** — continuing past that point would be adding indirection and calling it consolidation.

What does not change: `commitMode` and its pairing test remain load-bearing; guards stay declared per lane; fakes in lane tests remain forbidden to supply the behaviour under test. Those were the durable wins of stages 1–2 and none of them depend on the line count.

Deliberately still refused, unchanged from ADR-010's risk list: generalising push or non-fast-forward recovery across lanes, unifying `baseSha` or the merge destination (both silently change what the gate covers — a false-green class rather than a test failure), and touching the conductor's repo mutex.
