# AGENTS.md — operating guide for AI agents in this repo

Read this first. It exists so you can act without scanning the whole tree.

## What loopkit is (30 seconds)

loopkit is an **event-sourced autonomous delivery plane**: an operator describes a change in
plain English; the plane records it as a work item in an **append-only ledger**, builds it as a
vertical slice in an **isolated git worktree** of a target repo, proves it with the target's own
**deterministic gate** (its test suite), merges on green, and routes human attention through
**tiered acceptance** (auto / optional / review / must). Two scheduled beats drive everything:
`reactor` (routes intents, merges approved work, self-heals) and `dispatch` (picks disjoint
queued items, spawns worker agents, gates, merges). The ledger is the authority for work state;
views may also read explicit operator configuration and bounded run artifacts.

Good for: a solo operator who wants agents to deliver real slices of real repos without
babysitting them, and who wants an auditable, replayable record of everything the system did.
Status: experimental v0.1, single-target preview, macOS + Claude CLI workers. See `README.md`
for the full story, `docs/` for design (event model, trust boundaries, operating model, vision).

## The three repos — never mix them

1. **This repo** — framework code only. Executed like a package, **never written to at
   runtime**. No ledgers, no logs, no operator data belong anywhere under this tree.
2. **The plane-home** (operator-created, elsewhere) — ALL runtime state: ledger, target
   registrations, provider config, run logs. Its own git repo.
3. **Target repos** (elsewhere) — the code being delivered. Each carries only a small
   non-secret manifest, `loopkit.target.json`.

If a change you're making would write runtime state under this repo, the change is wrong.

## Repo map

- `packages/core` — the engine: ledger + fold (`fold.ts`, `ledger.ts`), the two beats
  (`beats/reactor.ts`, `beats/dispatch.ts`), CLI (`cli.ts`, bin name `loopctl`), acceptance
  tiering, provider registry, target manifest (`target.ts`), doctor/self-heal. Zero runtime
  dependencies — Node built-ins only.
- `packages/console` — thin HTTP console over the fold. Server-rendered links/forms work without
  JavaScript; fixed external scripts progressively enhance the shell, disclosures, dialogs and
  live refresh. No third-party runtime dependencies beyond Node built-ins and Loopkit workspaces.
- `.claude/commands` / `.agents/skills` — optional repo-local attended helpers for Claude Code
  and Codex. They drive the same ledger/claim contracts; `loopctl` does not install them.
- `examples/` — the demo target + setup script; the README quickstart runs against it.
- `docs/` — event-model · trust-boundaries · operating-model · vision.

## Build & test (run these; report results honestly)

```bash
npm install                                  # workspace root
(cd packages/core && npm run build && npm test)
(cd packages/console && npm test)            # builds dist-test, runs node --test
```

A change is not done until both suites are green. Never skip or hide a failed run.

## Hard rules

1. **Append-only doctrine.** Events are immutable; state changes are new events; recovery paths
   read the log — they never rewrite it. No in-place mutation of ledger files, ever.
2. **One parser / one predicate per behavior.** If you need logic that already exists (verb
   handling, manifest parsing, fold transitions), export and reuse it — a second implementation
   of the same rule is a defect even if it passes tests.
3. **No new runtime dependencies** in `packages/core` or `packages/console`. Dev-deps need a
   stated reason.
4. **Fail closed on trust surfaces.** Unknown sensitivity → `private`. Missing judge verdict →
   recorded `unavailable`, floored at `review`. No allowed healthy provider → wait or park,
   never route around the allowlist. Preserve these properties in any change near routing,
   acceptance, or merging.
5. **The console keeps a no-JS functional baseline** and remains read-pure on GET; mutations are
   explicit POST verbs. Client scripts may progressively enhance existing links/forms but may not
   become the only path to an operator action or authoritative work state.
6. **This repo is destined to be public.** No personal names, emails, absolute `/Users/...`
   paths, private hostnames, or references to the author's private projects in code, comments,
   tests, fixtures, or commit messages. Neutral vocabulary: "operator", not a person's name.
7. **Honest claims only.** README/docs state what is proven, with dated proof; roadmap items
   are labelled roadmap. Never add "production-ready", "provider-agnostic", or multi-target
   claims ahead of demonstration.
8. TypeScript ESM throughout; tests via `node --test`; match the existing style of the file
   you touch.

## This repo is a registered target of its own plane

This checkout carries `loopkit.target.json` at its root: a loopkit plane may register loopkit
itself as a target and build, gate, and merge framework changes exactly like any other target's
work ([ADR-005](docs/decisions/ADR-005-self-hosting.md)). There is no special-cased "framework
lane" exempt from the ledger — self-hosting rides the same ledger, the same beats, the same
gates as every other target.

**The canonical rule, provider-neutral:** if a checkout is registered as a loopkit target —
including loopkit itself — every code-bearing change needs a work item and a delivery receipt
(a `build.dispatched → gate.* → item.merged` trail from the beats, or the coordinator's
evidence-carrying `item.merged`). Deciding to do the work *in an attended session* selects the
attended coordinator path (`/drive`, `docs/agent-integration.md` §1); it does not bypass the
ledger. There is no mode in which an agent edits this repo's source and commits it without one
of those two paths producing a ledger event.

**Break-glass.** The one narrow, load-bearing exception is `git commit --no-verify`/direct
`git commit` outside any plane session — e.g. a human operator working locally with no agent
involved, or recovering a wedged plane. It is not a second delivery mechanism for an agent to
reach for when the ledger is inconvenient: an agent taking this path must state the reason in
the commit message and the work needs a follow-up work item that records the change and carries
it through gate + acceptance after the fact (certification, not silent absorption — see
`docs/method.md` "Certify, don't brief"). The one *designed* boundary at this layer is narrower
than that: self-hosting is not self-publishing — the plane merges to this repo's local default
branch, but pushing the public remote stays an operator-gated act (ADR-005). That publish gate
is not a general license to skip the ledger for merges to `main`.

Contributing code to this repo is otherwise **using the plane against a target** — this repo is
just one target among however many are registered. For the full contract of how an agent inside
*any* target repo (including this one) should talk to the plane — capture intents, read the
board, what never to do — see `docs/agent-integration.md`, including a snippet adopters paste
into their own repo's `AGENTS.md`/`CLAUDE.md` that covers the self-target case too.
