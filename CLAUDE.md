# CLAUDE.md

Read [`AGENTS.md`](AGENTS.md) first — it is the canonical operating guide for AI agents in this
repo (what loopkit is, the three-repos rule, build/test commands, hard rules). Everything there
applies to you. This file adds Claude-specific notes on top of it.

## Contributing to this repo vs. driving a plane

This file is about **working on loopkit's own source** (`packages/core`, `packages/console`,
`packages/ui`, `packages/opsui`, `docs/`, `examples/`) in a normal Claude Code session — edit,
run the tests, commit. That is ordinary software engineering: read the relevant package's tests
first, make the smallest change that satisfies AGENTS.md's hard rules, and never call a change
done until `npm test` in the packages you touched is green.

**Driving a loopkit *plane*** (registering a target, dropping intent, running the `reactor`/
`dispatch` beats against some other repo) is a different activity, described in
[`docs/agent-integration.md`](docs/agent-integration.md). If you are an assistant working
*inside a target repo* that loopkit is delivering to, follow that doc's contract instead of this
one — in short: capture intent as work items, never build inline, never run the beats from
inside another sandboxed agent session, and never edit ledger files by hand. There is exactly
**one** deterministic delivery mechanism (the ledger + the two beats); an attended assistant
recommends and captures, it does not stand up a second, ad hoc coordination path outside it.

## A useful acceptance-tiering detail

If you ever hand-construct an `item.merged` event (e.g. while testing the console or the fold),
include `touches` — the same comma-joined path-prefix string the build's `Touches` scope used —
alongside any build evidence (`commit`, `gateCommand`, `baseSha`/`headSha`). The acceptance-tier
classifier (`packages/core/src/acceptance.ts`) treats a merged item that carries gate/sha
evidence but no `touches` as an unresolved evidence gap, not as "no code changed" — it
conservatively holds the item at `review` tier rather than silently auto-accepting a code-bearing
merge. Omitting `touches` doesn't skip review; it just costs the operator an unnecessary manual
look at the acceptance desk.
