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
"<text>"`), land as `item.captured`, and enter the same routing pipeline. A build-classified intent
continues through queue, build, and gate; an answer or park route stops earlier by design. There is
no separate ticket ritual, no branch ceremony, no "which system do I file this in" — the transport
is incidental (terminal, a console box, a chat bridge), and every intent captures and routes through
the same contract<!--exists:oneDoorCapture-->. The [README](../README.md) opens on the build-shaped
case: one sentence in, a merged and tested commit out.

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
silent, and never a mutation of the ledger's own event log. The worker-prompt playbook file is the
same discipline applied to distilled knowledge, not just status: a reactor step folds ratified
minus expired `knowledge.*` events and rewrites the file only on change, so a lesson injected into
a build prompt is rebuildable from the ledger rather than hand-typed and
untraceable<!--exists:stepPlaybookMaterialize--> (docs/decisions/ADR-015-verified-knowledge-promotion.md).
The lessons that projection folds are themselves harvested, not hand-authored: a strict-auditor
reactor step reads each gate-proven merge and defaults to emitting nothing, capped at 5 merges
harvested per beat, so the rare surviving candidate still crosses the human approve/reject gate
before it ever reaches the playbook.

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

## Orchestrator-workers — with the orchestrator as a fold, not a context window

The reference taxonomy for agent systems — Anthropic's
[Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) —
names the shape this plane implements: **orchestrator-workers**. A central LLM dynamically
decomposes a task, delegates the pieces to worker LLMs, and a synthesizer combines their results.
Put that diagram next to this repo and the nodes line up:

| Reference node | loopkit |
|---|---|
| **In** | operator intent → `item.captured`, whatever the transport |
| **Orchestrator** *(classify)* | the reactor router — an LLM event-models raw intent into a work item with a free-prose `spec` and a `Touches` set; oversized work parks for later planning-lane decomposition |
| **Orchestrator** *(delegate)* | the dispatch picker — **deterministic, no model**: `Touches`-disjoint grouping under claims |
| **Worker LLM calls** | build agents, one git worktree each |
| **Synthesizer** | the target's gate, then `git merge --no-ff` — per item, serial |
| **Out** | `item.merged`, and the acceptance tier that decides whether you ever see it |

Two divergences from the reference carry the whole method.

**Workers return scoped worktree changes, not text — so the synthesizer stops being a model.** In the reference
workflow, parallel calls produce overlapping opinions about the same artifact, and an LLM
aggregator is needed to reconcile them. Here, disjointness is enforced *before* the work: two
in-flight builds may never share a `Touches` set<!--exists:touchesDisjointInflight-->, so no two
workers can produce two answers to the same file. Each worker changes its own worktree and returns a
structured manifest; dispatch stages and commits only the in-scope output. The target gate then
provides deterministic merge proof, followed by an advisory LLM judge before merge. That judge
records review evidence and may raise the later acceptance tier, but never blocks the merge.
Combining is still git's job, so an LLM aggregator does not get replaced by a better aggregator; it
**disappears**, because scheduling already did its work.

**The orchestrator holds no context.** This is the real architectural difference, and it is the
one that makes the difference between a session and a plane. In the reference workflow the
orchestrator is a live LLM whose *context window is the coordination state* — it remembers what it
delegated and adapts as results come back. loopkit's orchestrator is a **fold over the append-only
ledger** ([event model](event-model.md)): it holds nothing between beats and is reconstructed from
events every time it runs<!--exists:foldOrchestrator-->. Coordination state is not in anyone's head
or anyone's context; it is on disk, immutable, and re-derivable.

The trade is explicit, and stating it honestly is the more important half. **Decomposition happens
at intake, not mid-flight.** Routing classifies an oversized intent as one that needs decomposition
and **parks it instead of building it**; once the operator approves, a planning-lane child is
queued to split it<!--exists:decompositionAtIntake--> — always *before* any builder runs. Once a
build worker is running it cannot re-plan: it has no channel to re-queue work, so it ships the
smallest safe slice and states the remainder in its manifest. At merge that remainder is
auto-captured as one child item on the same intake every operator intent lands
in<!--exists:deferralChildCapture--> — *captured, never queued*: a worker may put a **proposal** on
the board, never a **build** on the queue. Whether the remainder is real work is still settled
afterwards, by the operator or by routing; the worker that raised it is never answered. A live
in-context orchestrator would have heard that worker and adapted; this one cannot, and claiming
otherwise would be exactly the kind of aspiration this document refuses. It is a real cost,
recorded in [limitations](limitations.md) rather than argued away.

What the trade buys is everything a context-window orchestrator cannot survive: process death,
machine restart, and two operators working at once. A context window is lost when its process is;
a ledger is not.

Both postures are the same topology, which is why they compose. The attended coordinator mode is
*literally* the reference diagram — a live session decomposing, spawning workers, and merging,
with the human as the orchestrator. The unattended beats are that same topology projected onto
durable state. [ADR-007](decisions/ADR-007-claim-arbitration.md) is what lets the two run
simultaneously without double-delivering the same item — an arbitration that is only *expressible*
because ownership is an event, not a conversation.

## Autonomy scales with proven competence — certify, don't brief

The plane does not get blanket trust, and it does not stay on a leash forever either. Autonomy
**scales with demonstrated competence, one class of work at a time.** A change earns the right to
merge unattended by belonging to a class the operator has already watched succeed — and the
boundary is explicit, configurable policy, not a vibe.

That boundary is the tiered-acceptance model in the [README](../README.md#how-it-works): every
merged item is classified by *what it actually changed* — the real diff at merge time, not the
item's own declared metadata<!--exists:mergeDiffTiering-->, so a change that touched real code can
never launder itself as "nothing changed." Framework-internal, gate-proven work auto-accepts
silently; a declared product surface **surfaces for your test**; anything touching money, auth, or
migrations,
or anything a quality judge failed, **waits for a human, forever**<!--exists:mustTierWaitsForHuman-->.
Trust is two orthogonal axes, not one list —
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
appended `item.certification-amended`)<!--exists:portabilityCompletion-->, the same
verb-appends-an-event shape as every other operator write — so "harvest portable patterns at
boundaries" is now a deterministic write, not a hope that someone reads the thread.

## Parks and intent-format escalations

The whole point of routing attention is that the plane **stops** for the calls a human should make
— and stops *well*. Two things are non-negotiable at the boundary.

First, **costly-and-irreversible is an operating rule, not complete semantic authorization.**
Before anything destructive, irreversible, or outward-facing — money/auth/a migration, a publish,
a spend, an external send — the operator should route or park the item for a human decision. The
runtime does not infer every such meaning from prose. Its narrow mechanical guard is the optional,
default-off `preMergeRiskHold`: configured path patterns can park a `must`-class diff before merge;
ordinary acceptance tiering is computed after merge and controls attention, not authorization.
[ADR-005](decisions/ADR-005-self-hosting.md) draws the operating line in its sharpest form: the plane
may build, gate, and merge improvements to *its own framework* like any other target — but
self-hosting is **not self-publishing**. Publishing, spending, and external sends still require an
explicitly configured boundary and human procedure rather than an assumed semantic guard.

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
**defaults off**, so an unset flag is byte-for-byte the behaviour shipping
today<!--exists:stagedFlagDefaultsOff-->; eligibility is fail-closed, keeping the blast radius to
exactly one build shape; and the rollback is stated in the
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
log<!--exists:noCommitParkEvidence-->; an oversized event is clipped and marked rather than crashing
the appender<!--exists:oversizedEventClipped-->; an orphaned lock is
reclaimed<!--exists:orphanLockReclaim--> — and each of these is *pinned by a test*, not just handled
once.

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
cost. Half of that is mechanical today and half is not, which is worth saying rather than blurring:
the attention side is derived from the ledger and rendered on the operator's own
surfaces<!--exists:attentionCostMetric--> (alongside first-pass rate and park class), while the
clean/minor/major/blocker read stays the operator's judgement — the plane does not infer it from
events, and a doc that implied otherwise would be selling a projection nobody built.

This reframes success as *attention saved per accepted slice*, not *throughput*. The
[trust-boundaries](trust-boundaries.md) routing model earns its keep by this measure: a provider
call lands usage in the ledger when its adapter returns machine-readable usage
data<!--exists:usageInLedger-->. Claude does; the current Codex text adapter does not, so economics
are partial across all built-ins rather than a complete cross-provider account. Within the measured
set, eval-driven routing picks the model with the highest first-pass merge
rate<!--exists:evalDrivenRouting-->, not the fastest one. The [vision](vision.md) states the doctrine
directly: *unattended, optimize for trust per token; attended, get out of the way.* A plane that
merged a hundred items but handed you three blockers and a rework had a bad day, however green its
dashboards — and the honest metric is the one that says so. Machine counts are diagnostics; the
operator's felt experience is the score.

## What this method is not

Not a workflow engine — where a plan layer lands, a plan is a fixed DAG of ordinary work items and
not a programmable orchestrator (the shape is committed in [operating-model](operating-model.md);
no `plan` verb or event exists in the code today, and this doc does not pretend otherwise). Not
transcript-inferred safety — a chat log shows past turns, not present ownership; the boundary is
explicit claims and explicit tiers, enforced in code. Not a replacement for
judgment — the whole apparatus exists to route the *right* decisions to a human, not to remove the
human. And not a set of aspirations pinned to a wall: every principle above is either mechanical in
this repo already, or the way you are meant to operate the plane by hand until it is.
