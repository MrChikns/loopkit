/**
 * session.test.ts — claim-lease kernel: fold claim state, the one isClaimActive
 * predicate (ttl expiry + dead-man heartbeat), and the session verbs
 * (start / heartbeat / end-releases-all, claim / release).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { makeEvent } from '../src/schema.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import {
  fold, isClaimActive, isSessionActive, planeMode, SESSION_HEARTBEAT_STALE_MS, SessionRecord,
} from '../src/fold.js';
import {
  startSession, heartbeatSession, endSession, claimItems, releaseItems,
  activeSessionClaims, mintSessionId, SESSION_ID_RE,
  readCurrentSession, writeCurrentSession, clearCurrentSession,
} from '../src/session.js';
import { VerbError } from '../src/verbs.js';

const SES = 'ses-testaaaa';
const SES2 = 'ses-otherbbb';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

function queuedItem(id: string, ts: number) {
  return [
    makeEvent('cli', id, 'item.captured', { source: 'cli', text: `${id} work` }, iso(ts)),
    makeEvent('cli', id, 'item.queued', { spec: `${id} spec`, touches: 'src/' }, iso(ts + 1000)),
  ];
}

function sessionsWith(rec: SessionRecord): Map<string, SessionRecord> {
  return new Map([[rec.sessionId, rec]]);
}

// ---------------------------------------------------------------------------
// Fold: session records + claim lifecycle
// ---------------------------------------------------------------------------

test('fold: session.started/heartbeat/ended build the sessions map', () => {
  const result = fold([
    makeEvent('cli', SES, 'session.started', { sessionId: SES, source: 'cli' }, iso(T0)),
    makeEvent('cli', SES, 'session.heartbeat', { sessionId: SES }, iso(T0 + 60_000)),
    makeEvent('cli', SES, 'session.heartbeat', { sessionId: SES }, iso(T0 + 120_000)),
    makeEvent('cli', SES, 'session.ended', { sessionId: SES }, iso(T0 + 180_000)),
  ]);
  const ses = result.sessions.get(SES);
  assert.ok(ses, 'session record exists');
  assert.equal(ses!.startedAt, iso(T0));
  assert.equal(ses!.lastHeartbeatAt, iso(T0 + 120_000), 'last heartbeat wins');
  assert.equal(ses!.endedAt, iso(T0 + 180_000));
  // Session events never materialize a phantom work item.
  assert.equal(result.items.size, 0);
});

test('fold: item.claimed sets claim on a queued item; item.released clears it', () => {
  const events = [
    ...queuedItem('WI-001', T0),
    makeEvent('cli', 'WI-001', 'item.claimed', { sessionId: SES, ttlMinutes: 30 }, iso(T0 + 2000)),
  ];
  let rec = fold(events).items.get('WI-001')!;
  assert.equal(rec.state, 'queued', 'a claim is never a state transition');
  assert.deepEqual(rec.claim, { sessionId: SES, claimedAt: iso(T0 + 2000), ttlMinutes: 30 });

  rec = fold([
    ...events,
    makeEvent('cli', 'WI-001', 'item.released', { reason: 'operator' }, iso(T0 + 3000)),
  ]).items.get('WI-001')!;
  assert.equal(rec.claim, undefined, 'release clears the claim');
  assert.equal(rec.state, 'queued');
});

test('fold: claim is cleared by queued-consuming and terminal transitions', () => {
  const claimedAt = T0 + 2000;
  const baseEvents = [
    ...queuedItem('WI-001', T0),
    makeEvent('cli', 'WI-001', 'item.claimed', { sessionId: SES, ttlMinutes: 30 }, iso(claimedAt)),
  ];
  const consuming = [
    makeEvent('conduct', 'WI-001', 'build.dispatched', { attempt: 1 }, iso(T0 + 3000)),
    makeEvent('cli', 'WI-001', 'item.parked', { reason: 'hold it', parkKind: 'hold' }, iso(T0 + 3000)),
    makeEvent('cli', 'WI-001', 'item.merged', { commit: 'abc123' }, iso(T0 + 3000)),
    makeEvent('cli', 'WI-001', 'item.rejected', { by: 'operator' }, iso(T0 + 3000)),
  ];
  for (const ev of consuming) {
    const rec = fold([...baseEvents, ev]).items.get('WI-001')!;
    assert.equal(rec.claim, undefined, `${ev.type} must clear the claim`);
  }
});

// ---------------------------------------------------------------------------
// isClaimActive — THE lease predicate (ttl + dead-man)
// ---------------------------------------------------------------------------

test('isClaimActive: fresh claim + fresh heartbeat is active', () => {
  const rec = { claim: { sessionId: SES, claimedAt: iso(T0), ttlMinutes: 60 } };
  const sessions = sessionsWith({ sessionId: SES, startedAt: iso(T0), lastHeartbeatAt: iso(T0 + 10 * 60_000) });
  assert.equal(isClaimActive(rec, sessions, T0 + 12 * 60_000), true);
});

test('isClaimActive: expired ttl releases the lease even with a live heartbeat', () => {
  const rec = { claim: { sessionId: SES, claimedAt: iso(T0), ttlMinutes: 30 } };
  const now = T0 + 31 * 60_000;
  const sessions = sessionsWith({ sessionId: SES, startedAt: iso(T0), lastHeartbeatAt: iso(now - 1000) });
  assert.equal(isClaimActive(rec, sessions, now), false);
});

test('isClaimActive: stale heartbeat is the dead-man release', () => {
  const rec = { claim: { sessionId: SES, claimedAt: iso(T0), ttlMinutes: 600 } };
  const lastBeat = T0 + 60_000;
  const sessions = sessionsWith({ sessionId: SES, startedAt: iso(T0), lastHeartbeatAt: iso(lastBeat) });
  // Just inside the staleness bound: still active.
  assert.equal(isClaimActive(rec, sessions, lastBeat + SESSION_HEARTBEAT_STALE_MS), true);
  // Past it: the crashed session no longer wedges the item.
  assert.equal(isClaimActive(rec, sessions, lastBeat + SESSION_HEARTBEAT_STALE_MS + 1000), false);
});

test('isClaimActive: session start counts as the first liveness signal (no heartbeat yet)', () => {
  const rec = { claim: { sessionId: SES, claimedAt: iso(T0), ttlMinutes: 60 } };
  const sessions = sessionsWith({ sessionId: SES, startedAt: iso(T0) });
  assert.equal(isClaimActive(rec, sessions, T0 + 60_000), true);
  assert.equal(isClaimActive(rec, sessions, T0 + SESSION_HEARTBEAT_STALE_MS + 1000), false);
});

test('isClaimActive: ended or unknown session never holds a claim', () => {
  const rec = { claim: { sessionId: SES, claimedAt: iso(T0), ttlMinutes: 60 } };
  const ended = sessionsWith({ sessionId: SES, startedAt: iso(T0), lastHeartbeatAt: iso(T0 + 1000), endedAt: iso(T0 + 2000) });
  assert.equal(isClaimActive(rec, ended, T0 + 3000), false, 'ended session');
  assert.equal(isClaimActive(rec, new Map(), T0 + 3000), false, 'unknown session');
  assert.equal(isClaimActive({ claim: undefined }, ended, T0 + 3000), false, 'no claim');
});

// ---------------------------------------------------------------------------
// isSessionActive + planeMode — THE derived attended/away dual-mode
// ---------------------------------------------------------------------------

test('isSessionActive: live iff started, not ended, and heartbeat fresh within the dead-man bound', () => {
  const lastBeat = T0 + 60_000;
  const live = { sessionId: SES, startedAt: iso(T0), lastHeartbeatAt: iso(lastBeat) };
  assert.equal(isSessionActive(live, lastBeat + SESSION_HEARTBEAT_STALE_MS), true, 'just inside the bound');
  assert.equal(isSessionActive(live, lastBeat + SESSION_HEARTBEAT_STALE_MS + 1000), false, 'past the bound (dead-man)');
  assert.equal(isSessionActive({ startedAt: iso(T0), endedAt: iso(T0 + 2000) }, T0 + 3000), false, 'ended');
  assert.equal(isSessionActive({ startedAt: iso(T0) }, T0 + 60_000), true, 'start is the first signal');
  assert.equal(isSessionActive(undefined, T0), false, 'absent');
});

test('planeMode: attended iff any session is live, else away', () => {
  const nowMs = T0 + 10 * 60_000;
  assert.equal(planeMode(new Map(), nowMs), 'away', 'no sessions ⇒ away');
  const live = sessionsWith({ sessionId: SES, startedAt: iso(T0), lastHeartbeatAt: iso(nowMs - 60_000) });
  assert.equal(planeMode(live, nowMs), 'attended', 'one live session ⇒ attended');
  const ended = sessionsWith({ sessionId: SES, startedAt: iso(T0), lastHeartbeatAt: iso(T0 + 1000), endedAt: iso(T0 + 2000) });
  assert.equal(planeMode(ended, nowMs), 'away', 'only an ended session ⇒ away');
  // A dead (stale) session must not keep the plane reading attended.
  const stale = sessionsWith({ sessionId: SES, startedAt: iso(T0), lastHeartbeatAt: iso(T0) });
  assert.equal(planeMode(stale, T0 + SESSION_HEARTBEAT_STALE_MS + 1000), 'away', 'stale heartbeat ⇒ away (dead-man)');
  // Mixed: one dead + one live ⇒ attended (any-live wins).
  const mixed = new Map([
    ['ses-deadxxxx', { sessionId: 'ses-deadxxxx', startedAt: iso(T0), lastHeartbeatAt: iso(T0) }],
    [SES2, { sessionId: SES2, startedAt: iso(nowMs - 30_000) }],
  ]);
  assert.equal(planeMode(mixed, nowMs), 'attended', 'any live session ⇒ attended');
});

// ---------------------------------------------------------------------------
// Verbs: start / heartbeat / claim / release / end
// ---------------------------------------------------------------------------

test('session verbs: claim leases queued items, skips foreign active claims, claims over expired ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ses-verbs-'));
  try {
    await appendEvents(dir, [
      ...queuedItem('WI-001', T0),
      ...queuedItem('WI-002', T0 + 10_000),
      makeEvent('cli', 'WI-003', 'item.captured', { source: 'cli', text: 'merged already' }, iso(T0 + 20_000)),
      makeEvent('cli', 'WI-003', 'item.merged', { commit: 'aaa' }, iso(T0 + 21_000)),
    ]);
    await startSession(dir, { sessionId: SES });
    await startSession(dir, { sessionId: SES2 });

    // The other session claims WI-002 (fresh — its start is the liveness signal).
    await claimItems(dir, { sessionId: SES2, ids: ['WI-002'], ttlMinutes: 60 });

    // all-queued: gets WI-001, skips the foreign-claimed WI-002; the merged WI-003 is not queued.
    const r1 = await claimItems(dir, { sessionId: SES, allQueued: true, ttlMinutes: 60 });
    assert.deepEqual(r1.claimed, ['WI-001']);
    assert.equal(r1.skipped.length, 1);
    assert.equal(r1.skipped[0].id, 'WI-002');
    assert.match(r1.skipped[0].reason, /claimed by ses-otherbbb/);

    // Explicit claim of a non-queued item is skipped with a reason; unknown id throws.
    const r2 = await claimItems(dir, { sessionId: SES, ids: ['WI-003'] });
    assert.deepEqual(r2.claimed, []);
    assert.match(r2.skipped[0].reason, /not queued/);
    await assert.rejects(() => claimItems(dir, { sessionId: SES, ids: ['WI-999'] }), VerbError);

    // Once the foreign lease EXPIRES (nowMs far in the future), the claim goes through —
    // but a far-future nowMs also dead-mans OUR session, so this proves expiry-claim-over
    // uses the injected clock for the foreign lease check.
    const farFuture = Date.now() + 2 * 60 * 60_000;
    await heartbeatSession(dir, SES); // fresh real heartbeat (still stale at farFuture — checked below)
    const r3 = await claimItems(dir, { sessionId: SES, ids: ['WI-002'], nowMs: farFuture });
    assert.deepEqual(r3.claimed, ['WI-002'], 'expired foreign lease can be claimed over');

    // release returns the item to the shared queue.
    const rel = await releaseItems(dir, { ids: ['WI-002'], reason: 'give it back' });
    assert.deepEqual(rel.released, ['WI-002']);
    const folded = fold(await loadAllEvents(dir));
    assert.equal(folded.items.get('WI-002')!.claim, undefined);
    // release of an unclaimed item is a reported no-op.
    const rel2 = await releaseItems(dir, { ids: ['WI-002'] });
    assert.deepEqual(rel2.released, []);
    assert.match(rel2.skipped[0].reason, /not claimed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session verbs: end releases all of the session claims in the same append', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ses-end-'));
  try {
    await appendEvents(dir, [...queuedItem('WI-001', T0), ...queuedItem('WI-002', T0 + 10_000)]);
    await startSession(dir, { sessionId: SES });
    await claimItems(dir, { sessionId: SES, allQueued: true });

    let folded = fold(await loadAllEvents(dir));
    assert.equal(activeSessionClaims(folded, SES, Date.now()).length, 2);

    const { released } = await endSession(dir, SES);
    assert.deepEqual(released.sort(), ['WI-001', 'WI-002']);

    folded = fold(await loadAllEvents(dir));
    assert.equal(folded.sessions.get(SES)!.endedAt !== undefined, true);
    assert.equal(folded.items.get('WI-001')!.claim, undefined);
    assert.equal(folded.items.get('WI-002')!.claim, undefined);
    assert.equal(activeSessionClaims(folded, SES, Date.now()).length, 0);

    // Claiming into an ended session is refused.
    await assert.rejects(() => claimItems(dir, { sessionId: SES, ids: ['WI-001'] }), VerbError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session verbs: claim requires a started session; heartbeat folds in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ses-hb-'));
  try {
    await appendEvents(dir, queuedItem('WI-001', T0));
    await assert.rejects(() => claimItems(dir, { sessionId: SES, ids: ['WI-001'] }), VerbError);

    await startSession(dir, { sessionId: SES });
    await heartbeatSession(dir, SES);
    const folded = fold(await loadAllEvents(dir));
    assert.ok(folded.sessions.get(SES)!.lastHeartbeatAt, 'heartbeat recorded');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session id + current-session pointer round-trip', () => {
  const id = mintSessionId();
  assert.match(id, SESSION_ID_RE);
  const runDir = mkdtempSync(join(tmpdir(), 'ses-ptr-'));
  try {
    assert.equal(readCurrentSession(runDir), undefined);
    writeCurrentSession(runDir, id);
    assert.equal(readCurrentSession(runDir), id);
    clearCurrentSession(runDir);
    assert.equal(readCurrentSession(runDir), undefined);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
