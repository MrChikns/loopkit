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
- [ADR-007](ADR-007-claim-arbitration.md) — ownership is an event; claims arbitrate attended sessions against armed beats with no mode flip
- [ADR-008](ADR-008-detached-dispatch-staging.md) — detached dispatch lands staged behind a default-off flag; an unset flag is byte-for-byte today's behaviour
- [ADR-009](ADR-009-portability-completion.md) — the portability nudge gets a real completion path; an operator reply appends an event instead of sitting unparsed
- [ADR-010](ADR-010-one-lane.md) — one parameterised build lane; lane is configuration, not a forked code path, and the plane must get smaller
- [ADR-011](ADR-011-lane-collapse-measurement.md) — amends ADR-010's measurement clause (it was satisfiable by moving code sideways); refuses the batch-lane migration; a subsystem that runs without recording is worse than one that is off
- [ADR-012](ADR-012-no-lanes.md) — there are no lanes and no modes: one build path, differences derived per item, two triggers (beat or CLI drain); the collapse itself is where the deletion is
- [ADR-013](ADR-013-delete-the-conductor.md) — delete the conductor: it never produced a ledger event, and the clustering it named already ships as batch co-location, though only for untargeted items (amended 2026-07-25); supersedes ADR-012's "collapse it into the one path"
- [ADR-014](ADR-014-provenance-verification.md) — ledger-verified commit provenance is enforced at the push boundary and watched report-only on the doctor beat; receipts distinguish a real gate execution from a self-declared claim, and break-glass is a time-boxed ledgered exception, not a config toggle
- [ADR-015](ADR-015-verified-knowledge-promotion.md) — (proposed) verified knowledge promotion: the playbook becomes a projection of ratified, gate-proven knowledge events — harvested from merges by a default-reject strict auditor, human-ratified through the existing verbs, revalidated at read time; no auto-promotion in v1
