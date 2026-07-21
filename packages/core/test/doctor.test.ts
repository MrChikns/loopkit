/**
 * doctor.test.ts — Doctor orphan/breaker tests: detects builds whose worker died without
 * a terminal ledger event (dead-pid orphans, stuck-routed items, stalled-but-alive builds),
 * requeues or parks at the breaker limit, and covers the detached-worker exit-file/worktree
 * probes that distinguish "still collectable" from "genuinely orphaned" without racing the
 * collector. Also covers detectLedgerRegression, the ledger-truncation guard.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold, FoldResult, ItemRecord, TargetsProjection } from '../src/fold.js';
import { runDoctor, defaultPidProbe, PidProbe, ExitFileProbe, WorktreeProbe, detectStall, DEFAULT_COLLECTION_CYCLE_MS, DEFAULT_LIMBO_MAX_MS, detectLedgerRegression, detectDistDrift } from '../src/doctor.js';
import { makeEvent, LedgerEvent } from '../src/schema.js';

// A probe that always considers the pid dead
const deadProbe: PidProbe = () => false;
// A probe that always considers the pid alive
const aliveProbe: PidProbe = () => true;
// Exit-file probes: an exit sentinel is present (collectable) / absent.
const exitPresent: ExitFileProbe = () => true;
const exitAbsent: ExitFileProbe = () => false;
// Worktree probes: present (default/collectable) / gone (post-collection-limbo candidate).
const worktreePresent: WorktreeProbe = () => true;
const worktreeGone: WorktreeProbe = () => false;

/** A detached build.dispatched carrying a pgid and a dispatch timestamp. */
function buildDetachedEvents(item: string, pgid: number, dispatchedAt: string): LedgerEvent[] {
  return [
    makeEvent('operator', item, 'item.captured', { source: 'cli', text: 'test' }, '2026-01-01T00:00:00Z'),
    makeEvent('conductor', item, 'item.queued', { spec: 'spec' }, '2026-01-01T00:01:00Z'),
    makeEvent('dispatch', item, 'build.dispatched', { attempt: 1, pgid }, dispatchedAt),
  ];
}

function buildBldEvents(item: string, pid: number, extra?: LedgerEvent[]): LedgerEvent[] {
  return [
    makeEvent('operator', item, 'item.captured', { source: 'cli', text: 'test' }, '2026-01-01T00:00:00Z'),
    makeEvent('conductor', item, 'item.queued', { spec: 'spec' }, '2026-01-01T00:01:00Z'),
    makeEvent('dispatch', item, 'build.dispatched', { attempt: 1, pid }, '2026-01-01T00:02:00Z'),
    ...(extra ?? []),
  ];
}

test('doctor: no orphans when no building items', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-001', 'item.captured', { source: 'cli', text: 'test' }),
    makeEvent('conductor', 'WI-001', 'item.queued', { spec: '' }),
  ];
  const result = fold(events);
  const dr = runDoctor(result, deadProbe);
  assert.equal(dr.orphans.length, 0);
  assert.equal(dr.actions.length, 0);
});

test('doctor: no orphan when pid is alive', () => {
  const events = buildBldEvents('WI-001', 12345);
  const result = fold(events);
  const dr = runDoctor(result, aliveProbe);
  assert.equal(dr.orphans.length, 0);
});

test('doctor: orphan detected when pid is dead', () => {
  const events = buildBldEvents('WI-002', 99999);
  const result = fold(events);
  const dr = runDoctor(result, deadProbe);
  assert.equal(dr.orphans.length, 1);
  assert.equal(dr.orphans[0].id, 'WI-002');
  assert.equal(dr.actions.length, 1);
  assert.equal(dr.actions[0].type, 'requeue');
  assert.equal(dr.actions[0].item, 'WI-002');
});

test('doctor: orphan requeue action includes crashed + queued events', () => {
  const events = buildBldEvents('WI-003', 1);
  const result = fold(events);
  const dr = runDoctor(result, deadProbe, { breakerN: 3 });
  const action = dr.actions[0];
  assert.equal(action.type, 'requeue');
  assert.equal(action.events.length, 2);
  assert.equal(action.events[0].type, 'build.crashed');
  assert.equal(action.events[1].type, 'item.queued');
});

test('doctor: breaker trips at N attempts', () => {
  // Simulate 3 previous builds (attempts exhausted)
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-004', 'item.captured', { source: 'cli', text: 'test' }, '2026-01-01T00:00:00Z'),
    makeEvent('conductor', 'WI-004', 'item.queued', { spec: '' }, '2026-01-01T00:01:00Z'),
    // Attempt 1 — crashed
    makeEvent('dispatch', 'WI-004', 'build.dispatched', { attempt: 1, pid: 1 }, '2026-01-01T00:02:00Z'),
    makeEvent('doctor', 'WI-004', 'build.crashed', { reason: 'orphan' }, '2026-01-01T00:10:00Z'),
    // Attempt 2 — crashed
    makeEvent('dispatch', 'WI-004', 'build.dispatched', { attempt: 2, pid: 2 }, '2026-01-01T00:11:00Z'),
    makeEvent('doctor', 'WI-004', 'build.crashed', { reason: 'orphan' }, '2026-01-01T00:20:00Z'),
    // Attempt 3 — currently building with dead pid
    makeEvent('dispatch', 'WI-004', 'build.dispatched', { attempt: 3, pid: 999 }, '2026-01-01T00:21:00Z'),
  ];
  const result = fold(events);
  const item = result.items.get('WI-004');
  assert.ok(item);
  assert.equal(item.state, 'building');
  assert.equal(item.attempts, 3);

  const dr = runDoctor(result, deadProbe, { breakerN: 3 });
  assert.equal(dr.actions.length, 1);
  assert.equal(dr.actions[0].type, 'park-breaker');
  assert.equal(dr.actions[0].events.length, 2);
  assert.equal(dr.actions[0].events[0].type, 'build.crashed');
  assert.equal(dr.actions[0].events[1].type, 'item.parked');
});

// ---------------------------------------------------------------------------
// Thrashing detector: 3 consecutive build.crashed events with an identical error
// fingerprint (deterministic hash of stderrTail) park 'ops' as a distinct trigger,
// separate from the plain breakerN retry-count cap.
// ---------------------------------------------------------------------------

test('doctor: 3 consecutive dead-pid orphan reaps with the same (empty) stderr signature thrash-park, not breaker', () => {
  // Simulates the ONLY realistic source of a "same cause every time" orphan today: a worker
  // that dies before writing any output, 3 dispatches in a row. Each iteration lets the real
  // doctor generate its own build.crashed (not hand-authored), matching what actually reaches
  // the ledger. breakerN is set well above 3 so a plain breaker trip could not explain the park.
  let events: LedgerEvent[] = [
    makeEvent('operator', 'WI-500', 'item.captured', { source: 'cli', text: 'test' }, '2026-01-01T00:00:00Z'),
    makeEvent('conductor', 'WI-500', 'item.queued', { spec: '' }, '2026-01-01T00:01:00Z'),
  ];
  for (let attempt = 1; attempt <= 3; attempt++) {
    events = [
      ...events,
      makeEvent('dispatch', 'WI-500', 'build.dispatched', { attempt, pid: attempt }, `2026-01-01T00:${String(attempt).padStart(2, '0')}:00Z`),
    ];
    const dr = runDoctor(fold(events), deadProbe, { breakerN: 10 });
    assert.equal(dr.actions.length, 1);
    if (attempt < 3) {
      assert.equal(dr.actions[0].type, 'requeue');
    } else {
      assert.equal(dr.actions[0].type, 'park-breaker');
      const parkedData = dr.actions[0].events[1].data as { reason: string; parkKind?: string };
      assert.match(parkedData.reason, /^thrashing: 3 identical fingerprints/);
      assert.equal(parkedData.parkKind, 'ops');
    }
    events = [...events, ...dr.actions[0].events];
  }
  const finalItem = fold(events).items.get('WI-500');
  assert.ok(finalItem);
  assert.equal(finalItem.state, 'parked');
  assert.equal(finalItem.parkKind, 'ops');
});

test('doctor: differing fingerprints never trigger thrashing (falls through to plain requeue)', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-501', 'item.captured', { source: 'cli', text: 'test' }, '2026-01-01T00:00:00Z'),
    makeEvent('conductor', 'WI-501', 'item.queued', { spec: '' }, '2026-01-01T00:01:00Z'),
    makeEvent('dispatch', 'WI-501', 'build.dispatched', { attempt: 1, pid: 1 }, '2026-01-01T00:02:00Z'),
    makeEvent('doctor', 'WI-501', 'build.crashed', { reason: 'orphan-detected', stderrTail: 'TypeError: x is not a function' }, '2026-01-01T00:10:00Z'),
    makeEvent('dispatch', 'WI-501', 'build.dispatched', { attempt: 2, pid: 2 }, '2026-01-01T00:11:00Z'),
    makeEvent('doctor', 'WI-501', 'build.crashed', { reason: 'orphan-detected', stderrTail: 'ReferenceError: y is not defined' }, '2026-01-01T00:20:00Z'),
    makeEvent('dispatch', 'WI-501', 'build.dispatched', { attempt: 3, pid: 999 }, '2026-01-01T00:21:00Z'),
  ];
  const result = fold(events);
  const item = result.items.get('WI-501');
  assert.ok(item);
  // Two distinct real stderr signatures — never equal to each other or to the empty-tail
  // fingerprint the doctor's own orphan-crash synthesis will produce for attempt 3.
  assert.notEqual(item.builds[0].errorFingerprint, item.builds[1].errorFingerprint);

  // breakerN above the current attempt count, so with thrashing correctly NOT firing this
  // must fall through to a plain requeue (not a park of any kind).
  const dr = runDoctor(result, deadProbe, { breakerN: 10 });
  assert.equal(dr.actions.length, 1);
  assert.equal(dr.actions[0].type, 'requeue');
});

test('doctor: an already-parked (thrashed) item is never re-parked on a later beat', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-502', 'item.captured', { source: 'cli', text: 'test' }, '2026-01-01T00:00:00Z'),
    makeEvent('conductor', 'WI-502', 'item.queued', { spec: '' }, '2026-01-01T00:01:00Z'),
    makeEvent('dispatch', 'WI-502', 'build.dispatched', { attempt: 1, pid: 1 }, '2026-01-01T00:02:00Z'),
    makeEvent('doctor', 'WI-502', 'build.crashed', { reason: 'orphan-detected', stderrTail: '' }, '2026-01-01T00:10:00Z'),
    makeEvent('dispatch', 'WI-502', 'build.dispatched', { attempt: 2, pid: 2 }, '2026-01-01T00:11:00Z'),
    makeEvent('doctor', 'WI-502', 'build.crashed', { reason: 'orphan-detected', stderrTail: '' }, '2026-01-01T00:20:00Z'),
    makeEvent('dispatch', 'WI-502', 'build.dispatched', { attempt: 3, pid: 3 }, '2026-01-01T00:21:00Z'),
    makeEvent('doctor', 'WI-502', 'build.crashed', { reason: 'thrashing: 3 identical fingerprints (abc)', stderrTail: '' }, '2026-01-01T00:30:00Z'),
    makeEvent('doctor', 'WI-502', 'item.parked', { reason: 'thrashing: 3 identical fingerprints (abc)', parkKind: 'ops' }, '2026-01-01T00:30:01Z'),
  ];
  const result = fold(events);
  const item = result.items.get('WI-502');
  assert.ok(item);
  assert.equal(item.state, 'parked');

  const dr = runDoctor(result, deadProbe, { breakerN: 10 });
  assert.equal(dr.actions.length, 0);
});

test('doctor: item without pid is not checkable (not orphaned)', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-005', 'item.captured', { source: 'cli', text: 'test' }),
    makeEvent('conductor', 'WI-005', 'item.queued', { spec: '' }),
    makeEvent('dispatch', 'WI-005', 'build.dispatched', { attempt: 1 }), // no pid
  ];
  const result = fold(events);
  const dr = runDoctor(result, deadProbe); // even a "dead" probe can't kill what it can't check
  // A missing pid means liveness is unknown, not dead — never crash-loop an unverifiable build.
  assert.equal(dr.orphans.length, 0);
  assert.equal(dr.actions.length, 0);
});

test('doctor: pid-less in-flight planning-lane build is never orphan-crashed', () => {
  // Planning-lane build.dispatched events (dispatch.ts buildPlanningDispatch) run
  // synchronously inside the beat and carry no worker pid — this used to be misread as
  // "dead" and reaped within seconds, racing a duplicate decomposition.
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-300', 'item.captured', { source: 'cli', text: 'plan the epic' }),
    makeEvent('reactor', 'WI-300', 'item.queued', { spec: 'plan the epic', lane: 'planning' }),
    makeEvent('dispatch', 'WI-300', 'build.dispatched', { attempt: 1 }), // no pid — planning lane
  ];
  const result = fold(events);
  const dr = runDoctor(result, deadProbe);
  assert.equal(dr.orphans.length, 0);
  assert.equal(dr.actions.length, 0);
});

// ── exit-file inversion (double-execution guard) ────────────────────────────────────

test('doctor: detached build with dead group + exit-file present is NOT orphaned (the race)', () => {
  // THE double-execution bug: the doctor's cadence beats the collector's — a finished detached
  // worker (group dead, exit sentinel written, not yet collected) must read as
  // completed-awaiting-collection, never orphan-crash→requeue an about-to-merge build.
  const events = buildDetachedEvents('WI-401', 55555, '2026-01-01T00:02:00Z');
  const result = fold(events);
  // now is well past the grace window, so absent the exit file it WOULD be an orphan.
  const now = new Date('2026-01-01T01:00:00Z').getTime();
  const dr = runDoctor(result, deadProbe, { breakerN: 3, now }, 'doctor', undefined, exitPresent);
  assert.equal(dr.orphans.length, 0, 'exit-file present ⇒ collectable, not orphan');
  assert.equal(dr.actions.length, 0);
});

test('doctor: detached build with dead group + no exit-file past one cycle IS an orphan', () => {
  const events = buildDetachedEvents('WI-402', 55556, '2026-01-01T00:02:00Z');
  const result = fold(events);
  const now = new Date('2026-01-01T00:02:00Z').getTime() + DEFAULT_COLLECTION_CYCLE_MS + 1;
  const dr = runDoctor(result, deadProbe, { breakerN: 3, now }, 'doctor', undefined, exitAbsent);
  assert.equal(dr.orphans.length, 1);
  assert.equal(dr.orphans[0].id, 'WI-402');
  assert.equal(dr.actions[0].type, 'requeue');
  assert.equal(dr.actions[0].events[0].type, 'build.crashed');
});

test('doctor: detached build within the collection grace is deferred, not orphaned', () => {
  // The group briefly looks dead / the worker just spawned and has not yet written its exit
  // file. Inside one collection cycle we must defer — reaping now races the collector.
  const events = buildDetachedEvents('WI-403', 55557, '2026-01-01T00:02:00Z');
  const result = fold(events);
  const now = new Date('2026-01-01T00:02:00Z').getTime() + Math.floor(DEFAULT_COLLECTION_CYCLE_MS / 2);
  const dr = runDoctor(result, deadProbe, { breakerN: 3, now }, 'doctor', undefined, exitAbsent);
  assert.equal(dr.orphans.length, 0, 'inside grace ⇒ defer');
  assert.equal(dr.actions.length, 0);
});

test('doctor: detached build with no clock is deferred (never a false orphan-crash)', () => {
  const events = buildDetachedEvents('WI-404', 55558, '2026-01-01T00:02:00Z');
  const result = fold(events);
  // No config.now — cannot judge the grace window, so defer rather than risk reaping a live build.
  const dr = runDoctor(result, deadProbe, { breakerN: 3 }, 'doctor', undefined, exitAbsent);
  assert.equal(dr.orphans.length, 0);
  assert.equal(dr.actions.length, 0);
});

test('doctor: a custom collectionCycleMs governs the grace boundary', () => {
  const events = buildDetachedEvents('WI-405', 55559, '2026-01-01T00:02:00Z');
  const result = fold(events);
  const base = new Date('2026-01-01T00:02:00Z').getTime();
  // 10s grace: at +9s defer, at +11s orphan.
  const young = runDoctor(result, deadProbe, { breakerN: 3, now: base + 9_000, collectionCycleMs: 10_000 }, 'doctor', undefined, exitAbsent);
  assert.equal(young.orphans.length, 0);
  const old = runDoctor(result, deadProbe, { breakerN: 3, now: base + 11_000, collectionCycleMs: 10_000 }, 'doctor', undefined, exitAbsent);
  assert.equal(old.orphans.length, 1);
});

test('doctor: legacy pid-only build still orphans immediately (exit-file inversion is inert without pgid)', () => {
  // The default exit-file probe returns false and legacy builds carry no pgid, so the whole
  // the exit-file inversion is bypassed — a dead-pid synchronous build orphans on the spot, exactly as before.
  const events = buildBldEvents('WI-406', 99998);
  const result = fold(events);
  const dr = runDoctor(result, deadProbe); // no now, no exit-file probe — legacy signature
  assert.equal(dr.orphans.length, 1);
  assert.equal(dr.actions[0].type, 'requeue');
});

// ── group-probe semantics (orphan-reap defect fix) ──────────────────────────────────
// A DETACHED build records a process-GROUP id (pgid); its liveness must be judged by probing the
// whole GROUP, never just the leader. A live worker whose group leader has already exited keeps
// the group alive — probing only the leader read it as dead and orphan-reaped a running build.

test('doctor: detached build is probed as a GROUP (isGroup=true); legacy build as a single pid', () => {
  const calls: Array<{ id: number; isGroup: boolean | undefined }> = [];
  const spy: PidProbe = (id, isGroup) => { calls.push({ id, isGroup }); return true; };

  // Detached (pgid) build → group probe.
  const detached = fold(buildDetachedEvents('WI-410', 55560, '2026-01-01T00:02:00Z'));
  runDoctor(detached, spy, { breakerN: 3, now: new Date('2026-01-01T01:00:00Z').getTime() });
  assert.deepEqual(calls, [{ id: 55560, isGroup: true }], 'a detached build must be probed as a group (isGroup=true)');

  // Legacy (pid) build → single-pid probe.
  calls.length = 0;
  runDoctor(fold(buildBldEvents('WI-411', 12321)), spy);
  assert.deepEqual(calls, [{ id: 12321, isGroup: false }], 'a legacy build must be probed as a single pid (isGroup=false)');
});

test('doctor: a detached group that reads alive AS A GROUP is never orphaned (live worker, dead leader)', () => {
  // The exact orphan-reap defect: a leader-only probe would read this group dead and reap a build
  // that is still running. A group probe reads it alive → no orphan, even well past the grace and
  // with no exit file (absent liveness it WOULD have orphaned).
  const events = buildDetachedEvents('WI-412', 55561, '2026-01-01T00:02:00Z');
  const result = fold(events);
  const now = new Date('2026-01-01T01:00:00Z').getTime();
  // Models "group alive, leader dead": alive iff the doctor asks for the GROUP.
  const groupOnlyAlive: PidProbe = (_id, isGroup) => isGroup === true;
  const dr = runDoctor(result, groupOnlyAlive, { breakerN: 3, now }, 'doctor', undefined, exitAbsent);
  assert.equal(dr.orphans.length, 0, 'a live group is never an orphan, even if a leader-only probe would read dead');
  assert.equal(dr.actions.length, 0);
});

test('defaultPidProbe: isGroup=true targets the whole process group (negative pid); a dead group reads dead', async () => {
  const { spawn } = await import('node:child_process');
  // A detached child is its own session/group leader (setsid) — its pid == its pgid.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  const pgid = child.pid!;
  // While alive, both the group probe and the single-pid probe see it.
  assert.equal(defaultPidProbe(pgid, true), true, 'group probe sees the live group');
  assert.equal(defaultPidProbe(pgid, false), true, 'single-pid probe sees the live leader');
  // Kill the whole group and WAIT for Node to reap the child (a zombie still answers kill(pid,0)).
  const exited = new Promise<void>(res => child.on('exit', () => res()));
  process.kill(-pgid, 'SIGKILL');
  await exited;
  assert.equal(defaultPidProbe(pgid, true), false, 'a dead group reads dead');
  assert.equal(defaultPidProbe(pgid, false), false, 'a dead pid reads dead');
});

// ── post-collection-limbo reaper ────────────────────────────────────────────────────

test('doctor: exit-file present + worktree gone + dispatch stale past limboMaxMs IS reaped', () => {
  // A detached worker finished (exit file written, dead group) but the ledger never
  // recorded a terminal event, its worktree was later removed, and it sat
  // "collectable-forever" per the plain exit-file guard for many beats.
  const events = buildDetachedEvents('WI-304', 60001, '2026-01-01T00:02:00Z');
  const result = fold(events);
  const item = result.items.get('WI-304');
  assert.ok(item);
  assert.equal(item.state, 'building');

  const now = new Date('2026-01-01T00:02:00Z').getTime() + DEFAULT_LIMBO_MAX_MS + 1;
  const dr = runDoctor(
    result, deadProbe, { breakerN: 3, now }, 'doctor', undefined, exitPresent, worktreeGone,
  );
  assert.equal(dr.orphans.length, 1, 'post-collection-limbo must be reaped, not deferred forever');
  assert.equal(dr.orphans[0].id, 'WI-304');
  assert.equal(dr.actions[0].type, 'requeue');
  assert.equal(dr.actions[0].events[0].type, 'build.crashed');
  const d = dr.actions[0].events[0].data as { reason: string };
  assert.match(d.reason, /post-collection-limbo/);
});

test('doctor: exit-file present + worktree gone but dispatch NOT yet stale is still deferred', () => {
  const events = buildDetachedEvents('WI-405', 60002, '2026-01-01T00:02:00Z');
  const result = fold(events);
  const now = new Date('2026-01-01T00:02:00Z').getTime() + Math.floor(DEFAULT_LIMBO_MAX_MS / 2);
  const dr = runDoctor(
    result, deadProbe, { breakerN: 3, now }, 'doctor', undefined, exitPresent, worktreeGone,
  );
  assert.equal(dr.orphans.length, 0, 'still inside the limbo window ⇒ defer');
  assert.equal(dr.actions.length, 0);
});

test('doctor: exit-file present + worktree still present is never reaped even when stale', () => {
  const events = buildDetachedEvents('WI-406', 60003, '2026-01-01T00:02:00Z');
  const result = fold(events);
  const now = new Date('2026-01-01T00:02:00Z').getTime() + DEFAULT_LIMBO_MAX_MS + 1;
  const dr = runDoctor(
    result, deadProbe, { breakerN: 3, now }, 'doctor', undefined, exitPresent, worktreePresent,
  );
  assert.equal(dr.orphans.length, 0, 'worktree still present ⇒ genuinely collectable, never reap');
  assert.equal(dr.actions.length, 0);
});

test('doctor: exit-file present + worktree gone + stale but NO clock is deferred (never a false reap)', () => {
  const events = buildDetachedEvents('WI-407', 60004, '2026-01-01T00:02:00Z');
  const result = fold(events);
  // No config.now — cannot judge staleness, so defer rather than risk reaping a live collection.
  const dr = runDoctor(
    result, deadProbe, { breakerN: 3 }, 'doctor', undefined, exitPresent, worktreeGone,
  );
  assert.equal(dr.orphans.length, 0);
  assert.equal(dr.actions.length, 0);
});

test('doctor: post-collection-limbo respects the breaker (parks at the attempt limit)', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-408', 'item.captured', { source: 'cli', text: 'test' }, '2026-01-01T00:00:00Z'),
    makeEvent('conductor', 'WI-408', 'item.queued', { spec: 'spec' }, '2026-01-01T00:01:00Z'),
    makeEvent('dispatch', 'WI-408', 'build.dispatched', { attempt: 3, pgid: 60005 }, '2026-01-01T00:02:00Z'),
  ];
  const result = fold(events);
  const now = new Date('2026-01-01T00:02:00Z').getTime() + DEFAULT_LIMBO_MAX_MS + 1;
  const dr = runDoctor(
    result, deadProbe, { breakerN: 3, now }, 'doctor', undefined, exitPresent, worktreeGone,
  );
  assert.equal(dr.orphans.length, 1);
  assert.equal(dr.actions[0].type, 'park-breaker');
  assert.equal(dr.actions[0].events[1].type, 'item.parked');
});

test('doctor: multiple orphans all detected', () => {
  const ev1 = buildBldEvents('WI-001', 111);
  const ev2 = buildBldEvents('WI-002', 222);
  const result = fold([...ev1, ...ev2]);
  const dr = runDoctor(result, deadProbe);
  assert.equal(dr.orphans.length, 2);
  assert.equal(dr.actions.length, 2);
});

test('doctor: stuck-routed-build item is detected and requeued', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-010', 'item.captured', { source: 'ext:EXT-001', text: 'build the thing' }, '2026-01-01T00:00:00Z'),
    // Routing emitted item.routed with route:'build' but item.queued was never committed
    makeEvent('reactor', 'WI-010', 'item.routed', { route: 'build', reply: 'Queued for build.' }, '2026-01-01T00:01:00Z'),
  ];
  const result = fold(events);
  const item = result.items.get('WI-010');
  assert.ok(item);
  assert.equal(item.state, 'routed');
  assert.equal(item.route, 'build');

  const dr = runDoctor(result, deadProbe);
  assert.equal(dr.orphans.length, 1);
  assert.equal(dr.orphans[0].id, 'WI-010');
  assert.equal(dr.actions.length, 1);
  assert.equal(dr.actions[0].type, 'requeue');
  assert.equal(dr.actions[0].events.length, 1);
  assert.equal(dr.actions[0].events[0].type, 'item.queued');
});

test('doctor: stuck-routed-build uses sourceText as spec fallback', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-011', 'item.captured', { source: 'ext:EXT-002', text: 'add dark mode' }, '2026-01-01T00:00:00Z'),
    makeEvent('reactor', 'WI-011', 'item.routed', { route: 'build', reply: 'Queued.' }, '2026-01-01T00:01:00Z'),
  ];
  const result = fold(events);
  const dr = runDoctor(result, deadProbe);
  const ev = dr.actions[0].events[0];
  assert.equal(ev.type, 'item.queued');
  const d = ev.data as { spec: string };
  assert.equal(d.spec, 'add dark mode');
});

test('doctor: routed-answer item is not touched', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-012', 'item.captured', { source: 'ext:EXT-003', text: 'what is the status?' }, '2026-01-01T00:00:00Z'),
    makeEvent('reactor', 'WI-012', 'item.routed', { route: 'answer', reply: 'Lane is healthy.' }, '2026-01-01T00:01:00Z'),
  ];
  const result = fold(events);
  const item = result.items.get('WI-012');
  assert.ok(item);
  // terminal routes (answer/question/duplicate/merged) rest in 'answered'
  assert.equal(item.state, 'answered');
  assert.equal(item.route, 'answer');

  const dr = runDoctor(result, deadProbe);
  assert.equal(dr.orphans.length, 0);
  assert.equal(dr.actions.length, 0);
});

test('doctor: routed-stuck requeue carries cumulative attempt count from fold', () => {
  // Build a FoldResult directly so we can set attempts > 0 on a 'routed' item.
  // The fold guard (item.routed only transitions from 'captured') means event-based
  // construction can't produce routed+attempts>0; but the doctor is a pure function
  // over FoldResult, so we can hand it any valid record to verify the contract.
  const rec: ItemRecord = {
    id: 'WI-020',
    state: 'routed',
    lane: 'engineering',
    route: 'build',
    attempts: 3,
    builds: [],
    messages: [],
    transitions: {},
    spec: 'add feature',
    sourceText: 'add feature',
    touches: 'apps/example/src',
    model: 'sonnet',
    priority: 'medium',
  };
  const result: FoldResult = {
    items: new Map([['WI-020', rec]]),
    conversations: new Map(),
    targets: new TargetsProjection(),
    maxWiNum: 20,
    maxConvNum: 0,
    failureCatalog: new Map(),
    sessions: new Map(),
  };

  const dr = runDoctor(result, deadProbe);
  assert.equal(dr.actions.length, 1);
  const action = dr.actions[0];
  assert.equal(action.type, 'requeue');
  // Must carry the actual attempt count from the fold, not reset to 0
  assert.equal(action.attempt, 3, `action.attempt should be rec.attempts=3 (got ${action.attempt})`);
  assert.equal(action.events[0].type, 'item.queued');
});

// ---------------------------------------------------------------------------
// stalled-but-alive reaper
// ---------------------------------------------------------------------------

const DISPATCHED_MS = Date.parse('2026-01-01T00:02:00Z'); // build.dispatched ts in buildBldEvents
const MIN = 60_000;

test('stall: detection is inert without now/stalledBuildMinutes (alive stays working)', () => {
  const result = fold(buildBldEvents('WI-100', 111));
  const dr = runDoctor(result, aliveProbe, { breakerN: 3 }, 'doctor', () => DISPATCHED_MS);
  assert.equal(dr.stalled.length, 0);
  assert.equal(dr.actions.length, 0);
});

test('stall: alive build with no progress past the window → stalled + requeue with resume note', () => {
  const result = fold(buildBldEvents('WI-101', 111));
  const now = DISPATCHED_MS + 60 * MIN;
  const dr = runDoctor(
    result, aliveProbe, { breakerN: 3, stalledBuildMinutes: 40, now }, 'doctor',
    () => DISPATCHED_MS, // last progress at dispatch; none since
  );
  assert.equal(dr.stalled.length, 1);
  assert.equal(dr.stalled[0].id, 'WI-101');
  assert.equal(dr.orphans.length, 0);
  assert.equal(dr.actions.length, 1);
  assert.equal(dr.actions[0].type, 'requeue');
  assert.equal(dr.actions[0].events[0].type, 'build.stalled');
  assert.equal(dr.actions[0].events[1].type, 'item.queued');
  const q = dr.actions[0].events[1];
  assert.match(String((q.data as Record<string, unknown>)['repairContext']), /stalled/i);
});

test('stall: alive build making recent progress → not stalled', () => {
  const result = fold(buildBldEvents('WI-102', 111));
  const now = DISPATCHED_MS + 60 * MIN;
  const dr = runDoctor(
    result, aliveProbe, { breakerN: 3, stalledBuildMinutes: 40, now }, 'doctor',
    () => now - 5 * MIN, // progressed 5 min ago
  );
  assert.equal(dr.stalled.length, 0);
  assert.equal(dr.actions.length, 0);
});

test('stall: fresh alive build (age < window) is never reaped even with no progress', () => {
  const result = fold(buildBldEvents('WI-103', 111));
  const now = DISPATCHED_MS + 20 * MIN; // younger than the 40-min window
  const dr = runDoctor(
    result, aliveProbe, { breakerN: 3, stalledBuildMinutes: 40, now }, 'doctor',
    () => DISPATCHED_MS,
  );
  assert.equal(dr.stalled.length, 0);
});

test('stall: null progress signal → do not reap (absence is not evidence)', () => {
  const result = fold(buildBldEvents('WI-104', 111));
  const now = DISPATCHED_MS + 60 * MIN;
  const dr = runDoctor(
    result, aliveProbe, { breakerN: 3, stalledBuildMinutes: 40, now }, 'doctor', () => null,
  );
  assert.equal(dr.stalled.length, 0);
});

test('stall: at the breaker limit, a stalled build parks instead of requeue', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-105', 'item.captured', { source: 'cli', text: 't' }, '2026-01-01T00:00:00Z'),
    makeEvent('conductor', 'WI-105', 'item.queued', { spec: 's' }, '2026-01-01T00:01:00Z'),
    makeEvent('dispatch', 'WI-105', 'build.dispatched', { attempt: 3, pid: 111 }, '2026-01-01T00:02:00Z'),
  ];
  const result = fold(events);
  const now = DISPATCHED_MS + 60 * MIN;
  const dr = runDoctor(
    result, aliveProbe, { breakerN: 3, stalledBuildMinutes: 40, now }, 'doctor', () => DISPATCHED_MS,
  );
  assert.equal(dr.stalled.length, 1);
  assert.equal(dr.actions[0].type, 'park-breaker');
  assert.equal(dr.actions[0].events[0].type, 'build.stalled');
  assert.equal(dr.actions[0].events[1].type, 'item.parked');
});

test('stall: detectStall returns null without config.now (direct unit)', () => {
  const result = fold(buildBldEvents('WI-106', 111));
  const rec = result.items.get('WI-106')!;
  assert.equal(detectStall(rec, { breakerN: 3, stalledBuildMinutes: 40 }, () => 0), null);
});

// ---------------------------------------------------------------------------
// ledger truncation guard — detectLedgerRegression
// ---------------------------------------------------------------------------

test('detectLedgerRegression: no watermarks yet → nothing regresses, all baselined', () => {
  const r = detectLedgerRegression(
    { 'work-2026-07.jsonl': '01J000000000000000000010' },
    {},
  );
  assert.equal(r.regressed, false);
  assert.deepEqual(r.regressions, []);
  assert.equal(r.nextWatermarks['work-2026-07.jsonl'], '01J000000000000000000010');
});

test('detectLedgerRegression: current at or above watermark → not regressed, watermark advances', () => {
  const r = detectLedgerRegression(
    { 'work-2026-07.jsonl': '01J000000000000000000020' },
    { 'work-2026-07.jsonl': '01J000000000000000000010' },
  );
  assert.equal(r.regressed, false);
  assert.equal(r.nextWatermarks['work-2026-07.jsonl'], '01J000000000000000000020');
});

test('detectLedgerRegression: current id below the prior watermark → regression, watermark HOLDS', () => {
  const r = detectLedgerRegression(
    { 'work-2026-07.jsonl': '01J000000000000000000005' },
    { 'work-2026-07.jsonl': '01J000000000000000000010' },
  );
  assert.equal(r.regressed, true);
  assert.equal(r.regressions.length, 1);
  assert.deepEqual(r.regressions[0], {
    file: 'work-2026-07.jsonl',
    watermark: '01J000000000000000000010',
    current: '01J000000000000000000005',
  });
  // Must NOT silently accept the lower value as the new baseline.
  assert.equal(r.nextWatermarks['work-2026-07.jsonl'], '01J000000000000000000010');
});

test('detectLedgerRegression: a file that vanishes entirely is a regression (current: null)', () => {
  const r = detectLedgerRegression(
    {},
    { 'work-2026-07.jsonl': '01J000000000000000000010' },
  );
  assert.equal(r.regressed, true);
  assert.equal(r.regressions[0].current, null);
  assert.equal(r.nextWatermarks['work-2026-07.jsonl'], '01J000000000000000000010');
});

test('detectLedgerRegression: one file regresses, a sibling file still advances independently', () => {
  const r = detectLedgerRegression(
    {
      'work-2026-07.jsonl': '01J000000000000000000005', // regressed
      'ops-2026-07.jsonl': '01J000000000000000000099', // advanced fine
    },
    {
      'work-2026-07.jsonl': '01J000000000000000000010',
      'ops-2026-07.jsonl': '01J000000000000000000050',
    },
  );
  assert.equal(r.regressed, true);
  assert.equal(r.regressions.length, 1);
  assert.equal(r.regressions[0].file, 'work-2026-07.jsonl');
  assert.equal(r.nextWatermarks['work-2026-07.jsonl'], '01J000000000000000000010'); // held
  assert.equal(r.nextWatermarks['ops-2026-07.jsonl'], '01J000000000000000000099'); // advanced
});

// ---------------------------------------------------------------------------
// detectDistDrift
// ---------------------------------------------------------------------------

test('detectDistDrift: nothing merged yet → never drifted', () => {
  const r = detectDistDrift(null, null, 1_000_000);
  assert.equal(r.drifted, false);
  assert.equal(r.behindMs, 0);
});

test('detectDistDrift: dist built after the last merge → not drifted', () => {
  const r = detectDistDrift(1_000_000, 1_500_000, 2_000_000);
  assert.equal(r.drifted, false);
  assert.equal(r.behindMs, 0);
});

test('detectDistDrift: merge landed after dist was last built → drifted', () => {
  const r = detectDistDrift(1_500_000, 1_000_000, 2_000_000);
  assert.equal(r.drifted, true);
  assert.equal(r.behindMs, 500_000);
});

test('detectDistDrift: dist missing entirely with a merge on record → maximally drifted', () => {
  const r = detectDistDrift(1_000_000, null, 3_000_000);
  assert.equal(r.drifted, true);
  assert.equal(r.behindMs, 2_000_000);
});

test('detectDistDrift: merge and dist mtime exactly equal → not drifted (boundary, not strictly behind)', () => {
  const r = detectDistDrift(1_000_000, 1_000_000, 2_000_000);
  assert.equal(r.drifted, false);
  assert.equal(r.behindMs, 0);
});
