# ADR-001 — One default plane per machine; detached planes, never federation

**Status:** active

A machine runs ONE default plane (`~/.loopkit`): one ledger, one fold, one console,
many registered targets. Isolation, when genuinely needed, is a fully DETACHED
second plane via an explicit `LOOPKIT_HOME` — its own ledger, beats, and console.
There is deliberately no federation: no cross-plane aggregation, no plane-of-planes.
Aggregation invites a second source of truth and a second parser over someone
else's ledger; both are how event-sourced systems rot. If two planes must share a
picture, that picture is a human reading two consoles.
