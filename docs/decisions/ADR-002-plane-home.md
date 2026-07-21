# ADR-002 — Plane-home layout; config activates on explicit env only

**Status:** active

The plane's own state lives under one git-initialized root (default `~/.loopkit`):
`ledger/` `config/` `targets/` `runs/`. Resolution precedence: explicit
`LOOPKIT_HOME` → deprecated `LOOPKIT_LEDGER` pin (legacy embedded) → existing
`~/.loopkit` → existing in-repo `.ai/ledger` (embedded mode) → fresh `~/.loopkit`.

CONFIG is stricter than the ledger: it switches to the plane-home file only when
`LOOPKIT_HOME` is explicitly set. Ambient filesystem state (a `~/.loopkit` merely
existing) may decide where events go, but must never silently change what an
embedded repo's beats DO — and tests without the env var stay hermetic. Learned
live: the first cutover beat ran on framework defaults because the config path
was computed but never consumed; the fix made consumption explicit-only.
