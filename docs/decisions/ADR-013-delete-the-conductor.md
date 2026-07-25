# ADR-013 — Delete the conductor; the capability it named already exists as batch co-location

**Status:** active
**Supersedes:** [ADR-012](ADR-012-no-lanes.md)'s clause that `conductor.ts` *collapses into* the one
path (its Consequences "After the release" item, and clause 5's "two triggers") — the collapse never
happens because there is nothing left to collapse. [ADR-010](ADR-010-one-lane.md)'s point 4 ("the
attended coordinator routes through the conductor") is withdrawn for the same reason.
**Amended:** 2026-07-25 — the Context section's co-location claim was overstated; see the inline
amendment below (WI-199). The Decision is unchanged.

## Context

ADR-010 through ADR-012 all treated `conductor.ts` as a lane with a future: something to repair, then
unify, then merge into the single build path. Every one of those documents was written from the
*shape* of the code. None of them looked at whether the code had ever run.

**It has not. Not once.** `runConduct` has never produced a single ledger event: zero
`actor:"conduct"` across 2,833 live events and roughly 21,500 archived ones. Its only entry point is
a human typing `loopctl conduct` at a terminal, and no human ever has. (The 160 `actor:"conductor"`
`msg.out` events in the 2026-07-08..10 archive are not this code — they belong to a different,
pre-loopkit system that happened to share the word.)

That is not a lane that regressed. It is a lane that was never exercised, defended three times on
the strength of what it would do once repaired.

**The attended mode it was supposed to codify does not use it.** The operator's actual default is a
coordinator agent that clusters the queue, spawns builders in worktrees, merges each cluster, and
appends `item.merged` itself. That path claims through the same lease kernel
([ADR-007](ADR-007-claim-arbitration.md)) and lands on the same board. It has never called
`runConduct` and does not need to.

**Its one good idea is already implemented, in the path that actually runs.** Clustering
`Touches`-overlapping items into one worktree, one prompt, one gate and one merge exists in the
dispatch beat as **batch co-location** — `isBatchEligible` (`packages/core/src/beats/dispatch.ts:594`)
picks the members, `cfg.batchMaxItems` (`packages/core/src/config.ts:832`) bounds the group. The
conductor is a second implementation of that same capability with two differences: the eligibility
filter removed, and the group size effectively unbounded rather than the shipped default of `1`
(co-location off). **Deleting it therefore loses no capability.** The capability was never in the
conductor; the conductor was a second copy of it with the knob pre-turned.

> **Amendment (2026-07-25):** the paragraph above overstates where co-location reaches. It is real,
> but only for **untargeted** items — `runDispatch` (`packages/core/src/beats/dispatch.ts`) splits
> queued items into `targetedQueued` and `engineeringQueued` *before* grouping; only
> `engineeringQueued` ever reaches the `isBatchEligible`/`batchMaxItems` check. Targeted items are
> built by `runTargetLane`, whose own build loop is a bare serial `for (const rec of items)` with no
> batching call at all — its comments say so explicitly. A ledger measurement the same day found 173
> of 180 `item.queued` events in a six-day window were targeted (96%); the 7 untargeted belonged to 3
> items, two of them planning-lane (also never batched). **Zero builds in that window could have
> entered the co-location path.** This does not reopen the decision below — the conductor still
> never ran, and the tax of a third path is unaffected — but the honest version of the claim is: *the
> capability already has a home, currently reachable only for untargeted items; extending it to the
> target lane is open work.* See WI-199.

**Keeping it costs a permanent tax, and the tax is already being paid badly.** Every invariant the
plane gains has to be ported to a third path, and silently is not. WI-176 — "one `deployed` semantic
across **every** lane" — missed `conductor.ts:598` within hours of merging. Beyond that one, the
conductor carries no push, no deploy, no salvage, no breaker, no priority ordering, no in-flight
`Touches` check, no manifests, no scout, no playbook and no ledger-residue commit. The honest reading
of ADR-011's own finding applies here: this was never a duplicate of the engineering lane, it was a
thinner thing missing features — and nobody was ever going to finish it, because nobody was running
it.

## Decision

**Delete the conductor.** `packages/core/src/conductor.ts`, its test, the `loopctl conduct` verb and
its help line, and the `conductor` row and lane spec from the generated lane matrix all go. Git is
the just-in-case; nothing is kept commented out or behind a flag.

1. **Batch co-location is the one implementation of clustering.** An operator who wants
   `Touches`-overlapping items built together raises `batchMaxItems` above `1`. That path is the one
   with the guards, and it is the one that runs.
2. **Ad-hoc clustering by an attended agent is the exception that needs no lane.** A coordinator
   deciding by judgement which items to group this session is not a code path — it is a person (or an
   agent acting for one) using the same claims and appending the same events. Codifying that
   judgement was ADR-010's point 4, and the evidence is that codifying it produced something nobody
   invoked while the uncodified version carried the work.
3. **There are three lanes, not four**: planning, target, engineering. The lane matrix says so
   because it is derived from source, so it says so the moment this lands.

## Consequences

**What is deliberately given up.** The one-command mechanical drain (`loopctl conduct` /
`--dry-run`) is gone; an operator wanting an unattended drain now uses the dispatch beat, and one
wanting an attended one uses a coordinator. Batch co-location is not a drop-in substitute for the
conductor's clustering semantics and this ADR does not pretend it is: it applies an eligibility
filter the conductor did not (sonnet only, priority no more urgent than `high`, spec under 1,500
chars), and it ships **off** by default. If a real need for the wider semantics appears, the change
is a knob and a filter on the path that already has the guards — not a fourth lane.

**`commitMode: 'worker'` now has no production caller.** The conductor was the only lane that
declared it. The parameter and its pairing test survive unchanged — ADR-010 is explicit that the test
is load-bearing and must never be deleted, and the mechanism is what keeps prompt text and tool grants
from disagreeing the next time a lane wants worker-side commits. What changes is only that no lane
currently asks for it.

**ADR-011's line-count criterion is finally satisfied, and not by a refactor.** The measured set was
`dispatch.ts` + `reactor.ts` + `conductor.ts` plus the matrix files. This removes ~620 production
lines from that set outright. That is worth stating plainly because it is the opposite of how ADR-010
and ADR-012 expected to get there: the deletion came from asking whether a path had ever run, not
from unifying three paths that had.

**The generated matrix loses a row rather than a column.** ADR-012 expected the whole `lane × guard`
matrix to become meaningless once the paths collapsed. It does not, because the collapse did not
happen — planning, target and engineering still differ, and the drift test still fails CI when one of
them silently loses a guard. The matrix generator's `claim (claimItems)` rung survives with no lane
currently reporting it; its unit coverage moves onto an injected fixture rather than being deleted,
because a rung whose only proof was the deleted lane would otherwise become an untested branch.

**What this does not license.** "It has never run, so delete it" is a valid argument only with the
ledger evidence in hand and an existing implementation of the capability to point at. Both were
established before this decision, and both are recorded above precisely so the next application of
the argument has to meet the same bar.
