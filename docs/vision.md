# loopkit — the vision

Status: north-star document. Individual layers are sequenced in
[operating-model.md](operating-model.md); contracts in [event-model.md](event-model.md); trust
in [trust-boundaries.md](trust-boundaries.md). This doc is the whole picture and the reasoning.

## What loopkit is

**An event-sourced delivery plane for a solo operator.** The exercised v0.1 path drives one git
target at a time with a Claude CLI worker. Built-in Codex and Ollama adapters are experimental
text-only lanes, not interchangeable autonomous builders. Multiple concurrently scheduled
projects, arbitrary-folder initialization, and provider-independent attended tooling are
roadmap. You drop intent in plain language; the plane builds in isolated git worktrees, proves
with deterministic gates, merges, and routes outcomes through tiered acceptance. Every recorded
step is an immutable event in one append-only work ledger; every view is a projection of it.

## The one-line model

> One plane whose dispatcher **yields to the operator's item claims** today; explicitly armed
> plan runs and richer scope claims are roadmap over the same domain model.

## The latency doctrine (why attended mode exists)

A hot attended session will always beat an isolated autonomous run on flow — though parts of the
queue's latency are fixable (event-driven pickup, context reuse for small items) and are on the
roadmap. What stays structural:

- **beat quantization** — pickup waits for the next heartbeat;
- **cold context** — every spawned worker rediscovers the repo from zero; your attended session
  already holds the whole picture;
- **stage ceremony** — scout → brief → build → deterministic gate → advisory judge → merge are
  separate, serialized proof stages; that rigor is the *point* of unattended trust, and pure
  overhead when you are sitting right there.

So the plane refuses to compete on attended latency. The doctrine:

> **Unattended, optimize for trust per token. Attended, get out of the way.**

Concretely:

- **Roadmap — the attended fast path adds two user verbs** to work you were doing anyway:
  `attended start` (append a scope claim; dispatch instantly yields on conflicting paths and
  keeps building everything disjoint) and `attended finish` (run the target's gate — which you'd
  run regardless — verify the commit range against the claim, stamp the same
  captured→gated→merged trail with `delivery: 'attended'`, release). No queue, no beats, no
  worker spawn, no brief stage. Your speed **is** the feature; the ledger completeness is the tax,
  and the tax is two appends.
- **The grab verb** (roadmap with claims): pull a queued or in-flight item into your session —
  its dispatch build is cancelled/parked, the branch and context hand over, and you finish it at
  keyboard speed under your claim. The reverse push — parking a half-done attended slice back to
  the queue with its trail — closes the loop. Mode *switching* is first-class, not a restart.
- **Unattended latency still gets its cheap wins** — event-driven kicks on queue append instead
  of pure polling, measured pickup/merge latency as ledger projections (SLOs you can see, not
  vibes) — but never at the cost of the proof stages. Overnight, nobody is waiting; trust is the
  scarce resource, not seconds.

## The pillars

1. **One ledger, one fold, both postures.** Attended edits, autonomous builds, acceptance
   verdicts, eval scores, provider spend — one append-only stream, one deterministic fold,
   projections as the only UI. Events already appended are never mutated by a crash — recovery
   is reading the log. A unified record across human and agent work is the design center, not an
   afterthought.
2. **Targets: explicit git repositories today; broader onboarding is roadmap.** A target is a
   git history plus a manifest
   (`loopkit.target.json`): gate command, default branch, and the three boundary axes —
   merge-trust prefixes, test-visible surfaces, risk patterns. `target add --init`, non-code
   `docs`/`eval` gate presets, eval-score projections, and arbitrary non-git folders are roadmap,
   not v0.1 commands.
3. **Trust is explicit and layered.**
   - *Merge-trust vs test-visibility vs risk* — three declared axes, not one conflated list; a
     path can auto-merge AND still cross your desk.
   - *Tiered acceptance* — auto / optional / review / must, instead of all-or-nothing review.
   - *Weak-gate ⇒ strong-tier* — the less a target's gate proves, the more its changes default
     to `review`. Gate strength and human attention are a policy see-saw.
   - *Sensitivity-gated model routing* — every item carries public/internal/private; the
     provider registry gates which model may serve which tier (`private` → local model).
     Stage-specific model settings and sensitivity-specific provider chains exist today;
     independent provider assignment by stage does not. Eval-driven builder routing can select
     from measured models by spec-size bucket. End-to-end content inspection remains the release
     bar for claiming that sensitive payloads never leave the machine.
4. **Roadmap — plans make "away" productive, not just busy.** A plan is data — a validated acyclic DAG of
   ordinary slices — and an evening run is an event: a one-shot bounded window the existing
   beats honor, closing with an inspectable outcome tally. Morning surface: what shipped by
   tier, what parked, what's blocked and why — dependency-ordered unattended execution with an
   inspectable record, not a cron that fires isolated prompts.
5. **Roadmap — the plane teaches its method.** A versioned skills pack — event-model the slice, keep it
   vertical, what reviewable means — projected into worker prompts *and* installable into your
   attended sessions. CLI enforces invariants; skills teach judgment. Both postures share one
   discipline, which is what makes the unified ledger coherent.
6. **Deterministic control loop.** Two beats and a fold — no LLM orchestrator deciding what runs.
   Models do the work; they never run the plane.

## What loopkit is not

Not a coding agent: v0.1 integrates built-in CLI adapters, with Claude as the exercised autonomous
worker and Codex/Ollama as experimental text-only adapters. It is not yet an arbitrary
CLI-model integration contract. Not a workflow engine (plan DAGs are roadmap). Not a team
platform (solo-operator first; multi-seat is not a goal). Not a cloud service (your machine,
your git, your models, your data).

## Where it goes (sequence, not promises)

| Stage | Delivers |
|---|---|
| v0.1 | single-target proof end-to-end · thin console · trust/routing as shipped · method docs |
| v0.2 | attended scope claims + finish/reconcile + grab verb — the latency answer |
| v0.3 | plan DAGs + one-shot evening runs + morning outcomes |
| v0.4 | any-folder onboarding (`--init`), gate presets (docs/eval), eval-trend projections |
| later | egress content guards · presence suggestions · multi-target scheduling · recurring windows |

The ordering rule: contracts land early (they're expensive to change), runtime lands when its
posture is actually needed, and nothing claims to exist before it survives its own gate.
