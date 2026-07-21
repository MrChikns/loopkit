# Knowledge index

The console's **Company** page (`/company` — the old `/knowledge` URL 301s here) is an
operator-declared index of the reference docs your work depends on — decision logs, gate/stage
registries, active plan docs, architecture notes — rendered as cards alongside the knowledge picture
so a document cited by a work item is one click away.

It is **opt-in and inert by default.** With no config it renders an instructive empty state, never
an error. If you don't want it, do nothing and ignore the page.

## The one rule: it points, it never stores

The Knowledge page is a **projection, not a home.** Your decision records stay first-class *in the
repo that owns them*, in whatever shape fits that repo — loopkit itself uses one file per decision
([`docs/decisions/ADR-NNN-*.md`](decisions/)); a target might use a single append-only decision log.
The console does not copy, cache, or version any of it. It reads the declared files live on each
request and renders them, so a card **cannot drift** from its source — there is nothing to keep in
sync. Edit the doc in its repo; the card follows.

(Don't confuse this with the ledger. The *numbers* elsewhere on the console — event counts, work
items — are projections of the plane's append-only ledger. The Knowledge *cards* are projections of
plain markdown files in your repos. Same read-only discipline, different source.)

## Configure it

Add a `knowledge` block to your plane config (`<plane-home>/config/loopkit.json`). Two scopes, and
you can use both — they are not either/or:

- **`paths`** — markdown paths/globs resolved against the **plane repo root** (the plane-home itself,
  for single-repo setups or the plane's own notes).
- **`targets`** — a map of *registered target* (by display name or target id) → paths/globs resolved
  against **that target's registered `repoPath`**. This is how a multi-target plane surfaces each
  connected repo's own decision record.

Each entry is either a **bare string** — a literal relative path or glob (`*` matches within one
path segment, `**` across segments), rendered as a markdown card per matched file — **or a source
object** with an explicit label and rendering kind:

- `path` — the file (absolute, or resolved against the scope's root). A **relative** `path`
  containing `*` is itself a glob — the source object then expands to one record per matched
  file, all sharing the object's `kind` (each file's own basename is its label; a configured
  `label` isn't used across multiple files — it would be ambiguous which file it names). An
  **absolute** `path` is always literal, even if it contains `*`.
- `label` — the card/region title (defaults to the file basename; ignored for a glob `path`).
- `kind` — `"markdown"` (default; renders a card) or `"decision-log"` (parsed into decision
  cards, driving the Decisions region and the active-decisions glance metric).

```json
{
  "knowledge": {
    "paths": ["docs/architecture/*.md"],
    "targets": {
      "acme-web": [
        { "path": "docs/decisions.md", "kind": "decision-log", "label": "Decision log" },
        { "path": "docs/vision.md", "label": "Product vision" },
        "docs/plans/*.md"
      ]
    }
  }
}
```

An entry naming a target that isn't registered still renders — as a visible "unresolved" card,
not a silent drop — so a typo in a target name is obvious rather than mysterious. A **target
switcher** at the top of the page (All + one chip per registered target) filters the view via
`?target=<name>`. A glob `path` that matches nothing yields one visible error record too (never
silence), so a stale config reads as such.

## The decision-log convention

`kind: "decision-log"` is deliberately a **convention** — a documented markdown shape the parser
recognizes — not a plugin interface. There is no registration hook, no custom parser per repo.
If your decisions are written in one of the shapes below, point a source at them and they render
as decision cards; if not, keep them as plain `"markdown"` cards. (Why a convention rather than a
pluggable parser API: [ADR-006](decisions/ADR-006-decision-parsing-convention.md).)

The id token recognized in both shapes is a generic `PREFIX-NNN` — any uppercase-led prefix
followed by a dash and digits (`D-1`, `ADR-001`, `RFC-12`, …). Two document shapes are supported,
and a document may mix both:

**(a) Single-file, append-only log.** One file, one heading per decision, oldest entry first:

```markdown
## D-001 — Adopt event sourcing
Status: Active
Date: 2026-01-05
We store commands as events.
```

or a date-headed variant with the id/status on a metadata line instead of the heading:

```markdown
### 2026-01-05 — Adopt event sourcing
**ID:** D-001 · **Status:** Active
We store commands as events.
```

**(b) One-decision-per-file (ADR-style) directory.** Wire it with a glob `path` in a source
object — this is how loopkit's own [`docs/decisions/`](decisions/) is surfaced:

```json
{ "path": "docs/decisions/*.md", "kind": "decision-log", "label": "Decision log" }
```

Each matched file is expected to open with an id-carrying heading, e.g.:

```markdown
# ADR-001 — One default plane per machine

**Status:** active

A machine runs ONE default plane...
```

The `Status:` line is optional (defaults to `Active` when absent) and case-insensitive on input —
`active`, `Active`, and `ACTIVE` all normalize to `Active` for the active-decisions count; only the
first character is capitalized, so a longer status like `superseded by ADR-004` renders as
`Superseded by ADR-004`.

A decision-log source (single-file or glob) that parses to nothing falls back to a plain markdown
card — never a crash.

## What's worth surfacing

Good candidates are the docs someone lands on to answer *"why is it shaped this way?"* and
*"where are we?"*:

- the decision log / ADRs (the technical-direction record)
- the gate or stage registry (what's shipped, what unlocks next)
- active implementation-plan docs
- the load-bearing architecture / system-concept notes

## A note on what you expose

The console may be reachable beyond your own machine (a shared LAN, a Tailscale node, a public
demo). The Knowledge page renders whatever you point it at, verbatim. **List only docs you're
comfortable being visible in that context** — surface the technical direction, not private
strategy, finance, or personal notes. When in doubt, scope the globs tighter, not wider.
