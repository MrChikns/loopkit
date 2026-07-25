# ADR-012 — There are no lanes; there is one build path and a switch

**Status:** active
**Extends:** [ADR-010](ADR-010-one-lane.md) · [ADR-011](ADR-011-lane-collapse-measurement.md)

## Context

ADR-010 tried to make the four lanes *converge* by sharing their pieces. ADR-011 then measured that
approach and found it pays ~110 lines: the lanes are not four copies of one thing, so deduplicating
them cannot make the plane small. The conclusion drawn there — stop, observe, and ask which features
are needed — was right about stopping and wrong about the destination.

The operator's model, stated plainly, is the destination:

> I feed the plane work. It slices, prioritises, drains in parallel, and raises what needs my
> judgement. I never choose a lane. Either the plane is running unattended, or I drain it from the
> CLI. The only difference is whether the plane is stopped or running.

That model is correct, and it exposes the actual defect in the current design: **the lanes encode as
static code paths what should be derived per item.** Everything that differs between them is a
property of the *work*, not of a mode the operator selects:

| what differs today | what it actually depends on |
|---|---|
| merge destination (`master` hardcoded vs `manifest.defaultBranch` vs current branch) | which repo the item targets |
| whether to push | whether that target declares a remote |
| whether the spine check applies | whether the item touches the plane's own code |
| commit contract (`worker` vs `dispatch`) | nothing — it was a lane accident |
| guard set | nothing — it was a lane accident |
| parallelism / mutex | nothing — parallelism should always be on |

The "attended lane" is the clearest case: `conductor.ts` exists as a separate implementation of the
same procedure, and its worker-side commit contract was defended (in ADR-010) on the grounds that a
human is present. Under this model that justification collapses — if attended and unattended are the
same path, there is no "human present" branch to justify anything.

## Decision

**One build path. Lane is not a concept. Mode is not a concept.**

1. **One path**: select (priority-ordered, `Touches`-disjoint, claim-aware) → worktree → prompt →
   worker → post-build guards → merge → events. Parallel by default, always.
2. **Per-item derivation, never per-lane branching.** Merge destination, push, and spine-scope are
   resolved from the item's target and footprint. If a difference cannot be derived from the item, it
   is not a legitimate difference.
3. **One commit contract: dispatch commits.** One commit per item, which is also the operator's own
   rule that a commit is a single independently-revertable unit — an item *is* that unit.
   `commitMode` and its pairing test survive as the mechanism that keeps prompt and tools honest, but
   `'worker'` stops being a lane's identity.
4. **All guards, always.** A guard that is right for one kind of work is right for all of it. Guards
   stop being a per-lane config and become the path.
5. **Two triggers, one path**: the dispatch beat (timer) and `loopctl conduct` (drain now). Neither
   is a mode. [ADR-007](ADR-007-claim-arbitration.md) claims already arbitrate, so they may overlap.
6. **The planning step is not a lane.** Decomposition is a step *before* a build, not a parallel
   implementation of one, and stays as it is.

## Consequences

**This is where the deletion actually is.** ADR-011 measured the convergence approach at ~110 lines
because it assumed four paths must survive. Merging them is a different quantity: the batch lane's
858-line Phase-2 body and `conductor.ts` (602) collapse into the one path. The `lane × guard` matrix
and its generator (~832 lines including tests) also become meaningless — with one path there is
nothing to compare — which resolves the open question in ADR-011 without a separate decision. So the
line-count criterion becomes meaningful again, and it should be applied to this ADR rather than to
ADR-010's convergence work.

**Sequencing is not negotiable.** A public release is three days out, and the stage-3 design review
refused the batch-lane migration on evidence: an 858-line hot path, three test-injection seams
(`touchesDiffFiles`, `gateResult`, `judgeResults`) across ~59 `runDispatch` call sites in a
6,210-line test file, and a `verifyWorktreeState` that is conditional in the batch lane but
unconditional in the shared pipeline — routing batch through it reddens every synthetic-worktree
fixture. That risk is unchanged by wanting the outcome. Therefore:

- **Now (safe, on the path):** the three genuine extractions (exit-file decode, worktree creation,
  merge-and-close) — they are prerequisites, not detours. Plus making merge destination and push
  *derived from the target* rather than hardcoded per lane, which removes the target-vs-batch
  distinction as a **concept** without yet touching the batch lane's body.
- **After the release:** collapse the batch Phase-2 body and `conductor.ts` into the one path, then
  delete the matrix generator.

**What must not be lost in the collapse**, each for a stated reason rather than because it is old:
per-repo merge serialisation (a merge race in a shared checkout is a real incident class);
`alreadyShippedCommit` and `denialNote` (they guard the auto-requeue loop); differentiated
`parkKind` (`ops` vs `decision` is what keeps the operator's desk small); salvage policy differences
on park (branch kept vs deleted is deliberate per failure class); and batch's per-item attribution
for co-located groups. Each becomes a derived property, not a lane.

**Explicitly still refused:** generalising push where a target declares no remote, and unifying
`baseSha` without proving what the gate then covers — both are false-green classes, which fail
silently rather than loudly.

**Observation before the second half.** ADR-011's instruction stands: the guards, the recorded judge,
and the now-reachable self-heal requeue have run on approximately zero real builds. The post-release
collapse should be informed by `loopctl trajectory` — first-pass rate, park class, attention cost —
not by this document's confidence.
