# Hardening audit — 10-class incident catalog

**Date:** 2026-07-21  
**Scope:** proactive hardening pass over the framework against a 10-class incident
catalog distilled from prior operational near-misses. Read-only inspection plus
narrow, uncontested fixes; broader or in-flight fixes are recorded as follow-ups.

**Verdict legend**

- **TESTED-OK** — already handled AND pinned by an existing test.
- **FIXED-HERE** — a small, self-contained fix landed in this pass (with a new test).
- **GAP-FOLLOW-UP** — real gap, but the fix touches a file under concurrent edit or is
  larger than an audit-scoped change; the exact fix is described for a follow-up work item.
- **N/A** — not applicable to this codebase, with the reason.

## Verdict table

| # | Class | Verdict | Evidence / follow-up |
|---|-------|---------|----------------------|
| 1 | Worktree symlinked node_modules masking stale local packages | TESTED-OK | Overlay logic in `packages/core/src/beats/worktree-deps.ts:215-321`; the root-is-also-a-member edge is handled at `worktree-deps.ts:235-250` (`isWorkspacesRoot` → every member treated as an implicit local dep, built in workspaces order). Edge pinned by `worktree-deps-root-workspace.test.ts` cases (a)/(b)/(c). |
| 2 | Gitignored dist stale under live beats | GAP-FOLLOW-UP | Member-package dist IS rebuilt per dispatch and fails fast on error (`worktree-deps.ts:345`, `reactor.ts:2166`, `dispatch.ts:2635`). But no doctor backstop heals the framework's OWN gitignored CLI dist that the beats exec. `doctor.ts` (contested) checks orphan/stall/regression/stale-claim only — no dist check. **Follow-up:** add a doctor check that stat-compares the framework `dist` entrypoint mtime against its newest `src` mtime and, when stale, rebuilds (or flags) before the next decompose/dispatch. Touches `doctor.ts` (contested). **UPDATE (2026-07):** this landed after the audit — `detectDistDrift` (`packages/core/src/doctor.ts:445`) compares the newest self-hosting merge against the framework dist's mtime and, wired into the CLI's status path (`cli.ts:1211`), re-runs the target's `deployCommand` to self-heal when drifted, else surfaces the gap. Tests: `packages/core/test/doctor.test.ts` (`detectDistDrift` cases). The verdict above is left as originally written (it was correct at audit time); treat this class as **FIXED**, not open. |
| 3 | spawnSync 1 MiB default maxBuffer truncating big output | FIXED-HERE | Full inventory taken. The two large-output sites (gate command) already carry explicit large buffers + ENOBUFS handling (`reactor.ts:498` 64 MiB, `dispatch.ts:73` `SPAWN_MAX_BUFFER` 32 MiB). All other core spawnSync calls read bounded output (rev-parse/status/branch). The one unbounded diff-capture — `captureWorktreeDiff` in `judge.ts` — relied on the incidental `maxChars << 1 MiB` invariant; a future large `maxDiffChars` would silently truncate the review diff at 1 MiB with no marker. **Fixed:** explicit `maxBuffer` on both diff spawns + an ENOBUFS guard that force-marks truncation. Test: `packages/core/test/judge-diff-buffer.test.ts`. |
| 4 | Beat lock orphaned by a crashed process | FIXED-HERE (test) | Reclaim exists in the acquire path: `beatLockOwnerAlive` (`dispatch.ts:385`) + `acquireReactorLock`/`acquireDispatchLock`; empty-dir and dead-pid cases pinned by `lock-reclaim.test.ts`. The remaining crash-mid-append shape (owner killed while writing its pid file → partial/garbage/empty pid) was unpinned. **Added** `packages/core/test/lock-reclaim-crash.test.ts` proving a corrupted/empty pid reads as no-readable-owner and is reclaimed, while a live pid with trailing residue still blocks. No src change needed — behaviour was correct, now regression-pinned. |
| 5 | Oversized ledger events crashing the appender | TESTED-OK | `appendEvent`/`appendEvents` never throw on oversize; `shrinkEventToFit` (`ledger.ts:88`) clips the longest free-text field, keeping structural fields and a byte-count marker, bounded to converge. Pinned by `oversized-event.test.ts` (4 tests incl. a batch where one event is oversized — the whole batch still writes, no beat crash). |
| 6 | launchd host-state drift (installed plists/shims vs repo copies) | GAP-FOLLOW-UP | The doctor does not diff installed launchd state against repo copies (`doctor.ts` has no launchd logic). A related audit-time probe verifies configured loop labels appear in launchctl (`audit/checks.ts` via `slo.ts` launchd probe), but that runs on the manual audit command, not in-beat, and does not detect installed-but-stale or never-installed plists/shims. **Follow-up:** a check that compares each repo ops plist/shim against its installed counterpart (content hash + presence) and flags drift. New standalone module; audit-vs-beat placement is a design call. |
| 7 | kickstart -k killing an in-beat sync build | TESTED-OK + FIXED-HERE (doc) | Routine dispatch kicks use plain `kickstart` (no `-k`), documented at `reactor.ts:258-263` and pinned by `beats.test.ts:465` (`dispatchKickArgs` is non-destructive). The only `-k` is the wedge self-heal runbook (`runbooks.ts:141`), gated by a beat-in-flight liveness check that reports-instead-of-heals when a build is live (`runbooks.ts:127`). No code path auto-`-k`s a live dispatch. **Added** an operator runbook note (`docs/runbook-kickstart.md`) so a human never manually `-k`s dispatch mid-build. |
| 8 | Headless workers hallucinating timestamps without a clock | GAP-FOLLOW-UP | The worker prompt (`dispatch.ts` `buildPrompt`) injects no wall-clock time, and the worker allow-list (`BUILDER_TOOLS`, `dispatch.ts:82`) has no date command, so a worker that needs 'now' can only invent it. **Follow-up:** either inject an ISO timestamp line into the worker prompt at spawn, or add a read-only date command to the allow-list. Touches `dispatch.ts` (contested). |
| 9 | Server-rendered pages serving assets from a lagging checkout | GAP-FOLLOW-UP (verdict-only) | Console/opsui read CSS/JS live from `src/` at request time (`console/src/server.ts` readFile of `src/styles/...`), so a server run from a worktree behind the merged code serves stale/broken assets. Console is under concurrent edit — READ-ONLY verdict, no fix here. **Follow-up:** serve request-time assets from built `dist/` (or assert the serving checkout is at the deployed SHA on boot). Design + contested-file change. |
| 10 | Fabricated completions (worker claims done, no commit) | TESTED-OK | Dispatch detects a finished worker that produced no commit and parks it with an evidence log, after a reality-check for an already-shipped item (`dispatch.ts:~3145`). Pinned by `beats.test.ts` ("dispatch: no-commit park still writes an evidence log") plus related coverage in `detached-dispatch.test.ts` / `repair-loop.test.ts`. |

## Fixes landed in this pass

1. **Class 3** — `packages/core/src/judge.ts`: explicit `maxBuffer` (64 MiB) on both
   `captureWorktreeDiff` git-diff spawns, plus an ENOBUFS guard that force-appends the
   truncation marker so the reviewer is never handed a silently-clipped fragment as if it
   were the whole diff. New test: `packages/core/test/judge-diff-buffer.test.ts`.
2. **Class 4** — `packages/core/test/lock-reclaim-crash.test.ts`: new regression pin for
   crash-mid-append to a beat lock's pid file (corrupted/empty pid reclaimed; live pid with
   trailing residue still blocks). Behaviour was already correct; this closes the test gap.
3. **Class 7** — `docs/runbook-kickstart.md`: operator note that a manual `kickstart -k` of
   the dispatch service can murder an in-beat sync build; the safe kick is plain `kickstart`.

## Notes

- Follow-ups for classes 2, 6, 8, 9 all require touching files under concurrent edit or a
  design decision; each row above states the exact intended fix.
- All identifiers here are generic; no downstream target or product names are referenced.
