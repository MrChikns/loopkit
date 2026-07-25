# Known limitations (v0.1)

This is a deliberate scope boundary, not an apology. loopkit is an event-sourced delivery plane
whose safe core — claim-before-pick TOCTOU arbitration, re-gate-after-rebase integration, tiered
acceptance on the real diff, and fail-closed provider routing — is built and tested. The gaps
below are the ones a staff review would raise; each is bounded, understood, and cheap to reach
from where the code is today. They are listed here so the seams are explicit rather than
discovered in production.

Each entry states *what's bounded* and *when it would actually matter*. Every `file.ts:NNN`
citation on this page is checked against the code by
[`doc-claims.test.ts`](../packages/core/test/doc-claims.test.ts) — an earlier version of this file
cited three lines that had drifted, and one gap that had since been fixed.

## Ledger durability & concurrency

- **Each line is durable; the transition is not, and a torn line does not stop the fold**
  (`packages/core/src/ledger.ts:145`<!--cite:ledgerAppendWrite-->). Every append writes and then
  `fsync`s before closing the handle, so a line that lands is whole and survives a process crash or
  an OS panic. Two things that barrier does *not* buy. **Not transition atomicity:** a multi-event
  batch is N separate write-and-sync cycles under one lock, so a crash, kill or `ENOSPC` part-way
  through leaves the first k events durably on disk and the rest missing — a *durably incomplete*
  transition, which the reader then folds as though it were the whole truth. No amount of `fsync`
  makes N writes one; callers must shape a batch so a partial prefix is harmless or re-derivable
  (commit-the-transition events last, re-appends idempotent). **Not power-loss durability on macOS:**
  `fsync(2)` there does not flush the drive's own write cache — that needs `F_FULLFSYNC`, which Node
  does not expose. The amplification is still on the read side: the loader **skips a corrupt line and
  continues** (`packages/core/src/ledger.ts:252`<!--cite:ledgerCorruptSkip-->), so a torn write does
  not halt the fold — it silently folds an incomplete history while every later event still applies.
  *Bounded:* the lock serializes writers and id-dedupe on load makes re-append idempotent. **The
  shrunk-ledger regression guard is not a mitigation for this** — it compares a segment's max valid id
  against a stored watermark, so it fires on the loss of *previously observed* history; a line torn
  during its own append was never observed in an earlier beat, so its loss reads as "no new events
  yet". *Matters when:* a hard crash or full disk lands exactly mid-batch. The quiet failure is
  deliberate (one skipped line beats a dead plane), which is precisely why it needs
  saying out loud — recovery is from the local checkpoint refs, and the stderr warning is the only
  signal you get.

- **The ledger lock carries no owner/PID token**
  (`packages/core/src/ledger.ts:45`<!--cite:ledgerLockAcquire-->). A transaction that holds the lock
  longer than the **30**<!--pin:lockTimeoutSeconds--> second staleness window can have it reaped by
  another beat that assumes the holder is dead. *Bounded:* real appends are sub-second; the window is
  generous relative to them. *Matters when:* a pathologically slow append (e.g. under heavy I/O
  contention) overruns the window while still alive — two writers could then interleave. An owner/PID
  + liveness token on the lock closes this; it is a known next step.

## Event schema evolution

- **The envelope is versioned; there is still no upcaster.** Every event now carries a `v` stamped by
  the single construction path (`packages/core/src/schema.ts:1003`<!--cite:makeEventStampsVersion-->), at
  `LEDGER_SCHEMA_VERSION` = **1**<!--pin:LEDGER_SCHEMA_VERSION-->; an absent `v` on a legacy line reads
  as 1. What does **not** exist is any migration machinery: no upcaster, no per-type payload version,
  no re-interpretation step in the fold. *Bounded:* the fold reads fields defensively (absent or
  wrong-typed fields fold to `undefined`), so additive field changes are already safe, and new event
  *types* are free. *Matters when:* a *breaking* change to an existing event's payload ships — renaming
  or re-typing a field on an existing type would need historical events re-interpreted on read, and
  there is nowhere to put that logic. Bumping the envelope version would record that it happened; it
  would not migrate anything.

- **Event-id entropy comment vs. reality; wall-clock ordering.** The id generator's comment says 50
  random bits but the code emits **30**<!--pin:eventIdRandomBits-->, and cross-process event ordering
  still leans on the wall clock. *Bounded:* 30 bits is ample against collision at this event volume,
  and same-process ordering is monotonic. *Matters when:* two processes on skewed clocks append in the
  same millisecond and a consumer depends on strict cross-process total order — the fold is designed to
  be order-tolerant, but a future consumer that isn't would be exposed.

## Integration-lane invariants (target + conductor)

- **The target and conductor lanes do not re-gate after integration.** The engineering lane will not
  merge a branch whose base moved without rebasing and re-running the gate over the combined state,
  and recovers a push race the same way
  (`packages/core/src/beats/dispatch.ts:4407`<!--cite:postIntegrationRegate-->). Neither the target build
  lane nor the attended conductor carries that invariant: each gates once, on its own branch, and
  merges. *Bounded:* both are opt-in paths that run against their own repos and still gate before
  merging. *Matters when:* the destination branch advances during the build — the merged result is
  then a combination nothing ever tested. Porting the engineering lane's terminal to these two lanes
  is the fix.

- **Build worktrees now branch from their merge destination, not ambient `HEAD`** (WI-183). Every
  lane passes an explicit base ref to `openBuildWorktree`
  (`packages/core/src/beats/dispatch.ts:879`<!--cite:openBuildWorktreeHead-->; the conductor's call at
  `packages/core/src/conductor.ts:436`<!--cite:conductorWorktreeHead-->), so the base the guards
  measure against is the base the merge uses. Previously a non-default `HEAD` could carry stowaway
  commits into a merge while `Touches`-overstep and the judge inspected only changes made after that
  ambient base. The engineering lane keeps `'HEAD'` deliberately — it is already pinned by a Phase-2
  guard that defers when the checkout is not on `master` — and now passes it explicitly rather than
  by omission.

- **A claim is a lease, so a lagging live owner can still be picked over.** Every picking lane now
  *reserves* what it takes: the shared pick list defers to an already-active claim
  (`packages/core/src/beats/dispatch.ts:3181`<!--cite:queuedClaimDeference-->), which is a read, and both
  dispatch lanes — engineering and, since WI-186, target — then re-fold under the ledger lock and append
  their own `item.claimed` for every survivor before spawning. The conductor claims under the same lock
  (`packages/core/src/conductor.ts:312`<!--cite:conductorClaimItems-->). What remains is ADR-007's
  *designed* trade, not a gap: a claim reads active only while its owning session's dead-man heartbeat
  is fresh, so a genuinely-live operator whose heartbeat lagged past the bound reads inactive and a beat
  may take the item. *Bounded:* the reap age is derived from the build-timeout envelope and the common
  case is never a contest. *Matters when:* an attended session is suspended or starved long enough to
  miss its heartbeats — detection is a `build.dispatched` sitting next to a recent operator
  `item.claimed` in the same item's trail.

- **`lane-matrix.md` does not track either of the invariants that actually differ between lanes.** The
  generated guard matrix pins `Touches`-overstep, spine, judge, scout, push, commit side and the gate
  wrapper — but it has **no claim-arbitration column and no post-integration-re-gate column**. Those
  are exactly the two things the three preceding entries are about, so the drift test that protects the
  matrix cannot catch a regression in either. *Bounded:* both are described here and in
  [plane-flows](plane-flows.md) Plate 07, and neither is currently claimed to be present. *Matters
  when:* one lane gains or loses the invariant silently — the matrix will keep rendering green while
  the property it does not model changes underneath it. Adding the two columns is the fix, and it is
  the same shape as every existing column.

- **Recovery does `reset --hard origin/master` with no clean-tree guard**
  (`packages/core/src/beats/dispatch.ts:4593`<!--cite:pushRaceReset-->). The push-race recovery path
  force-resets the primary tree without first checking for uncommitted work. *Bounded:* it runs on a
  tree the plane owns and expects to be disposable. *Matters when:* a recovery fires against a tree
  that unexpectedly holds unsaved state — that state is lost. A `git status --porcelain` guard (bail if
  dirty in an unexpected way) closes it.

## Deploy signalling

- **Nothing verifies that a deploy script ever reports** (WI-176 closed the older, worse half of
  this). `item.merged.deployed` is now uniformly `false` on every lane — a merge observes that code
  landed, never that it deployed — and `deploy.succeeded` / `deploy.failed`, appended by the
  detached deploy script itself (it receives `DEPLOY_WI_IDS`), are the sole authority
  (`packages/core/src/fold.ts:1363`<!--cite:foldDeploySucceeded-->). The plane spawns that script
  detached, stdio ignored, unreferenced, with no timeout and nothing awaiting it
  (`packages/core/src/beats/worktree-deps.ts:400`<!--cite:fireDeployOnMerge-->). What is *still*
  missing is a liveness contract on it: a deploy hook that dies before appending either event leaves
  the item reading "not deployed" forever, which is honest but indistinguishable from "deploy not
  configured". *Bounded:* deploy is off by default (empty `deployCommand`), merge correctness does not
  depend on deploy, and the deploy-freshness SLO probe
  (`packages/core/src/slo.ts:1222`<!--cite:deployProbe-->) catches a plane-repo deploy that has
  genuinely stopped shipping. *Matters when:* a per-TARGET deploy hook fails silently — the probe only
  watches `LOOPKIT_DEPLOY_ROOT`, not each target's own deploy. There is also no rollback path for a
  `deploy.failed`.

- **There is no automatic rollback.** A merge can carry a `certification.rollback` string, and the
  worker is required to supply one for the certification to be recorded at all
  (`packages/core/src/fold.ts:705`<!--cite:certificationRollback-->). Nothing in the plane executes it —
  it is written for a human to read and run. *Bounded:* that is the intended contract; an automated
  rollback with no verification step would be a worse failure mode than a recorded instruction.
  *Matters when:* you assumed "certified" implied a mechanism rather than a note.

## Provider content guarantee (routing done, payload not)

- **Fail-closed provider resolution is routing-level, not content-level.** As of this hardening
  pass, provider resolution is per-item/per-group and fail-closed at **every** content-bearing call
  site — the engineering group, the planning lane, the target build lane, the conductor cluster,
  the operator-reply engagement lane, and the failure-pathology lane all resolve against the item's
  own (or the group's strictest) sensitivity and refuse to route a private-only item to a
  disallowed provider. What is **not** yet in place is a *pre-egress content scan*: a deterministic
  secret/credential/PII check on the prompt payload actually bound for a non-local provider.
  *Bounded:* routing can no longer send a private item to a cloud provider, so the tier boundary is
  enforced. *Matters when:* an *internal*-tier item (legitimately cloud-routed) carries a secret in
  its spec/diff — routing is correct but nothing scrubs the payload. The content DLP guard is
  explicitly roadmap, and `trust-boundaries.md` already frames it as such.

## Gate strength is inherited, by design

- **The plane asserts nothing of its own about whether your tests are any good.** "Bring your own
  gate" is the boundary: a target declares a gate command, the plane runs it before merging, re-runs it
  when the base moves, and treats green as permission. A thin suite therefore yields green, meaningless
  merges — and the plane will produce them confidently, at speed. *Bounded:* this is the trade that
  makes the plane portable across repos it knows nothing about, and the judge stage exists to put an
  independent, if advisory, second opinion beside the gate. *Matters when:* you read a wall of merged,
  gate-proven items as evidence of quality rather than as evidence that your own suite passed. It is
  the same statement your CI already makes; the plane only makes it much more often.

## Acceptance tiering tells you, it does not authorize

- **Tier is computed after the merge, from the real diff.** Tiering decides what reaches your desk and
  how long the plane waits before closing the item itself; it is a **notification policy, not an
  authorization model**. *Bounded:* for a single-operator plane this is coherent, because your intent
  plus the autonomy you configured *is* the authorization; the diff-based classification and the judge
  floor then make sure the riskiest merges are the ones you are actually shown. *Matters when:* you
  arrive from a change-managed environment and read "review tier" as an approval gate.

- **One narrow pre-merge read exists, and it is off by default (WI-180).** `preMergeRiskHold.enabled`
  re-runs the same tier classifier over the **pre-merge** diff and **parks** (never fails) an item
  whose paths hit a `must`-tier risk class — `autoApprove.escalationPatterns`, i.e. money/auth/
  migrations. It is deliberately the whole feature: there is still **no identity, no approval event
  and no RBAC**, and framing an unattended merge as "unauthorized" on a single-operator plane was
  explicitly rejected. *Bounded:* default OFF, so behaviour is unchanged unless you turn it on; it
  reads paths only (the judge is advisory and runs later, so a judge fail is not a landing-risk
  class); and the conductor applies it to plane clusters only, since a targeted cluster's boundaries
  live in a manifest that attended path does not read. *Matters when:* you expect it to be an
  approval gate — it is a *pattern* hold. A risk change whose paths match nothing you listed still
  lands, and the honest answer for real approval-before-merge is still to park the item rather than
  queue it.

## Re-planning is intake-only (a running build worker cannot re-scope its item)

- **Decomposition happens before a builder runs, and never after.** Routing classifies an oversized
  intent and queues a planning-lane child that splits it; that is the only automatic path into
  decomposition. A **build** worker still has no channel to re-*queue* work: its toolset grants no
  capture verb, and it cannot put anything into the build queue. So a worker that discovers mid-build
  that its item is mis-scoped does the instructed thing: it ships the smallest safe slice and states
  the remainder in its manifest. *Bounded:* the item still gates and merges normally, and the partial
  slice is real, proven work. *Matters when:* the deferred remainder is the part you actually cared
  about — re-planning it is still an intake round-trip (capture → route → queue), not a mid-flight
  re-scope, so the remainder lands one beat later and re-earns its priority from scratch rather than
  continuing in the worker's context. The honest framing: mid-flight re-planning is a capability an
  in-context orchestrator has and this one trades away for durability — see
  [method](method.md#orchestrator-workers--with-the-orchestrator-as-a-fold-not-a-context-window).

- **A declared deferral is captured, not queued (WI-177).** The remainder is no longer *silent*: when
  a worker fills the manifest's structured `deferred` field, dispatch auto-captures one child item
  per merged parent at merge time
  (`packages/core/src/beats/dispatch.ts:1307`<!--cite:deferralCapture-->), stamped
  `deferral:<parent>` for idempotency and carrying the parent's target. That child is **`item.captured`
  and nothing else** — it enters exactly the intake an operator's own message enters, so a human or
  the reactor's routing decides whether it is real before anything builds. This is deliberately the
  weakest channel that closes the gap: a worker can put a *proposal* on the board, never a *build* on
  the queue, which is what keeps the durability trade above intact. *Bounded:* only the structured
  field is read — free-text `notes` is never parsed, so a worker musing about scope in prose captures
  nothing. *Matters when:* a worker declines to fill `deferred` at all (nothing is captured, and the
  old silent-loss shape returns for that build), or when the intake backlog is where items go to be
  forgotten — capture makes the remainder *visible*, it does not make it *prioritized*.

- **A steered item can display one thing and build another.** An operator reply that re-scopes work
  appends `item.respec`, which amends the item's `spec`
  (`packages/core/src/fold.ts:1377`<!--cite:foldRespec-->) — the field builders are given. Boards render
  the item's original `text`. *Bounded:* the correction is on the trail as a `msg.out`, and the paired
  `item.queued` is what actually re-runs the work, so nothing is lost. *Matters when:* you scan the
  board to remember what an item is about and read a description the builder was never given.

## Deliberately deferred (not bugs — scope)

These are out of scope for v0.1 by choice, not oversight:

- Linux/systemd host support (macOS/launchd only today).
- `npm`/`npx` install of the framework (run from a clone).
- Multi-target scheduling *guarantees* (multiple registered targets work; cross-target fairness/
  starvation guarantees are not modelled).
- Provider-agnostic claims beyond the built-in factory set.
- Pre-egress DLP / content scanning (see above).
- UI/opsui package consolidation (they share several byte-identical files).
- RBAC / cloud / team features.
