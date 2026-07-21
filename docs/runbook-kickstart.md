# Runbook — never `kickstart -k` the dispatch service mid-build

**Date:** 2026-07-21

## The hazard

Dispatch runs its build SYNCHRONOUSLY inside the beat: while a worker is building, the
dispatch process IS the beat process. `launchctl kickstart -k <dispatch-label>` sends the
service a hard restart (SIGKILL), so running it while a build is in flight murders that
build — the worktree is orphaned, no terminal event is written, and the item looks stalled
until the doctor reaps it.

## The rule

- **Routine re-kick after queueing work:** never needed by hand. The reactor already issues
  a plain, non-destructive `kickstart` (no `-k`) which starts dispatch if idle and no-ops
  ("already running") if a build is in flight, so the next queued item is picked up by the
  successor beat — the running build is never touched. This contract is pinned by a test
  (`dispatchKickArgs` is asserted to omit `-k`).
- **If you must restart dispatch manually:** use plain `launchctl kickstart gui/$(id -u)/
  <dispatch-label>` (no `-k`). It is a no-op while a build runs, which is what you want.
- **Only** use `-k` when you have already confirmed no build is in flight (no live owner pid
  on the dispatch lock). The automated wedge self-heal that does use `-k` gates on exactly
  this liveness check first and reports-instead-of-heals when a build is live — mirror that
  discipline by hand.

## Quick check before any `-k`

1. Read the dispatch lock's `pid` file.
2. If that pid is alive (`ps -p <pid>`), a build is in flight — do NOT `-k`. Wait, or let
   the plain `kickstart` / interval fallback pick up the new work.
3. Only if the lock is absent or its owner pid is dead is `-k` safe.
