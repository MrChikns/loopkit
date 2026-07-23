# Agent integration — how AI assistants and workers connect to the plane

Two different kinds of AI touch a loopkit installation. Keep them distinct:

1. **Worker agents the plane spawns** — headless CLI agents that `dispatch` launches inside a
   worktree of a target repo to build one work item. The plane fully manages these.
2. **Interactive assistants** — an AI pair (e.g. a Claude Code session) the operator runs
   inside a target repo for day-to-day work. These should *cooperate* with the plane, not
   reimplement it.

## 1. How worker agents connect (the plane's side)

Workers are configured in the **plane-home**, not in target repos:

- **Provider registry** (plane config): named providers (`claude-cli`, `codex-cli`, `ollama`)
  with per-role models. The dispatch beat resolves a provider per build, honoring the
  **sensitivity allowlists** — every work item carries `public` / `internal` / `private`, and
  a provider serves a tier only if allowlisted for it (`private` → local model). Resolution is
  fail-closed: unknown sensitivity counts as `private`; no allowed healthy provider means the
  item waits or parks.
- **Tool permissions:** headless workers run with an explicit allowed-tools list passed by the
  dispatch lane (a worker that silently lacks write permission fails on every edit — the plane
  passes the list for you). A target repo may additionally carry `.claude/settings.json` to
  grant project-scoped permissions to workers running inside it.
- **Prompts:** worker prompt skeletons ship with the framework and are copied into the
  plane-home (`.ai/loops/prompts/`); a target may override via the manifest's `promptsDir`.
- The gate is the arbiter: whatever the worker claims, the item merges only when the target's
  own `gateCommand` passes in the worktree.

Do **not** run the beats from inside another sandboxed agent session — the spawned worker
inherits the outer sandbox and fails in confusing ways. Beats belong to a scheduler (launchd)
or a plain terminal.

## 2. How an interactive assistant should behave in a target repo

If the repo you are working in contains `loopkit.target.json`, a delivery plane may be driving
it. The contract:

- **Capture, don't duplicate.** New feature/fix intent the operator voices should be captured
  as a work item — `loopctl new "<text>"` — not silently built inline, unless the operator
  explicitly wants it done in-session. The plane event-models, builds, gates, and merges it.
- **Check the board before starting work** (`loopctl board` / `loopctl state`): an item
  covering the same surface may already be queued or building in a worktree. Two writers on
  one surface is the failure mode this system exists to prevent.
- **Never run the beats yourself** inline (see the sandbox warning above), and never edit
  ledger files by hand — the ledger is append-only, written only through `loopctl` /the beats.
- **Operator verbs are the operator's.** `approve` / `reject` / `accept` decide what merges
  and what ships; an assistant may *recommend*, but the verb belongs to the human unless
  explicitly delegated.
- Worktrees with the manifest's `worktreePrefix` next to the repo belong to in-flight builds —
  leave them alone.

**Ready-made skills.** This repo ships the interactive side of the contract as Claude Code
slash commands in [`.claude/commands/`](../.claude/commands/): **`/drive`** — attended
coordinator mode (session + claims per
[ADR-007](decisions/ADR-007-claim-arbitration.md), build via `loopctl conduct` or parallel
subagent builders, everything landing as ledger events); **`/plane-check`** — deterministic
health triage (doctor/summary/slo) with each finding routed to a heal, a repair item, or an
operator decision; **`/board`** — the status window. `/drive` is the sanctioned form of "the
operator explicitly wants it done in-session": it is not a second delivery mechanism beside the
plane — it claims through the same lease kernel and lands its merges as evidence-carrying ledger
events on the same board (`conduct` writes the beats' full event trail; the coordinator path
writes a single `item.merged` with diff/gate/session evidence). The skills load
automatically in any Claude Code session opened in this repo; to get the same verbs in a target
repo, copy them into its `.claude/commands/` and adapt both the `$LOOPCTL` path **and** the
`docs/` links (they are written repo-relative to this repo).

### Copy-paste snippet for a target repo's `AGENTS.md` / `CLAUDE.md`

Adapt the paths, then paste:

```markdown
## Delivery plane (loopkit)

This repo is a registered target of a loopkit plane (`loopkit.target.json` at the root).
- Capture build/fix intent as work items instead of building inline:
  `node <path-to-loopkit>/packages/core/dist/cli.js new "<plain-English intent>"`
- Before editing, check for in-flight items on the same surface: `... cli.js board`
- Never edit `.jsonl` ledger files, never run `... beat reactor|dispatch` from inside an
  agent session, and leave `<worktreePrefix>*` sibling directories alone.
- approve/reject/accept are operator verbs — recommend, don't execute them.
```

## 3. High-level: what this is good for (the 60-second version)

You run a repo. You want an agent to deliver real changes to it — but you've been burned:
parallel work trampling itself, crashed runs leaving lies behind, "done" claims nothing
verified, no record of what happened or why.

loopkit's answer is to treat delivery itself as an event-sourced system:

- every intent, build, gate result, merge, and human decision is an **immutable event** in one
  append-only ledger — the full history is replayable and auditable;
- builds happen in **isolated worktrees**, scoped so parallel items can't collide;
- a merge requires the target's **own test gate green** — the gate is the reviewer of record;
- **tiered acceptance** routes human attention: framework-internal changes ship silently,
  product surfaces surface for your test, risk paths wait for you forever;
- **sensitivity-aware routing** keeps private material on local models, fail-closed.

The operator's whole interface is two touchpoints: drop intent, answer the few decisions that
genuinely need a human. Everything between is the plane — and everything the plane does leaves
evidence.
