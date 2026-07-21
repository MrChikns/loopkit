# ADR-008 — Detached dispatch, staged behind a default-off flag (phase A)

**Status:** active

## Context

The dispatch beat builds work items SYNCHRONOUSLY inside the beat: it spawns a worker,
`await`s it to completion in-process, then runs the terminal path (gate → rebase →
merge+push → cost/evidence/salvage) before the beat returns. A beat therefore lasts as
long as the builds it started — a multi-item drain occupies the whole beat interval.

Sync-in-beat was a deliberate hardening choice, not an accident: an attached child dies
with the beat, so there are no orphaned worker processes to reap, and every state
transition is provable in-process (the beat observes the exit code directly). The cost is
throughput — the beat is serialized on build wall-clock, and a long build blocks the
interval.

A prior slice landed the SUBSTRATE for a detached model but left it dormant, gated on a
worker recording a process-group id (`pgid`) that nothing yet writes:

- `exitfile.ts` — atomic (`tmp`+`rename`) exit-sentinel write; graceful null-on-torn read.
- The provider's `run()` already accepts `{ detached, onSpawn(pgid), exitFile }` and,
  when detached, spawns a `setsid` process group and writes the exit file on completion
  via the SAME `parseOutput`/`extractUsage` the in-process path uses (one-parser rule).
- `schema.ts` `build.dispatched` carries optional `pgid`; the fold populates
  `currentBuild.pgid` + `dispatchedAt`.
- The doctor's orphan predicate is fully detached-aware and keyed on `pgid != null`:
  pgid-liveness via `process.kill(pgid, 0)`; the exit-file inversion (dead group +
  exit-file-present = completed-awaiting-collection, NOT orphan); a collection-cycle grace
  (a young detached build with no exit file yet is deferred, never reaped); and a
  post-collection-limbo reap. Every one of these branches is inert while no build records
  a `pgid`.

The migration to detached-by-default was explicitly decided to be **staged, never
one-shot**. This ADR records phase A.

## Decision (phase A)

Land the detached execution PATH behind a config flag that DEFAULTS OFF, so an unset flag
is byte-for-byte the behaviour we ship today, and add the cross-beat collection pass that
the substrate's own comments already assume ("the next dispatch beat's collection phase
will gate/merge it", `doctor.ts`).

1. **Config flag `execution.detachedDispatch`, default `false`.** Read by `runDispatch`.
   It is a **SPAWN-side flag only** — it governs how the beat spawns NEW workers, and
   nothing else. Collection (below) is unconditional.

2. **Flag on → detach-and-return spawn.** For an eligible build the beat passes
   `detached: true`, captures the `pgid` via `onSpawn`, appends `build.dispatched` with
   the pgid (same event shape, plus the pgid the schema already carries), and does NOT
   `await` that worker's completion in this beat. The beat returns while the build runs.

   **Eligibility (fail-closed):** detach applies only to the supported provider
   (Claude-CLI) and to single-item engineering groups. Any build that is not
   detach-eligible — an unsupported provider, a co-located batch group, the planning or
   target lanes — falls back to the SYNC path unchanged. A provider that does not
   synchronously yield a pgid falls back to sync. This keeps the blast radius of phase A
   to exactly one build shape.

   > **UPDATE (2026-07):** the target lane has since gained its own detached-eligible spawn
   > path, following the same §2 eligibility rule (flag on + Claude-CLI provider) — see
   > `runTargetLane`'s collection pass and the detach check in `packages/core/src/beats/dispatch.ts`
   > (target-worktree build loop). "The planning or target lanes fall back to sync" above is
   > **superseded for the target lane**; the planning lane is unaffected and still falls back
   > to sync. This paragraph is left as originally written — it is the record of what phase A
   > shipped — with this note marking where current code has moved past it.

3. **Collection home = the next dispatch beat (NOT the reactor doctor).** The whole
   terminal path — gate, provider-sensitive judging, batch attribution, rebase, non-FF
   merge recovery, push, cost/evidence/salvage, worktree cleanup, deploy — already lives
   in dispatch. Collecting elsewhere would fork a second delivery pipeline. The collection
   pass runs early in `runDispatch`: after the autonomy gate, the dispatch lock, the
   regression guard, and the initial fold — but **BEFORE** the daily-budget/quota/empty-
   queue early returns and before the pick logic, so a beat drains completed work even
   when the queue is empty or spend-capped (those are SPAWN gates; they must never strand
   an already-admitted, finished build). The beat re-folds after collection before picking
   new work.

   **One pipeline, not a second parser.** The existing Phase-2 terminal loop is driven by
   a `workers[]` array and ALREADY treats the on-disk exit file as its authoritative
   outcome, overriding the in-memory promise. Collection therefore reconstructs a worker
   handle for each building item that is detached (pgid recorded) and has a readable exit
   file — a *resolved* provider result decoded from the exit record via the SAME
   `parseOutput`/`extractUsage` — and feeds it through the SAME Phase-2 loop. There is no
   separate collection pipeline and no second outcome parser; a collected build and a
   sync build converge on identical terminal code.

4. **Orphan safety is already built; this ADR only makes it live.** A detached build whose
   process group is dead with NO exit file past the collection-cycle grace is crashed
   honestly by the doctor's existing orphan path (never silent). A dead group WITH an
   uncollected exit file reads as completed-awaiting-collection and is left for the
   collector. Legacy sync builds (no pgid) keep their immediate dead-pid orphan behaviour.

5. **Claims: no change (reconciliation).** ADR-007 is explicit that the per-item claim
   lease reserves an item only across the pick→dispatch window and that `build.dispatched`
   CONSUMES it; once the item is `building`, that state is the durable exclusion that keeps
   other actors off it. A detached in-flight build therefore "keeps its item claimed" in
   the sense that MATTERS — exclusive ownership — via the `building` state, not by
   retaining an `item.claimed` event. Collection emits the ordinary terminal events, which
   transition the item out of `building` exactly as the sync path does. Implementing a
   second, literal claim lifetime for detached builds would contradict ADR-007 and the
   fold, so phase A does not.

## What phase A deliberately does NOT do (the phase-B boundary)

- **No default flip.** `execution.detachedDispatch` stays `false`. Flipping it is phase B,
  gated on burn-in of the collection path under the flag.
- **No sync-path retirement.** The synchronous await-in-beat path stays as the default and
  the fallback. Retiring it is phase B, and only after the default flip has soaked.
- **No worker-survives-beat-death (the supervisor gap — KNOWN LIMITATION).** The exit file
  is still written by the PARENT beat's completion handler. So phase A delivers the
  happy-path decouple — the beat returns before completion, a later beat collects — but a
  detached worker whose parent beat DIES mid-build leaves no exit file and is orphan-reaped
  honestly by the doctor rather than surviving. True survival across beat restarts requires
  a standalone supervisor/wrapper process that owns output capture, timeout, and the atomic
  completion write. That is a separately-staged slice (a two-phase spawn-protocol change),
  explicitly out of phase A. The default-off flag ensures we never rely on survival we do
  not yet have; enabling the flag exercises the collection path with beats that outlive
  their workers on the happy path.
- **No auth-code granularity on the detached path (KNOWN LIMITATION).** The exit record
  carries an exit code and a usage-JSON pointer, not the provider's semantic failure
  `code`. A detached build that fails is collected through the existing crash/no-commit
  terminal branch rather than the sync path's auth-specific handling. Preserving auth-code
  fidelity for detached builds (either by widening the exit-record contract or persisting a
  normalized `ProviderResult`) is phase B.
- **No new detached lanes.** Planning and target lanes stay synchronous.

## Phase B (core parallelism) — eligibility widened beyond singletons

Phase A detached ONLY single-item engineering groups; a multi-item (co-located batch) group
fell back to the sync await-in-beat path, so a beat picking several disjoint groups still
serialized on the slowest group's wall-clock. Phase B removes the `group.length === 1` gate:

1. **Detach eligibility = flag on + Claude-CLI provider, ANY group size.** A group is still ONE
   worktree/one worker, so a multi-item group runs its members SEQUENTIALLY inside its own
   detached worker (intra-group file-ownership serialization is preserved). Detaching only stops
   disjoint GROUPS from serializing against each other — all Touches-disjoint groups now spawn in
   parallel in one beat pass instead of the beat awaiting each in turn.

2. **Collection reconstructs the whole group from the carrier exit file.** Every member of a
   detached group is `building` with the SAME pgid/branch/worktree, but only the carrier
   (`group[0]`) writes an exit file. `collectDetachedBuilds` therefore buckets pgid-bearing
   building items by worktree, picks the carrier as the member with a readable exit file, and
   emits ONE reconstructed worker (carrier first, companions after) fed through the same Phase-2
   terminal loop. A bucket with no readable carrier exit file yet is deferred WHOLE — a companion
   is never strand-collected alone. A singleton group is the degenerate case, byte-identical to
   phase A.

Prereqs (both must hold before landing): WI-069 survivability supervisor merged, and at least
one clean single-item detached collection observed in the wild. The **sync fallback stays
intact** behind the same default-off `execution.detachedDispatch` flag — flag off is still
byte-for-byte today's behaviour, pinned by the flag-off equivalence test. Still deferred to a
later phase: the default flip, sync-path retirement, worker-survives-beat-death (supervisor
wiring), and auth-code fidelity on the detached path.

## Consequences / what could break

- **A detached worker outliving a dying beat is not yet supported** (supervisor gap above);
  it is orphan-reaped and requeued, which is correct-but-wasteful, not incorrect.
  Detection: a `build.crashed` reason `orphan-detected` on a pgid-bearing build in the
  item trail. Rollback: unset `execution.detachedDispatch` — no build records a pgid, and
  the collection pass finds nothing to drain, so behaviour reverts to today exactly.
- **The reactor does not yet inject the doctor's worktree probe**, so the post-collection-
  limbo reap defaults inert. This is acceptable in phase A (the collection-cycle grace
  still defers young builds and the plain orphan path still crashes dead-no-exit-file
  builds); wiring the worktree probe is a phase-A follow dependency tracked for phase B.
  It lives in the reactor, which is out of this slice's file fence.
- **Flag off = zero behaviour change**, pinned by a flag-off equivalence test: with the
  flag unset the spawn is `detached: false`, the beat awaits in-process, and the collection
  pass has no pgid-bearing building items to act on.

Rollback for the whole slice: revert it — the substrate returns to dormant and the sync
path is untouched.
