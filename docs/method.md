# The method — the operating discipline loopkit embodies

Status: method document. loopkit is one implementation of an operating method for running an
autonomous delivery plane as a solo operator; this doc is the method itself, stated so it outlives
the code. Where a principle is already load-bearing in this repo, the paragraph links the doc or
ADR that evidences it — so you can read the reasoning and then see it enforced. The machinery is
[the vision](vision.md) · [operating model](operating-model.md) · [event model](event-model.md) ·
[trust boundaries](trust-boundaries.md); this is the *why behind the shape*.

The method predates the tool. loopkit is what you get when you take these principles seriously
enough to make them mechanical instead of aspirational — and the ones the tool doesn't yet enforce
are still how you should operate the plane by hand.

## One door in, one window out

The operator touches delivery at exactly two points: they **drop intent** — a plain-English
sentence, from wherever they already are — and they **answer the few decisions a human must own**.
Everything between is the plane.

Intent has one door. A feature, a fix, a change of mind — all arrive the same way (`loopctl new
"<text>"`), get event-modeled, queued, built, and gated through one pipeline. There is no separate
ticket ritual, no branch ceremony, no "which system do I file this in" — the transport is
incidental (terminal, a console box, a chat bridge), and every intent lands as the same
`item.captured` event and routes identically. The [README](../README.md) opens on exactly this:
one sentence in, a merged and tested commit out.

Attention has one window. The operator does not chase status across chat threads, dashboards, and
log files; they watch one board — a projection of the ledger — that shows what shipped, what's
in flight, and the short list that actually needs them. The
[agent-integration](agent-integration.md) contract states it plainly: the operator's whole
interface is *drop intent, answer the few decisions that genuinely need a human*. Narrowing the
interface to one door and one window is what makes a one-person operation scale past one person's
attention — you are not the bus for coordination state, the ledger is.

## Append-only ledger — one fact, one home; everything else is a projection

Delivery itself is treated as an event-sourced system. Every intent, build, gate result, merge,
and human verdict is an **immutable event in one append-only ledger**. Nothing mutates in place;
a crashed process changes nothing retroactively, because recovery is just re-reading the log. The
board, an item's timeline, the needs-you list, the health readout — none of them are *stored*
state you keep in sync. They are **ledger-first projections**, derived from the one log on
demand, so they cannot drift from the truth because they *are* the truth, re-read. Most are pure
folds over events; a few (the ops-console summary's parked-branch liveness check, the daily
brief's usage-ledger append) also run a small, explicit diagnostic alongside the read — never
silent, and never a mutation of the ledger's own event log.

This is the single discipline that kills the failure class the tool was built against: mutable
coordination state — queues in markdown, status files, chat threads — silently loses or
double-applies work the moment two things run at once. The fix is *one fact, one home*. A fact
lives in exactly one place: an event in the ledger (immutable), or a projection derived from it
(disposable) — never copied into two mutable documents that can disagree. When a view and the log
disagree, the log wins; you fix the view. This extends even to reference material the console
surfaces: the [knowledge index](knowledge.md) *points* at decision docs in the repos that own
them and renders them live on each request — it stores nothing, so a card cannot drift from its
source. The one durable, expensive layer is the event contract; projections, screens, and prompts
are disposable by construction, and rewriting them is the intended iteration mode, not drift.

## Autonomy scales with proven competence — certify, don't brief

The plane does not get blanket trust, and it does not stay on a leash forever either. Autonomy
**scales with demonstrated competence, one class of work at a time.** A change earns the right to
merge unattended by belonging to a class the operator has already watched succeed — and the
boundary is explicit, configurable policy, not a vibe.

That boundary is the tiered-acceptance model in the [README](../README.md#how-it-works): every
merged item is classified by *what it actually changed* — the real diff at merge time, not the
item's own declared metadata, so a change that touched real code can never launder itself as
"nothing changed." Framework-internal, gate-proven work ships silently; a declared product surface
**surfaces for your test**; anything touching money, auth, or migrations, or anything a quality
judge failed, **waits for a human, forever**. Trust is two orthogonal axes, not one list —
*merge-trust* (what may auto-merge) and *test-visibility* (what you want to eyeball) are declared
separately, because collapsing them into a single list is precisely how changes ship unseen.

Certify, don't brief. Green tests alone are a brief — they say the code passed *today's* gate.
Widening what may run unattended is a certification: you take a new class only after you have seen
that class prove itself, and you state what could break, how it would be detected, and how to roll
it back. The [operating-model](operating-model.md) makes this the sequencing rule for the plane's
own growth — contracts land early because they are expensive to change, runtime lands only when
its posture is actually needed, and *nothing claims to exist before it survives its own gate.*

The certification's fourth line — *does this pattern apply anywhere else?* — used to be a nudge
into the void: the reactor asked, but no event ever closed the loop, so a typed reply just sat
unparsed in the thread. ADR-009 gives it a real completion path (`loopctl portability`, an
appended `item.certification-amended`), the same verb-appends-an-event shape as every other
operator write — so "harvest portable patterns at boundaries" is now a deterministic write, not a
hope that someone reads the thread.

## Parks and intent-format escalations

The whole point of routing attention is that the plane **stops** for the calls a human should make
— and stops *well*. Two things are non-negotiable at the boundary.

First, **costly-and-irreversible always parks.** Before anything destructive, irreversible, or
outward-facing — a merge to money/auth/a migration, a publish, a spend, an external send — the
plane does not act on its own judgment; it parks the item (never silently auto-completes it) and
raises it to the human. [ADR-005](decisions/ADR-005-self-hosting.md) draws this line in its
sharpest form: the plane may build, gate, and merge improvements to *its own framework* like any
other target — but self-hosting is **not self-publishing**. An autonomous system improving its own
engine is healthy; one pushing its own code to a public remote without a human at the boundary is
not. Merging is a reversible local act; publishing is not — so the irreversible one parks.

Second, **an escalation is an intent, never a bare question.** "Should I do X?" is malformed —
it hands the operator a research task and an unstated recommendation. A well-formed escalation
states four things: **what I intend to do, the evidence, the main risk, and what would change my
mind** — so the operator can approve, redirect, or veto in one read instead of reconstructing the
situation. This is why parks carry an evidence trail rather than a raw error, and it is the same
discipline the [limitations](limitations.md) doc applies to the tool's own gaps: each is stated
with *what's bounded* and *when it would actually matter*, so a reader decides with the risk in
front of them, not a naked question.

## Staged flags — the rollback is written before the flip

Behaviour changes reach the operator's world **behind a flag that defaults off, with the rollback
written before the flip is switched.** A risky migration does not land as a big-bang cutover; it
lands as dormant substrate first, then an explicitly-armed switch, and every stage names how to
get back.

[ADR-008](decisions/ADR-008-detached-dispatch-staging.md) is the worked example. Moving dispatch
from synchronous-in-beat to detached execution is a genuine architecture change to the plane's hot
path — so it ships staged, never one-shot: a config flag (`execution.detachedDispatch`) that
**defaults off**, so an unset flag is byte-for-byte the behaviour shipping today; eligibility is
fail-closed, keeping the blast radius to exactly one build shape; and the rollback is stated in the
ADR itself before the flag is ever flipped. [ADR-007](decisions/ADR-007-claim-arbitration.md)
carries the same signature — a mechanism that lands *dormant* ("this slice changes ZERO live
behavior while the switch is off"), with an explicit consequences-and-rollback section, re-armed
later as a deliberate choice. The method: the flip is a decision the operator makes with the escape
route already in hand, not a hope.

Merge is not deploy, and deploy is not release. Keeping those three as separate, individually
reversible steps is what makes a bad change recoverable at flip-speed instead of requiring a
rebuild — the [operating-model](operating-model.md) reserves the flip-gated-release contract for
exactly this reason.

## Failures become evidence-carrying work items — no incident recurs untested

An incident is not something you survive and forget; it is **raw material for a permanent
regression.** When something breaks, the fix is not a one-off patch — it is a work item that
carries the reproduction, lands the fix, and **pins the class with a test** so that failure mode
cannot recur silently. A fabricated "done" with no commit is detected and parked with an evidence
log; an oversized event is clipped and marked rather than crashing the appender; an orphaned lock
is reclaimed — and each of these is *pinned by a test*, not just handled once.

The [hardening-audit](hardening-audit.md) is this principle applied deliberately rather than
reactively: a **10-class incident catalog** distilled from prior operational near-misses, run
proactively against the framework, each class marked TESTED-OK, FIXED-HERE (with a new test), or
GAP-FOLLOW-UP (with the exact intended fix recorded for a work item). The move that matters most:
**an incident-class catalog is portable.** A failure that bit one project is audited *against a
sibling project before it fires there* — you don't rediscover the same class in production twice.
Catalogs transfer between planes; scars become checklists. The [limitations](limitations.md) doc
is the same instinct facing forward — the seams a staff review would raise, listed explicitly so
they are *known before* they are discovered in anger, not after.

## Measure operator felt-reliability — not machine vanity metrics

The number that matters is not how many builds the plane ran, how many events it appended, or how
busy it looked. Those are **vanity metrics** — they go up when the plane is thrashing as readily as
when it is delivering. The metric that matters is the operator's **felt reliability**: of the work
that reached me, how much was *clean* (shipped, nothing wrong), *minor* (a small fix), *major* (a
real rework), or a *blocker* (it stopped me) — and how much of my **attention** did the whole thing
cost.

This reframes success as *attention saved per accepted slice*, not *throughput*. The
[trust-boundaries](trust-boundaries.md) routing model earns its keep by this measure: every
provider call lands its usage in the ledger, so "which model is actually earning its keep" is a
projection you can read, not a feeling — and eval-driven routing optimizes for **trust per token**,
not raw speed. The [vision](vision.md) states the doctrine directly: *unattended, optimize for
trust per token; attended, get out of the way.* A plane that merged a hundred items but handed you
three blockers and a rework had a bad day, however green its dashboards — and the honest metric is
the one that says so. Machine counts are diagnostics; the operator's felt experience is the score.

## What this method is not

Not a workflow engine — a plan is a fixed DAG of ordinary work items, not a programmable
orchestrator. Not transcript-inferred safety — a chat log shows past turns, not present ownership;
the boundary is explicit claims and explicit tiers, enforced in code. Not a replacement for
judgment — the whole apparatus exists to route the *right* decisions to a human, not to remove the
human. And not a set of aspirations pinned to a wall: every principle above is either mechanical in
this repo already, or the way you are meant to operate the plane by hand until it is.
