# ADR-003 — Run-state lives beside the ledger it describes

**Status:** active

Watermarks, beat locks, lastrun stamps, salvage patches, manifests, notified-dedup
flags: all of it describes ONE plane's ledger and must live under THAT plane's
root (`<plane-home>/runs/`), never derived from the driven repo's path. Mixing
roots is not hypothetical: at cutover, beats read the retiring plane's watermarks
against a fresh ledger and the regression guard (correctly) halted the plane.
The guard halting on confusing inputs is the designed behavior — the fix is one
resolved run-root threaded through the beat options, defaulting to the embedded
layout for back-compat. Exception: files written by EXTERNAL producers (e.g. a
statusline quota drop file) keep their contract paths — external producers are
not run-state.
