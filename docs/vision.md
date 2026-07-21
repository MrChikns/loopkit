# loopkit — the vision

Status: north-star document. Individual layers are sequenced in
[operating-model.md](operating-model.md); contracts in [event-model.md](event-model.md); trust
in [trust-boundaries.md](trust-boundaries.md). This doc is the whole picture and the reasoning.

## What loopkit is

**An event-sourced delivery plane for a solo operator running multiple AI models against
multiple projects.** You connect it to any project — an app, a docs tree, a prompt/eval
workspace, any local folder. You drop intent in plain language. The plane plans, builds in
isolated git worktrees, proves with deterministic gates, merges, and routes outcomes through
tiered acceptance so only the work that genuinely needs your judgment reaches you. Every step —
by an agent overnight or by you at the keyboard — is an immutable event in one append-only work
ledger. Everything you look at is a projection of that log.

## The one-line model

> One plane whose dispatcher **yields to the operator's scope claims** while you work, and
> **executes explicitly armed plan runs** while you're away — two UX presets over one domain
> model, never two systems.

## The latency doctrine (why attended mode exists)

A hot attended session will always beat an isolated autonomous run on flow — though parts of the
queue's latency are fixable (event-driven pickup, context reuse for small items) and are on the
roadmap. What stays structural:

- **beat quantization** — pickup waits for the next heartbeat;
- **cold context** — every spawned worker rediscovers the repo from zero; your attended session
  already holds the whole picture;
- **stage ceremony** — scout → brief → build → judge → gate → merge are separate, serialized
  proof stages; that rigor is the *point* of unattended trust, and pure overhead when you are
  sitting right there.

So the plane refuses to compete on attended latency. The doctrine:

> **Unattended, optimize for trust per token. Attended, get out of the way.**

Concretely:

- **The attended fast path adds exactly two user verbs** to work you were doing anyway:
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
2. **Targets: connect to anything.** A target is a git history plus a manifest
   (`loopkit.target.json`): gate command, default branch, and the three boundary axes —
   merge-trust prefixes, test-visible surfaces, risk patterns. Apps, docs trees, AI/eval
   projects, any local folder (`target add --init` makes git invisible-but-present). Gates are
   arbitrary deterministic commands; presets for non-code projects (`docs`, `eval` — eval scores
   land as events, so prompt/model quality over time is a projection).
3. **Trust is explicit and layered.**
   - *Merge-trust vs test-visibility vs risk* — three declared axes, not one conflated list; a
     path can auto-merge AND still cross your desk.
   - *Tiered acceptance* — auto / optional / review / must, instead of all-or-nothing review.
   - *Weak-gate ⇒ strong-tier* — the less a target's gate proves, the more its changes default
     to `review`. Gate strength and human attention are a policy see-saw.
   - *Sensitivity-gated model routing* — every item carries public/internal/private; the
     provider registry gates which model may serve which tier (`private` → local model).
     Multi-model by role (cheap scout / volume builder / judge), by quota lane, by measured
     performance (eval-driven routing) — zero-config single-provider default. End-to-end
     fail-closed enforcement is the release bar for claiming the guarantee.
4. **Plans make "away" productive, not just busy.** A plan is data — a validated acyclic DAG of
   ordinary slices — and an evening run is an event: a one-shot bounded window the existing
   beats honor, closing with an inspectable outcome tally. Morning surface: what shipped by
   tier, what parked, what's blocked and why — dependency-ordered unattended execution with an
   inspectable record, not a cron that fires isolated prompts.
5. **The plane teaches its method.** A versioned skills pack — event-model the slice, keep it
   vertical, what reviewable means — projected into worker prompts *and* installable into your
   attended sessions. CLI enforces invariants; skills teach judgment. Both postures share one
   discipline, which is what makes the unified ledger coherent.
6. **Deterministic control loop.** Two beats and a fold — no LLM orchestrator deciding what runs.
   Models do the work; they never run the plane.

## What loopkit is not

Not a coding agent (bring your own — any CLI-invocable model). Not a workflow engine (plans are
fixed DAGs of ordinary items). Not a team platform (solo-operator first; multi-seat is not a
goal). Not a cloud service (your machine, your git, your models, your data). Not two systems
pretending to be one (presets, not planes).

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
