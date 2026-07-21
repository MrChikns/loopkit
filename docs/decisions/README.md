# Decision log

Architectural decisions for loopkit itself — append-only, one file per decision,
`ADR-NNN` ids. A decision is never edited after the fact; supersede it with a new
entry and mark the old one. The operational decision desk (parked work items on
the console) is a different thing: that is the plane asking its operator about
*work*; this log records why the framework is shaped the way it is.

- [ADR-001](ADR-001-one-plane.md) — one default plane per machine; detached planes, never federation
- [ADR-002](ADR-002-plane-home.md) — plane-home layout; config switches only on explicit env, never ambient state
- [ADR-003](ADR-003-run-state.md) — run-state lives beside the ledger it describes
- [ADR-004](ADR-004-one-console.md) — one console shape; target-specific surfaces are extensions, not forks
- [ADR-005](ADR-005-self-hosting.md) — the plane builds its own framework as an ordinary target; self-hosting is not self-publishing
- [ADR-006](ADR-006-decision-parsing-convention.md) — decision-source parsing is a documented convention (generic PREFIX-NNN ids), not a plugin interface
