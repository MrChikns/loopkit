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
| 9 | Server-rendered pages serving assets from a lagging checkout | GAP-FOLLOW-UP (verdict-only) | Console/opsui read CSS/JS live from the serving checkout, so a server run from a worktree behind the merged code can serve stale assets. Console was under concurrent edit — READ-ONLY verdict, no fix landed in the audit itself. **UPDATE (2026-07):** startup now calls `checkoutDriftReason` (`packages/console/src/server.ts`) and refuses a checkout that is behind or diverged from its configured upstream; an ahead checkout remains valid and no network fetch occurs at boot. `packages/console/test/checkout-drift.test.ts` pins in-sync, ahead, behind, diverged, no-upstream and explicit-bypass cases. Treat this class as **FIXED**, not open. |
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

- Classes 2 and 9 landed after this dated audit; their rows preserve the original verdict and
  carry explicit updates. Follow-ups for classes 6 and 8 remain open and require a design call
  or work outside this audit's narrow scope.
- All identifiers here are generic; no downstream target or product names are referenced.

## 2026-07-30 hardening wave

Two further passes landed after the dated audit above: a morning pass closing several of the
gaps this catalog and adjacent operational near-misses had surfaced, and an afternoon attended
drain adding prompt-input and promotion-governance hardening on top. Both are merged to the
default branch; neither rewrites the verdict table above, which stays a historical record of
its own dated pass.

**Morning wave (WI-218…232):**

- **Self-target governance contract** (WI-218) — the plane's own repo and a build target it
  manages are no longer conflated in agent-facing docs; the self-target contract is reconciled
  across `AGENTS.md`/`CLAUDE.md`/`docs/agent-integration.md`.
- **Deploy relaunch storm + timeout pre-emption** (WI-219) — a pending deploy no longer gets
  relaunched repeatedly within a single beat, and a beat timeout no longer pre-empts in-flight
  crash-recovery ordering.
- **Merge evidence recorded before cleanup** (WI-220) — the target-lane merge evidence event is
  now appended before the worktree/branch cleanup that would otherwise destroy the only record
  of what happened.
- **Egress-guard credential-shape false negatives** (WI-221) — the egress guard no longer skips
  whole classes of secret by shape; the false-negative gap is closed.
- **Deploy reconciliation pinned to the gated merge SHA** (WI-223) — reconciliation no longer
  drifts onto whatever the branch tip happens to be; it is pinned to the SHA that actually passed
  the gate.
- **Detached-checkout wedge recovery + artifact filtering** (WI-222) — a crash-detached target
  checkout is re-attached, and plane-artifact residue no longer blocks the clean-checkout guards
  that deploy relies on.
- **Observable fold transition rejections** (WI-224) — a rejected item-flow state transition is
  now surfaced instead of silently dropped.
- **Ledger-verified commit provenance at promotion boundaries** (WI-232) — the provenance
  verifier (see ADR-014) starts here: commits reaching the default branch are checked against the
  operator's real ledger, not a forgeable trailer.

**Afternoon attended drain (WI-234…246, WI-257):**

- **Judge prompts carry a gate-result summary** (WI-234) — the reviewer sees what the gate
  actually reported, not just the diff.
- **Router prompts carry a related-in-flight-items projection** (WI-235) — routing decisions are
  made with visibility into what else is already queued or building.
- **Shared truncation helper caps previously-unbounded prompt inputs** (WI-236) — the
  uncapped-input class from earlier passes gets a single reusable cap rather than a
  site-by-site fix.
- **Provenance verifier runs report-only on the reactor doctor beat, and covers the dist-drift
  self-heal path** (WI-239, WI-240) — the promotion check is no longer only a push-time gate; it
  watches on a beat cadence and also covers the local, ungoverned-runtime-promotion path a
  push-time gate never observes.
- **Merge receipts carry gate-run vs self-declared attestation** (WI-241) — a receipt whose
  gate evidence is an execution record (a beat-recorded `gate.passed`) is now distinguished from
  one whose gate evidence is a free-text claim typed onto the same merge event.
- **`leak-scan --range` scans author/committer identity, with an anchored GitHub-noreply
  exemption** (WI-243) — identity fields are no longer a blind spot in range-mode scans; the
  placeholder noreply domain is exempted by an anchored match, not a loose substring.
- **A commit-msg hook rejects agent session-URL trailers** (WI-244) — a session URL can no
  longer land in a commit message at the source.
- **Dispatch fails loudly on a target/repoRoot mismatch before any worktree is created**
  (WI-246) — the mismatch is caught before it can produce a worktree pointed at the wrong repo.
- **Provenance probe wired live onto the reactor beat** (WI-257) — the doctor-beat provenance
  check from WI-239 is connected to the real probe implementation rather than a stub.

Full design context for the provenance work (WI-232, WI-239-241, WI-257) is
[ADR-014](decisions/ADR-014-provenance-verification.md); it also states plainly what this wave
does *not* yet buy (report-only self-heal coverage, receipt-without-attempt-binding, non-adversarial
break-glass timing).

### Open items from the 2026-07-30 cross-referenced audit

Two independent reviewers (one Claude-based, one Codex-based) scanned the framework separately;
findings were cross-referenced afterward. The following themes came out of both scans and are
tracked as work items, not yet closed:

- Worker/gate subprocess environment isolation, and scanning inbound worker output for leakage —
  the top gap of the two scans.
- Terminal-event durability ordering — merge receipts should be durable before cleanup on every
  lane, not only the one lane WI-220 fixed.
- A reclaim protocol for the ledger/beat lock — token-conditional reclaim plus lease renewal,
  rather than the current liveness-only checks.
- Launch-intent journaling before a worker is spawned.
- Binding provenance gate evidence to a specific attempt and SHA, closing the gap ADR-014 already
  names.
- Console CSRF/CSP hardening, plus inline-SVG hardening.
- Fold ordering that does not depend on wall-clock time.
- Self-heal promotion preconditions — requiring a clean checkout pinned to a receipted SHA before
  a self-heal path is allowed to promote.
