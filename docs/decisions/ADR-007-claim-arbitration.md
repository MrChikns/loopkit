# ADR-007 — Per-item claim arbitration replaces the autonomy operating mode

**Status:** active

## Context

An attended operator session drains queued work *fast and in parallel* — it spawns
several workers at once from a live CLI session, which is much quicker than the
background dispatch beat's cadence. The whole value of the attended path is that
speed. But a live dispatch beat and a live attended session both pick from the same
queue, so they can race for the same item: the beat reads an item as queued and
unclaimed, and in the window before it spawns, the operator's session claims and
starts building the same item. Two workers on one item is duplicated work at best
and a merge conflict at worst.

The original workaround made `LOOPKIT_AUTONOMY` an **operating mode**: an operator
who wanted to drain attended flipped the beats *off* entirely (so nothing could race
them), drained, then flipped them back on. That global mutable switch dragged a set
of manual rituals behind it — hold-parking items an operator had "taken" so a
mid-beat pick couldn't grab them, and pausing the whole plane for a manual merge so
a beat wouldn't advance the branch underneath it. A mode is a coarse instrument: it
stops *all* background progress to make *one* item safe, and every ritual around it
is a chance to leave the switch in the wrong position.

## Decision

Arbitration moves from a global mode to a **per-item claim lease**, and dispatch
yields to claims — never the reverse, so the attended fast path is never slowed by
the presence of live beats.

- **One arbitration mechanism, no mode check in the pick logic.** An attended
  session and the dispatch beat both reserve an item the same way: by appending an
  `item.claimed` event under the ledger lock before they build it. Whoever's claim is
  active owns the item; the other defers. There is no branch in the picker that asks
  "are we attended or away?" — it asks only "does this item carry an active claim I
  don't own?"

- **The claim lease already existed for the read side** (`item.claimed` /
  `item.released` / `session.*`, the pure fold's per-item `claim`, and the ONE
  `isClaimActive` predicate — ttl-unexpired AND the claiming session's dead-man
  heartbeat still fresh). The dispatch picker already *filtered out* items another
  live session claims. This ADR closes the two remaining gaps that make the
  mechanism a complete replacement for the mode:

  1. **Claim-before-pick in dispatch.** The picker's filter reads the fold at the
     top of the beat; an attended session can claim an item in the window between
     that read and the beat spawning its worker. So, before it sets up any worktree,
     dispatch re-reads and re-folds the ledger *under the ledger lock*, skips any item
     that now carries an active claim it doesn't own, and appends its *own*
     `item.claimed` for the items it is about to build — in that same locked append.
     Only then does it spawn. This closes the read-to-spawn race with the identical
     append path an attended coordinator uses.

  2. **Dispatch claims under a live pseudo-session.** `isClaimActive` reads a claim
     as active only when its claiming session is itself alive. So a claim from a
     synthetic identity that is *not* a live session would read inactive immediately
     and reserve nothing. Dispatch therefore mints a per-run session identity and, in
     the same locked pre-build append, emits `session.started` + `session.heartbeat`
     for it — dispatch becomes just another session in the one mechanism. A per-run
     (not permanent-shared) identity keeps runs from conflating and lets a crashed
     dispatch's claims expire cleanly by the dead-man rule.

- **`build.dispatched` consumes the claim.** The fold already clears an item's claim
  on every queued-consuming transition, `build.dispatched` among them. So the claim
  is a *reservation for the pick window only*; once the item is building, the build
  itself is the state that keeps other actors off it, and the lease has done its job.

- **Stale claims are reaped, never silently dropped.** A claim whose session died or
  whose ttl expired already reads inactive (so it never blocks a pick — expiry is
  computed, never mutated). For a clean audit trail and fold hygiene, the doctor
  additionally appends an explicit `item.released` (naming the reaped session and the
  reason) for a claim that reads inactive and is older than a TTL-derived age. The
  reap re-reads and re-verifies under the ledger lock that the *same* inactive claim
  is still present before releasing, so it can never erase a newer concurrent claim.
  The default reap age is generous (derived from the build-timeout envelope) — a live
  operator whose heartbeat merely lagged is never reaped out from under a claim it is
  actively working.

## What this retires

- **The hold-park shielding ritual.** An operator no longer hold-parks "taken" items
  to hide them from a mid-beat pick; the claim *is* the shield, and it is released
  implicitly the moment the work transitions (dispatch/park/merge/…) or explicitly on
  session end.

- **The plane-pause-for-merge ritual.** Merges no longer need the whole plane
  quiesced; claim arbitration keeps two actors off one item without stopping the
  background beats globally.

## Kill-switch demotion (explicit)

`LOOPKIT_AUTONOMY` **keeps its kill-switch semantics unchanged**: `off` = both beats
no-op entirely; `on` = beats run. It is no longer an *operating mode* an operator
toggles to drain attended safely — claim arbitration makes attended and away work
safe *concurrently*, so the switch's only remaining job is the durable emergency
pause it always documented itself as.

**This slice changes ZERO live behavior while the switch is off.** With
`LOOPKIT_AUTONOMY=off`, `runDispatch` returns its no-op before any of the claim
machinery runs, and the reactor's doctor reap is inert with no beats writing claims.
The mechanism lands dormant; an operator re-arms the plane (`on`) as a later,
deliberate choice, at which point the claim path is what keeps a live beat safe next
to a live attended session — no mode flip required.

## Consequences / what could break

- A claim from a genuinely-live operator whose heartbeat lagged past the dead-man
  bound reads inactive and could be picked by a beat. This is the *designed* trade —
  a generous reap age plus the dead-man bound (three missed heartbeats) makes it
  improbable, and dispatch yielding to any *active* claim means the common case is
  never a contest. Detection: a `build.dispatched` on an item that also carried a
  recent operator `item.claimed` in the same window shows up in the item's own event
  trail. Rollback: revert this slice — the picker's existing `isClaimActive` filter
  and `LOOPKIT_AUTONOMY` as a coarse mode remain as they were.
