# CLAUDE.md

Read [`AGENTS.md`](AGENTS.md) first — it is the canonical operating guide for AI agents in this
repo (what loopkit is, the three-repos rule, build/test commands, hard rules). Everything there
applies to you. This file adds Claude-specific notes on top of it.

## Working on loopkit's own source

This repo is a registered target of its own plane (`loopkit.target.json` at the root,
[ADR-005](docs/decisions/ADR-005-self-hosting.md)) — see AGENTS.md's "This repo is a registered
target of its own plane" for the canonical rule. It applies here without exception: a normal
Claude Code session working on `packages/core`, `packages/console`, `packages/ui`,
`packages/opsui`, `docs/`, or `examples/` is not exempt from the ledger just because the change
is "in-session" or feels like ordinary software engineering. Capture the intent
(`loopctl new "<text>"`), then deliver it through the attended coordinator
([`/drive`](.claude/commands/drive.md), described in `docs/agent-integration.md`) or leave it
queued for the beats — either path produces the evidence-carrying ledger events that make a
merge legitimate. Reading the relevant package's tests first, making the smallest change that
satisfies AGENTS.md's hard rules, and keeping `npm test` green in the packages you touch all
still apply — they're necessary, just not sufficient without the receipt.

Full detail on the plane contract — capture intent, read the board before starting, never run
the beats from inside another sandboxed agent session, never edit ledger files by hand, operator
verbs stay the operator's — lives in
[`docs/agent-integration.md`](docs/agent-integration.md). Don't restate it here; read it. There
is exactly **one** deterministic delivery mechanism (the ledger + the two beats, or the
coordinator riding the same ledger); an attended assistant recommends and captures, it does not
stand up a second, ad hoc coordination path outside it.

## A useful acceptance-tiering detail

If you ever hand-construct an `item.merged` event (e.g. while testing the console or the fold),
include `touches` — the same comma-joined path-prefix string the build's `Touches` scope used —
alongside any build evidence (`commit`, `gateCommand`, `baseSha`/`headSha`). The acceptance-tier
classifier (`packages/core/src/acceptance.ts`) treats a merged item that carries gate/sha
evidence but no `touches` as an unresolved evidence gap, not as "no code changed" — it
conservatively holds the item at `review` tier rather than silently auto-accepting a code-bearing
merge. Omitting `touches` doesn't skip review; it just costs the operator an unnecessary manual
look at the acceptance desk.
