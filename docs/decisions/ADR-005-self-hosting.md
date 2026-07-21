# ADR-005 — The plane builds its own framework as an ordinary target

**Status:** active

A loopkit plane may register the loopkit repository itself as a target and build,
gate, and merge framework changes exactly like any other target's work. There is
no special-cased "framework lane": self-hosting rides the same ledger, the same
beats, the same gates.

The one deliberate boundary: **self-hosting is not self-publishing.** The plane
merges to the target's local default branch; pushing a public remote stays an
operator-gated act behind whatever leak-scanning ritual the operator runs. An
autonomous system improving its own engine is healthy; an autonomous system
publishing its own code without a human at the boundary is not.

Consequence at N≥2 targets: intent capture must name its target — sole-target
inference no longer applies, and the console's target selector becomes required
surface, not a nice-to-have.
