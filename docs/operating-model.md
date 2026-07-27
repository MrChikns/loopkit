# loopkit operating model — one plane, two postures

Status: ratified design, **partly built**. The v0.1 core ships single-target delivery and
*item-level* attended claims; the file-scope claim layer and the whole plan layer described below
are committed roadmap, in order. Every capability on this page is marked so you can tell shipped
from planned without opening the source. This doc is the contract for how the plane and a human
operator share one repository without slowing each other down.

**Status marks.** The vocabulary of [`plane-flows.md`](plane-flows.md), of which this page needs
two marks:

| mark | meaning |
|---|---|
| ✅ | built, and exercised on real work |
| ⚪ | not built — the design is settled, the code is not written |

Where a ✅ names a symbol in `packages/core/src`, the sentence carries an invisible existence
marker bound to that symbol, and [`doc-claims.test.ts`](../packages/core/test/doc-claims.test.ts)
fails CI if the symbol goes away — the discipline `plane-flows.md` and `method.md` are already
held to. A ⚪ sentence carries no marker because there is nothing to bind it to; that is precisely
what the mark is telling you.

## The idea in one line

One event-sourced delivery plane whose dispatcher **yields to explicit operator claims** while you
work — ✅ per work item, ⚪ per file scope — and, once the plan layer lands (⚪), **executes
explicitly armed plan runs** while you're away. Two UX presets, not two systems.

"Attended mode" and "plan mode" are presets over the same domain model: same ledger, same fold,
same worktrees, same gates, same acceptance tiers. What changes is *who holds scope* and *what is
armed to run*. The attended half of that is live; the plan half is design only.

## Posture 1 — attended fast path (you're at the keyboard)

The problem: every surveyed agent system isolates background work (worktree/VM + PR) but none lets
a human work at keyboard speed on the same repo while a queue runs — no presence, no
file-ownership awareness. The result is either rituals (pause the plane) or races.

**✅ What ships today — claims at item granularity.** `loopctl session start` opens an attended
session; `loopctl claim <WI>` leases whole queued work items to it (`item.claimed`, bounded
renewable TTL, dead-man heartbeat), and the away beats defer every claimed item to that session
while the lease is active, an expired lease returning the item to the shared
queue<!--exists:attendedItemClaimLease-->. Claim acquisition and dispatch admission are arbitrated
in one pass under the ledger lock — re-read, re-fold, drop anything a foreign session claimed in
the window, then claim the survivors in the same locked append — so the reservation is race-safe
by construction rather than a check-then-act
([ADR-007](decisions/ADR-007-claim-arbitration.md))<!--exists:claimArbitrationLock-->. What is
missing is *file scope*: a claim names items, never paths, so keyboard work outside the queue is
invisible to the dispatcher.

**⚪ What the fast path adds — an explicit, one-command scope claim over paths.** None of the
following exists: no `scope.*` event is in the ledger schema and there is no `attended` verb on
the CLI.

- ⚪ `loopctl attended start [--touches <prefixes>]` will append `scope.claimed` (bounded TTL,
  renewable). From that moment the dispatcher is to **admit no work item whose `Touches` conflict
  with your claim** — while it keeps building everything disjoint. You are never slowed; the queue
  is never stopped.
- ⚪ Scope-claim acquisition will go through the same short-lived per-target arbitration lock the
  item claims already use (acquire → re-fold → append → release), so it is race-safe by
  construction — not a check-then-act.
- ⚪ `loopctl attended finish` will run the target's gate on your work, verify the commit range
  against the claimed scope, append the same `gate.* / item.merged` trail a dispatched build
  would, mark it `delivery: 'attended'`, and release the claim. Your fast-path work would land in
  the **same ledger** with the same evidence — the record with no holes. Today that record is
  assembled by hand: the attended path appends its own `item.merged` carrying the session id as
  attribution and whatever gate/sha evidence the operator supplies, so completeness is the
  operator's discipline, not a verb's guarantee.
- ⚪ **Bypass stays legal.** Work done entirely outside `attended start/finish` is allowed (you own
  the repo); `loopctl reconcile` will stamp escaped commits into the ledger as a best-effort
  repair path. Completeness is then guaranteed only for claimed sessions — reconciliation is the
  exception lane, not the workflow.
- ⚪ Presence inference (e.g. from local agent-session activity) may *suggest* starting or renewing
  a claim. It will never create one. Explicit beats inferred: a transcript shows past turns, not
  current ownership of paths.

⚪ Scope-claim lifecycle, once built: `scope.claimed` → `scope.renewed`* → `scope.released` (or
visible TTL expiry — an expired claim never silently blocks or silently admits; it surfaces). ✅
The item-level lifecycle shipping today is the same shape one level down: `item.claimed` →
`item.released`, addressed by the work item.

## Posture 2 — plan runs (you're away) ⚪

The problem: schedulers everywhere fire *single tasks* (cron → prompt → PR). Nobody executes a
dependency-ordered, multi-slice plan unattended with an inspectable record.

The loopkit answer is a **plan as data, a run as an event**. None of it is built: no `plan.*`
event exists in the ledger schema and there is no `plan` verb on the CLI.

- ⚪ `loopctl plan define <file>` will validate an acyclic DAG of work items (slices with
  dependencies), appending the items plus one `plan.defined` atomically. The plan is then
  inspectable state, not an agent's private intention.
- ⚪ `loopctl plan run <plan> --from <t> --until <t>` will append `plan.run-requested` for a
  bounded, one-shot window ("tonight, 22:00–06:00"). The **existing always-running beats** are to
  honor it: within the window, dispatch prefers the plan's ready slices (dependencies satisfied,
  `Touches` disjoint); at the boundary the reactor appends `plan.run-closed` with the outcome
  tally.
- ⚪ A missed window (machine asleep) is to close as `missed` — never a silent catch-up run at an
  unexpected time.
- ⚪ Morning surface: the console will show the run outcome next to the acceptance desk — what
  shipped (by tier), what parked, what's blocked and why.
- ⚪ Deliberately NOT in the first version: recurring schedules (one-shot windows until real usage
  demands more), runtime replanning, cross-plan dependencies. A plan is a fixed DAG of ordinary
  work items — not a workflow engine.

## The skills pack (the plane teaches its method) ⚪

The delivery discipline the plane enforces mechanically (gates, tiers, scope) has a judgment
layer humans and workers both need: how to event-model a slice, how to keep it vertical, what a
reviewable change looks like. That layer is to ship as a **versioned method pack** with two
projections from one canonical source — neither projection is built:

- ⚪ headless workers would get the relevant method text folded into their generated prompts. The
  nearest thing today is narrower and unrelated in origin: a repo playbook file, when configured,
  is injected verbatim into a worker prompt as recurring lessons — a lessons file, not a versioned
  method pack.
- ⚪ attended sessions would get repo-visible skill files installed by `loopctl init --skills`.
  There is no `init` verb; ✅ the three commands in [`.claude/commands/`](../.claude/commands/)
  exist because they were written by hand, not installed by the plane.

CLI commands enforce invariants; skills teach judgment. (Prompt-only "skills" were rejected —
prompts can't enforce claims, gates, or recording.)

## Contracts (minimal set, in envelope order)

1. ✅ One generic event envelope — `{ id, ts, actor, item, type, data, v }`: one parser,
   append-only, no parallel lifecycles. Its stream-id field (`item`) addresses a *subject* rather
   than only a work item — session events are addressed by their session id, target events by the
   target name. A work item's `target` is stamped once, on `item.captured`, and every downstream
   event inherits it through the fold instead of re-stamping
   it<!--exists:envelopeTargetStamp-->.
2. ⚪ `plan.defined` · `plan.run-requested` · `plan.run-closed { outcome }`
3. ⚪ `scope.claimed { touches, ttl }` · `scope.renewed` · `scope.released` — the file-scope layer.
   ✅ Its item-scope counterparts ship today: `item.claimed { sessionId, ttlMinutes }` ·
   `item.released`.
4. ⚪ Existing item/gate/merge trail extended with `delivery: 'attended' | 'dispatch'` — attended
   work is the same lifecycle, differently delivered. There is no `delivery` field yet; ✅
   `item.merged` carries an optional `sessionId` today, which is attribution only and never
   behaviour.

## Sequencing

| Stage | Ships |
|---|---|
| **v0.1** (now) ✅ | single-target proof end-to-end · thin console · README + demo · three handwritten, repo-local Claude Code commands in [`.claude/commands/`](../.claude/commands/) (`/drive`, `/plane-check`, `/board`; not the versioned skills pack above) · **attended item claims** (`session`/`claim`/`release`), shipped ahead of the original sequence per [ADR-007](decisions/ADR-007-claim-arbitration.md) — the CLI drain that shipped beside them was deleted in [ADR-013](decisions/ADR-013-delete-the-conductor.md). Plans appear **only as this roadmap**. |
| v0.2 ⚪ | `scope.claimed`-style *file-scope* claims + `reconcile` (the fast path) — item-level claiming already shipped in v0.1 |
| v0.3 ⚪ | plan DAG + one-shot run windows (the evening run) · **flip-gated releases** (see below) |
| later ⚪ | recurring schedules · presence suggestions · multi-target scheduling · skill registries |

**On "1.0" — there deliberately isn't one.** The versions above deepen the *proof*; they do not
march toward a product launch. A "1.0" would mean the thesis is fully demonstrated — every pillar
in [vision.md](vision.md) at "works today," proven in anger rather than roadmap — for **one
operator running their own targets**. It would *not* mean "adopted by a team," "hosted," or
"multi-tenant": those boundaries in [limitations.md](limitations.md) are permanent by design, not
a backlog, and there is no 2.0 that crosses them — a team platform is a *different artifact* (its
own gateway, RBAC, and named-approver merges), not a later loopkit. That is the point of the
read-only, no-SLA framing: this repo is **proof that governed autonomy can be built by one
person**, not a product being shipped to you. The `later` tier is reserved *contract* — the event
shapes are named here so today's ledgers stay forward-compatible — explored only as far as it
sharpens the proof.

### Agentic concepts: the admission filter ⚪ (roadmap)

The control loop stays deterministic; agentic concepts are to be pluggable stages **inside proof
boundaries**. A concept earns entry only if it (a) reduces operator attention or tokens per
accepted slice, (b) leaves inspectable evidence in the ledger, (c) never runs the plane. Through
that filter — nothing below is built; this is the shortlist, not a feature list:

- ⚪ **Context packs over vector recall** for worker context (deterministic, content-addressed,
  provenance + invalidation); an embeddings index would be one optional pack-builder strategy for
  large/prose targets — built under the same sensitivity gate (private target ⇒ local model or
  nothing).
- ⚪ **Plane-memory retrieval**: the ledger is a corpus with perfect provenance — past specs,
  repair loops, parks, verdicts. Retrieval over it would feed workers a *labeled,
  non-authoritative* "similar prior work" prompt section. Institutional memory as a projection.
- ⚪ **Worker tool access (MCP) as target policy**: the manifest would declare which tools/servers
  a target's workers may use — folded into scope-not-prompt and the sensitivity gate. Tool grants
  belong to the trust boundary, never global.
- ⚪ **Best-of-N attempts** for high-stakes slices: parallel disjoint worktrees, judge arbitrates,
  losing branches preserved as evidence. A policy knob on existing machinery.
- **Not ours**: RAG runtimes for the target product's domain (the target's business), vector-DB
  dependencies in core, LLM orchestrators/swarm topologies (the anti-thesis — models do work,
  they never run the plane).

### Flip-gated releases ⚪ (roadmap, with plan runs)

Merge ≠ deploy ≠ **release**. loopkit will orchestrate the target's own feature-flag mechanism —
never implement a flag runtime: the manifest is to declare how flags work in that project; a slice
may declare `releaseFlag`; the gate verifies the flag exists and defaults **off**; the slice merges
and deploys **dark**. The acceptance verdict then gates the **flip** (`release.enabled/disabled`
events, executed through the target's mechanism) — human judgment moves from "may this code
exist on main" to "may this behavior reach users." Evening runs would ship everything dark;
morning acceptance flips. Incidents resolve at flip-speed (seconds, from the console, no rebuild —
working even when the plane is unhealthy), and flips live in the same ledger as merges, deploys,
and SLO breaches, so "what changed before the incident" is a projection. The contract (one
optional slice field + two event types) is *reserved* — named here and deliberately unimplemented,
so ledgers written before it exists stay forward-compatible; the runtime lands with plan runs — the
same maturity moment, both about what happens while you're away.

## Any folder is a target (not just apps)

Nothing in the plane assumes "an app". A target needs exactly two things: a git history (for
worktrees, merges, and the audit trail) and a gate (any deterministic command). That covers a
codebase — and equally a documentation tree, a research/notes vault, or an AI project (prompts,
datasets, evals):

- ✅ **Registering a target**: `loopctl target add <path>` reads and validates the repo's
  `loopkit.target.json` manifest and registers it, failing loudly when the path is not a git
  worktree<!--exists:targetAddRegistersRepo-->.
- ⚪ **Plain folders**: `loopctl target add --init <dir>` would turn any local directory into a
  target (git init + first commit) — today an uninitialized directory is rejected rather than
  initialized. Git stays the substrate — invisible when you don't care, load-bearing when you do.
- ⚪ **Gate presets** for non-code projects: `docs` (links, frontmatter, schema checks), `eval`
  (run an eval suite, pass = score ≥ threshold — eval results landing as ledger events, so model/
  prompt quality over time becomes a projection like everything else). Any command you write
  already works as a gate; the presets and the eval projection do not exist.
- ⚪ **The weak-gate rule**: the less a gate proves, the more the acceptance tiers should protect —
  a target with a trivial gate defaulting its surfaces to `review`, so unattended changes to it
  always cross your desk. Gate strength and human attention as a see-saw, by policy. Today's tiers
  classify from the changed paths only; gate strength is not an input.
- ✅ Boundaries are path-shaped, and mean the same thing in a prose tree as in a codebase:
  `Touches` and the plane/surface split match on segment-boundary path
  prefixes<!--exists:touchesPrefixMatcher-->; risk patterns match as substrings of the changed
  path.

v0.1 demonstrates a code target; `--init`, gate presets, eval projections and the weak-gate rule
are roadmap (sequenced after the attended fast path and plan runs).

## What this is not

Not two planes (duplicated state is how coordination dies). Not transcript-inferred safety. Not a
global kill switch doing concurrency's job (the kill switch stays an emergency brake). Not a
workflow engine. Not a replacement for your judgment — the acceptance tiers still route what
needs your eyes to your eyes.
