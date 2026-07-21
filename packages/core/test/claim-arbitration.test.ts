/**
 * claim-arbitration.test.ts — ADR-007 claim arbitration: the dispatch claim-before-pick
 * pure decision (decideClaimArbitration), the doctor's stale-claim reap
 * (reapStaleClaims), and focused fold assertions on claim set/clear lifecycle that this
 * slice depends on (isClaimActive, the queued-consuming/terminal claim-clear guarantee).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeEvent } from '../src/schema.js';
import { fold, isClaimActive, SessionRecord } from '../src/fold.js';
import { decideClaimArbitration } from '../src/beats/dispatch.js';
import { reapStaleClaims } from '../src/doctor.js';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

/** Claim/build staleness window used by the arbitration decision (buildTimeout + 5min-ish). */
const BUILD_STALE_MS = 50 * 60_000;

const OP_SESSION = 'ses-attend01';   // an attended operator session
const DISPATCH_SESSION = 'ses-dispat1';   // a dispatch pseudo-session

function queuedItem(id: string, ts: number) {
  return [
    makeEvent('cli', id, 'item.captured', { source: 'cli', text: `${id} work` }, iso(ts)),
    makeEvent('cli', id, 'item.queued', { spec: `${id} spec`, touches: 'src/' }, iso(ts + 1000)),
  ];
}

function sessionsMap(...recs: SessionRecord[]): Map<string, SessionRecord> {
  return new Map(recs.map(r => [r.sessionId, r]));
}

function liveSession(sessionId: string, startedAt: number, lastHeartbeatAt?: number): SessionRecord {
  return { sessionId, startedAt: iso(startedAt), lastHeartbeatAt: lastHeartbeatAt !== undefined ? iso(lastHeartbeatAt) : undefined };
}

function endedSession(sessionId: string, startedAt: number, endedAt: number): SessionRecord {
  return { sessionId, startedAt: iso(startedAt), endedAt: iso(endedAt) };
}

// ---------------------------------------------------------------------------
// decideClaimArbitration (dispatch claim-before-pick pure decision)
// ---------------------------------------------------------------------------

test('decideClaimArbitration: foreign active claim yields', () => {
  const events = [
    ...queuedItem('WI-001', T0),
    makeEvent('cli', 'WI-001', 'item.claimed', { sessionId: OP_SESSION, ttlMinutes: 60 }, iso(T0 + 2000)),
  ];
  const nowMs = T0 + 3000;
  const sessions = sessionsMap(liveSession(OP_SESSION, T0, T0 + 2500));
  const result = fold(events);
  const decisions = decideClaimArbitration(['WI-001'], { ...result, sessions }, DISPATCH_SESSION, nowMs, BUILD_STALE_MS);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]!.keep, false, 'a live foreign claim wins the race');
  assert.equal(decisions[0]!.foreignSessionId, OP_SESSION);
});

test('decideClaimArbitration: dispatch keeps an item it already claimed itself (renewal)', () => {
  const events = [
    ...queuedItem('WI-002', T0),
    makeEvent('dispatch', 'WI-002', 'item.claimed', { sessionId: DISPATCH_SESSION, ttlMinutes: 45 }, iso(T0 + 2000)),
  ];
  const nowMs = T0 + 3000;
  const sessions = sessionsMap(liveSession(DISPATCH_SESSION, T0, T0 + 2500));
  const result = fold(events);
  const decisions = decideClaimArbitration(['WI-002'], { ...result, sessions }, DISPATCH_SESSION, nowMs, BUILD_STALE_MS);
  assert.equal(decisions[0]!.keep, true, 'a claim by dispatch\'s OWN session id is never foreign');
  assert.equal(decisions[0]!.foreignSessionId, undefined);
});

test('decideClaimArbitration: an inactive (expired ttl) foreign claim is kept, not yielded', () => {
  const events = [
    ...queuedItem('WI-003', T0),
    makeEvent('cli', 'WI-003', 'item.claimed', { sessionId: OP_SESSION, ttlMinutes: 1 }, iso(T0 + 2000)),
  ];
  const nowMs = T0 + 2000 + 5 * 60_000;   // 5 minutes later — well past the 1-minute ttl
  const sessions = sessionsMap(liveSession(OP_SESSION, T0, nowMs - 1000));   // heartbeat still fresh, but ttl expired
  const result = fold(events);
  const decisions = decideClaimArbitration(['WI-003'], { ...result, sessions }, DISPATCH_SESSION, nowMs, BUILD_STALE_MS);
  assert.equal(decisions[0]!.keep, true, 'an expired-ttl claim reads inactive — dispatch may take the item');
});

test('decideClaimArbitration: an inactive (dead-man / ended session) foreign claim is kept', () => {
  const events = [
    ...queuedItem('WI-004', T0),
    makeEvent('cli', 'WI-004', 'item.claimed', { sessionId: OP_SESSION, ttlMinutes: 60 }, iso(T0 + 2000)),
  ];
  const nowMs = T0 + 3000;
  const sessions = sessionsMap(endedSession(OP_SESSION, T0, T0 + 2500));
  const result = fold(events);
  const decisions = decideClaimArbitration(['WI-004'], { ...result, sessions }, DISPATCH_SESSION, nowMs, BUILD_STALE_MS);
  assert.equal(decisions[0]!.keep, true, 'an ended session\'s claim is inactive — dispatch may take the item');
});

test('decideClaimArbitration: an unclaimed item is kept', () => {
  const events = queuedItem('WI-005', T0);
  const result = fold(events);
  const decisions = decideClaimArbitration(['WI-005'], result, DISPATCH_SESSION, T0 + 3000, BUILD_STALE_MS);
  assert.equal(decisions[0]!.keep, true);
});

test('decideClaimArbitration: a RECENT foreign build.dispatched (no claim) yields — WI-074', () => {
  // A foreign actor (attended fast-drain session, or a parallel beat) transitioned the item to
  // 'building' in the read-to-arbitrate window. build.dispatched consumed any claim, so there is
  // NO active claim to yield to — the in-flight-build check is what closes the double-build race.
  const dispatchedAt = T0 + 2000;
  const events = [
    ...queuedItem('WI-006', T0),
    makeEvent('cli', 'WI-006', 'build.dispatched', { attempt: 1 }, iso(dispatchedAt)),
  ];
  const result = fold(events);
  assert.equal(result.items.get('WI-006')!.state, 'building');
  assert.equal(result.items.get('WI-006')!.claim, undefined, 'build.dispatched consumed the claim');
  const nowMs = dispatchedAt + 30_000;   // 30s later — well within the stale window
  const decisions = decideClaimArbitration(['WI-006'], result, DISPATCH_SESSION, nowMs, BUILD_STALE_MS);
  assert.equal(decisions[0]!.keep, false, 'a recent foreign in-flight build blocks takeover');
  assert.equal(decisions[0]!.foreignBuild, true);
  assert.equal(decisions[0]!.foreignSessionId, undefined, 'no session id — it is a build, not a claim');
});

test('decideClaimArbitration: a STALE foreign build.dispatched does NOT block takeover — WI-074', () => {
  // An orphaned building record older than the stale window is the doctor's to reap; it must not
  // permanently wedge the item out of dispatch's reach.
  const dispatchedAt = T0 + 2000;
  const events = [
    ...queuedItem('WI-007', T0),
    makeEvent('cli', 'WI-007', 'build.dispatched', { attempt: 1 }, iso(dispatchedAt)),
  ];
  const result = fold(events);
  const nowMs = dispatchedAt + BUILD_STALE_MS + 60_000;   // past the stale window
  const decisions = decideClaimArbitration(['WI-007'], result, DISPATCH_SESSION, nowMs, BUILD_STALE_MS);
  assert.equal(decisions[0]!.keep, true, 'a stale/orphan building record is reapable, never a permanent block');
});

// ---------------------------------------------------------------------------
// reapStaleClaims (doctor stale-claim reap)
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60_000;

test('reapStaleClaims: an inactive claim older than the reap age is released, naming the session', () => {
  const claimedAt = T0;
  const events = [
    ...queuedItem('WI-010', T0 - 10_000),
    makeEvent('cli', 'WI-010', 'item.claimed', { sessionId: OP_SESSION, ttlMinutes: 60 }, iso(claimedAt)),
  ];
  // Session ended shortly after claiming — the claim has read inactive ever since.
  const sessions = sessionsMap(endedSession(OP_SESSION, T0 - 10_000, T0 + 1000));
  const result = fold(events);
  const nowMs = claimedAt + 3 * HOUR_MS;   // well past the 2h default reap age
  const reapEvents = reapStaleClaims(result, sessions, nowMs);
  assert.equal(reapEvents.length, 1);
  assert.equal(reapEvents[0]!.type, 'item.released');
  assert.equal(reapEvents[0]!.item, 'WI-010');
  const data = reapEvents[0]!.data as { reason?: string; sessionId?: string };
  assert.equal(data.sessionId, OP_SESSION);
  assert.match(data.reason ?? '', new RegExp(OP_SESSION));
  assert.match(data.reason ?? '', /stale claim reaped/);
});

test('reapStaleClaims: a FRESH inactive claim (younger than the reap age) is NOT reaped', () => {
  const claimedAt = T0;
  const events = [
    ...queuedItem('WI-011', T0 - 10_000),
    makeEvent('cli', 'WI-011', 'item.claimed', { sessionId: OP_SESSION, ttlMinutes: 1 }, iso(claimedAt)),
  ];
  // ttl expired 1 minute after claiming, so at nowMs the claim reads inactive — but nowMs
  // itself is only minutes after claimedAt, nowhere near the default 2h reap age.
  const sessions = sessionsMap(liveSession(OP_SESSION, T0 - 10_000, T0 + 30_000));
  const result = fold(events);
  const nowMs = claimedAt + 10 * 60_000;   // 10 minutes later — inactive (ttl expired) but fresh
  const reapEvents = reapStaleClaims(result, sessions, nowMs);
  assert.equal(reapEvents.length, 0, 'a merely-lagged/just-expired claim is left alone');
});

test('reapStaleClaims: an ACTIVE claim (live session, unexpired ttl) is never reaped, no matter its age', () => {
  const claimedAt = T0;
  const events = [
    ...queuedItem('WI-012', T0 - 10_000),
    makeEvent('cli', 'WI-012', 'item.claimed', { sessionId: OP_SESSION, ttlMinutes: 24 * 60 }, iso(claimedAt)),
  ];
  const nowMs = claimedAt + 5 * HOUR_MS;   // past the default reap age, but ttl is 24h and heartbeat is fresh
  const sessions = sessionsMap(liveSession(OP_SESSION, T0 - 10_000, nowMs - 1000));
  const result = fold(events);
  const reapEvents = reapStaleClaims(result, sessions, nowMs);
  assert.equal(reapEvents.length, 0, 'isClaimActive gates the reap — an active claim is never touched');
});

test('reapStaleClaims: re-folding after a FRESH item.claimed protects the new claim (no-silent-erase)', () => {
  // The exact race this hardening closes: at the TOP of stepDoctor, an item's claim
  // (sesA) reads stale-inactive and is proposed for reap. Before the reap append lands,
  // an attended operator session claims the SAME item fresh (sesB) — e.g. a build.dispatched
  // never happened, sesA just died, and a human picked the item up by hand in the window
  // between the doctor's fold and its write. Re-folding immediately before the reap append
  // (as stepDoctor now does under the ledger lock) must see the item as actively claimed by
  // sesB and propose ZERO releases — proving the fresh claim is never erased.
  const claimedAt = T0;
  const staleEvents = [
    ...queuedItem('WI-030', T0 - 10_000),
    makeEvent('cli', 'WI-030', 'item.claimed', { sessionId: OP_SESSION, ttlMinutes: 60 }, iso(claimedAt)),
  ];
  // sesA (the original claimant) ended shortly after claiming — its claim has read
  // inactive ever since, same shape as the "reaped" test above.
  const staleSessions = sessionsMap(endedSession(OP_SESSION, T0 - 10_000, claimedAt + 1000));
  const nowMs = claimedAt + 3 * HOUR_MS;   // well past the default reap age

  // Sanity check: on the STALE fold alone (the doctor's top-of-step snapshot), this claim
  // IS reapable — establishing that the race is real, not vacuously guarded away.
  const staleResult = fold(staleEvents);
  const staleReap = reapStaleClaims(staleResult, staleSessions, nowMs);
  assert.equal(staleReap.length, 1, 'precondition: the stale claim alone reads reapable');

  // Now the race: a fresh operator session (sesB) claims the SAME item AFTER the stale
  // claim, landing between the doctor's fold and its under-lock re-verify.
  const FRESH_SESSION = 'ses-attend02';
  const freshClaimAt = claimedAt + 2.5 * HOUR_MS;   // still well before nowMs
  const freshEvents = [
    ...staleEvents,
    makeEvent('cli', 'WI-030', 'item.claimed', { sessionId: FRESH_SESSION, ttlMinutes: 60 }, iso(freshClaimAt)),
  ];
  const freshSessions = sessionsMap(
    endedSession(OP_SESSION, T0 - 10_000, claimedAt + 1000),
    liveSession(FRESH_SESSION, freshClaimAt, nowMs - 1000),
  );

  // This is what stepDoctor's under-lock withLock(tx => { fold(tx.loadAll()); reapStaleClaims(...) })
  // computes immediately before appending — the fresh re-fold.
  const freshResult = fold(freshEvents);
  const freshReap = reapStaleClaims(freshResult, freshSessions, nowMs);
  assert.equal(freshReap.length, 0, 'the fresh claim (sesB) reads active on re-fold — never released');

  const rec = freshResult.items.get('WI-030')!;
  assert.equal(rec.claim?.sessionId, FRESH_SESSION, 'the item now carries the fresh claim, not the stale one');
});

test('reapStaleClaims: a terminal-state item never carries a live claim — reap is a no-op', () => {
  const claimedAt = T0;
  const events = [
    ...queuedItem('WI-013', T0 - 10_000),
    makeEvent('cli', 'WI-013', 'item.claimed', { sessionId: OP_SESSION, ttlMinutes: 60 }, iso(claimedAt)),
    makeEvent('dispatch', 'WI-013', 'build.dispatched', { attempt: 1 }, iso(claimedAt + 1000)),
    makeEvent('dispatch', 'WI-013', 'item.merged', { commit: 'abc123' }, iso(claimedAt + 2000)),
  ];
  const sessions = sessionsMap(endedSession(OP_SESSION, T0 - 10_000, claimedAt + 1500));
  const result = fold(events);
  const rec = result.items.get('WI-013')!;
  assert.equal(rec.state, 'merged');
  assert.equal(rec.claim, undefined, 'the fold already cleared the claim on the terminal transition');
  const nowMs = claimedAt + 3 * HOUR_MS;
  const reapEvents = reapStaleClaims(result, sessions, nowMs);
  assert.equal(reapEvents.length, 0, 'no live claim on a terminal item — nothing to release');
});

// ---------------------------------------------------------------------------
// Fold: claim set/clear lifecycle this slice depends on (isClaimActive consumes it)
// ---------------------------------------------------------------------------

test('fold + isClaimActive: item.claimed sets an active claim; build.dispatched clears it', () => {
  const events = [
    ...queuedItem('WI-020', T0),
    makeEvent('cli', 'WI-020', 'item.claimed', { sessionId: OP_SESSION, ttlMinutes: 60 }, iso(T0 + 2000)),
  ];
  const sessions = sessionsMap(liveSession(OP_SESSION, T0, T0 + 2500));
  let result = fold(events);
  let rec = result.items.get('WI-020')!;
  assert.ok(rec.claim, 'claim set after item.claimed');
  assert.equal(isClaimActive(rec, sessions, T0 + 3000), true);

  result = fold([...events, makeEvent('dispatch', 'WI-020', 'build.dispatched', { attempt: 1 }, iso(T0 + 3000))]);
  rec = result.items.get('WI-020')!;
  assert.equal(rec.claim, undefined, 'build.dispatched (queued-consuming) clears the claim');
  assert.equal(isClaimActive(rec, sessions, T0 + 4000), false);
});

test('fold + isClaimActive: item.merged and item.parked both clear a live claim', () => {
  const base = [
    ...queuedItem('WI-021', T0),
    makeEvent('cli', 'WI-021', 'item.claimed', { sessionId: OP_SESSION, ttlMinutes: 60 }, iso(T0 + 2000)),
  ];
  const sessions = sessionsMap(liveSession(OP_SESSION, T0, T0 + 2500));

  const mergedResult = fold([...base, makeEvent('dispatch', 'WI-021', 'item.merged', { commit: 'abc' }, iso(T0 + 3000))]);
  const mergedRec = mergedResult.items.get('WI-021')!;
  assert.equal(mergedRec.claim, undefined);
  assert.equal(isClaimActive(mergedRec, sessions, T0 + 4000), false);

  const parkedResult = fold([...base, makeEvent('cli', 'WI-021', 'item.parked', { reason: 'test', parkKind: 'ops' }, iso(T0 + 3000))]);
  const parkedRec = parkedResult.items.get('WI-021')!;
  assert.equal(parkedRec.claim, undefined);
  assert.equal(isClaimActive(parkedRec, sessions, T0 + 4000), false);
});
