# loopkit operating model — one plane, two postures

Status: ratified design (v0.1 ships the single-target core; the claims/plan layers below are the
committed roadmap, in order). This doc is the contract for how the plane and a human operator
share one repository without slowing each other down.

## The idea in one line

One event-sourced delivery plane whose dispatcher **yields to explicit operator scope claims**
while you work, and **executes explicitly armed plan runs** while you're away — two UX presets,
not two systems.

"Attended mode" and "plan mode" are presets over the same domain model: same ledger, same fold,
same worktrees, same gates, same acceptance tiers. What changes is *who holds scope* and *what is
armed to run*.

## Posture 1 — attended fast path (you're at the keyboard)

The problem: every surveyed agent system isolates background work (worktree/VM + PR) but none lets
a human work at keyboard speed on the same repo while a queue runs — no presence, no
file-ownership awareness. The result is either rituals (pause the plane) or races.

The loopkit answer is an explicit, one-command **scope claim**:

- `loopkit attended start [--touches <prefixes>]` — appends `scope.claimed` (bounded TTL,
  renewable). From that moment the dispatcher **admits no work item whose `Touches` conflict with
  your claim** — it keeps building everything disjoint. You are never slowed; the queue is never
  stopped.
- Claim acquisition and dispatch admission go through one short-lived per-target arbitration lock
  (acquire → re-fold → append → release), so the claim is race-safe by construction — not a
  check-then-act.
- `loopkit attended finish` — runs the target's gate on your work, verifies the commit range
  against the claimed scope, appends the same `gate.* / item.merged` trail a dispatched build
  would, marks it `delivery: 'attended'`, and releases the claim. Your fast-path work lands in
  the **same ledger** with the same evidence — the record has no holes.
- **Bypass stays legal.** Work done entirely outside `attended start/finish` is allowed (you own
  the repo); `loopkit reconcile` stamps escaped commits into the ledger as a best-effort repair
  path. Completeness is guaranteed only for claimed sessions — reconciliation is the exception
  lane, not the workflow.
- Presence inference (e.g. from local agent-session activity) may *suggest* starting or renewing
  a claim. It never creates one. Explicit beats inferred: a transcript shows past turns, not
  current ownership of paths.

Claim lifecycle: `scope.claimed` → `scope.renewed`* → `scope.released` (or visible TTL expiry —
an expired claim never silently blocks or silently admits; it surfaces).

## Posture 2 — plan runs (you're away)

The problem: schedulers everywhere fire *single tasks* (cron → prompt → PR). Nobody executes a
dependency-ordered, multi-slice plan unattended with an inspectable record.

The loopkit answer is a **plan as data, a run as an event**:

- `loopkit plan define <file>` — validates an acyclic DAG of work items (slices with
  dependencies), appends the items plus one `plan.defined` atomically. The plan is inspectable
  state, not an agent's private intention.
- `loopkit plan run <plan> --from <t> --until <t>` — appends `plan.run-requested` for a bounded,
  one-shot window ("tonight, 22:00–06:00"). The **existing always-running beats** honor it: within
  the window, dispatch prefers the plan's ready slices (dependencies satisfied, `Touches`
  disjoint); at the boundary the reactor appends `plan.run-closed` with the outcome tally.
- A missed window (machine asleep) closes as `missed` — never a silent catch-up run at an
  unexpected time.
- Morning surface: the console shows the run outcome next to the acceptance desk — what shipped
  (by tier), what parked, what's blocked and why.
- Deliberately NOT in the first version: recurring schedules (one-shot windows until real usage
  demands more), runtime replanning, cross-plan dependencies. A plan is a fixed DAG of ordinary
  work items — not a workflow engine.

## The skills pack (the plane teaches its method)

The delivery discipline the plane enforces mechanically (gates, tiers, scope) has a judgment
layer humans and workers both need: how to event-model a slice, how to keep it vertical, what a
reviewable change looks like. That layer ships as a **versioned method pack** with two
projections from one canonical source:

- headless workers get the relevant method text folded into their generated prompts;
- attended sessions get repo-visible skill files installed by `loopkit init --skills`.

CLI commands enforce invariants; skills teach judgment. (Prompt-only "skills" were rejected —
prompts can't enforce claims, gates, or recording.)

## Contracts (minimal set, in envelope order)

1. Generic event envelope: every event carries an optional `target`; the stream-id field
   addresses a *subject* (work item, plan, claim) — one parser, append-only, no parallel
   lifecycles.
2. `plan.defined` · `plan.run-requested` · `plan.run-closed { outcome }`
3. `scope.claimed { touches, ttl }` · `scope.renewed` · `scope.released`
4. Existing item/gate/merge trail extended with `delivery: 'attended' | 'dispatch'` — attended
   work is the same lifecycle, differently delivered.

## Sequencing

| Stage | Ships |
|---|---|
| **v0.1** (now) | single-target proof end-to-end · thin console · README + demo · at most the two method skills the demo actually uses. Claims and plans appear **only as this roadmap**. |
| v0.2 | attended scope claims + `reconcile` (the fast path) |
| v0.3 | plan DAG + one-shot run windows (the evening run) · **flip-gated releases** (see below) |
| later | recurring schedules · presence suggestions · multi-target scheduling · skill registries |

### Agentic concepts: the admission filter (roadmap)

The control loop stays deterministic; agentic concepts are pluggable stages **inside proof
boundaries**. A concept earns entry only if it (a) reduces operator attention or tokens per
accepted slice, (b) leaves inspectable evidence in the ledger, (c) never runs the plane. Through
that filter:

- **Context packs over vector recall** for worker context (deterministic, content-addressed,
  provenance + invalidation); an embeddings index is one optional pack-builder strategy for
  large/prose targets — built under the same sensitivity gate (private target ⇒ local model or
  nothing).
- **Plane-memory retrieval**: the ledger is a corpus with perfect provenance — past specs,
  repair loops, parks, verdicts. Retrieval over it feeds workers a *labeled, non-authoritative*
  "similar prior work" prompt section. Institutional memory as a projection.
- **Worker tool access (MCP) as target policy**: the manifest declares which tools/servers a
  target's workers may use — folded into scope-not-prompt and the sensitivity gate. Tool grants
  are part of the trust boundary, never global.
- **Best-of-N attempts** for high-stakes slices: parallel disjoint worktrees, judge arbitrates,
  losing branches preserved as evidence. A policy knob on existing machinery.
- **Not ours**: RAG runtimes for the target product's domain (the target's business), vector-DB
  dependencies in core, LLM orchestrators/swarm topologies (the anti-thesis — models do work,
  they never run the plane).

### Flip-gated releases (roadmap, with plan runs)

Merge ≠ deploy ≠ **release**. loopkit will orchestrate the target's own feature-flag mechanism —
never implement a flag runtime: the manifest declares how flags work in that project; a slice may
declare `releaseFlag`; the gate verifies the flag exists and defaults **off**; the slice merges
and deploys **dark**. The acceptance verdict then gates the **flip** (`release.enabled/disabled`
events, executed through the target's mechanism) — human judgment moves from "may this code
exist on main" to "may this behavior reach users." Evening runs ship everything dark; morning
acceptance flips. Incidents resolve at flip-speed (seconds, from the console, no rebuild — works
even when the plane is unhealthy), and flips live in the same ledger as merges, deploys, and SLO
breaches, so "what changed before the incident" is a projection. The contract (one optional
slice field + two event types) is reserved before public ledgers exist; the runtime lands with
plan runs — the same maturity moment, both about what happens while you're away.

## Any folder is a target (not just apps)

Nothing in the plane assumes "an app". A target needs exactly two things: a git history (for
worktrees, merges, and the audit trail) and a gate (any deterministic command). That covers a
codebase — and equally a documentation tree, a research/notes vault, or an AI project (prompts,
datasets, evals):

- **Plain folders**: `loopkit target add --init <dir>` turns any local directory into a target
  (git init + first commit). Git stays the substrate — invisible when you don't care, load-bearing
  when you do.
- **Gate presets** for non-code projects: `docs` (links, frontmatter, schema checks), `eval`
  (run an eval suite, pass = score ≥ threshold — eval results land as ledger events, so model/
  prompt quality over time is a projection like everything else), or any command you write.
- **The weak-gate rule**: the less a gate proves, the more the acceptance tiers protect — a
  target with a trivial gate defaults its surfaces to `review`, so unattended changes to it
  always cross your desk. Gate strength and human attention are a see-saw, by policy.
- Boundaries (`Touches`, surfaces, risk patterns) are path prefixes — they mean the same thing
  in a prose tree as in a codebase.

v0.1 demonstrates a code target; `--init`, gate presets, and eval projections are roadmap
(sequenced after the attended fast path and plan runs).

## What this is not

Not two planes (duplicated state is how coordination dies). Not transcript-inferred safety. Not a
global kill switch doing concurrency's job (the kill switch stays an emergency brake). Not a
workflow engine. Not a replacement for your judgment — the acceptance tiers still route what
needs your eyes to your eyes.
