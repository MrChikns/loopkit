/**
 * cli.test.ts — Tests for loopctl approve/reject/accept verbs and the summary/events reads.
 *
 * Spawns the compiled CLI binary (available after `npm run build`), so these
 * tests exercise the full verb path including the withLock transaction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { appendEvent } from '../src/ledger.js';
import { makeEvent } from '../src/schema.js';
import { fold, projectEngagement } from '../src/fold.js';
import { loadAllEvents } from '../src/ledger.js';

const execFileAsync = promisify(execFile);
// Compiled test lives at dist-test/test/; the CLI compiles to dist-test/src/cli.js (NOT dist/).
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const WORK_DIR = join(tmpdir(), `loopkit-cli-test-${process.pid}`);

function makeTemp(label: string): string {
  const dir = join(WORK_DIR, label);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function runLoopctl(ledgerDir: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], {
    env: { ...process.env, LOOPKIT_LEDGER: ledgerDir },
  });
  return stdout.trim();
}

test('loopctl approve WI-001: appends item.approved and msg.in events, fold shows approved state', async () => {
  const dir = makeTemp('approve-wi');
  try {
    // Seed a captured item
    await appendEvent(dir, makeEvent('test', 'WI-001', 'item.captured', { source: 'cli', text: 'spine change' }));

    const out = await runLoopctl(dir, 'approve', 'WI-001');
    assert.ok(out.includes('Approved WI-001'), `expected "Approved WI-001", got: ${out}`);

    const events = await loadAllEvents(dir);
    const result = fold(events);
    const rec = result.items.get('WI-001');
    assert.ok(rec, 'WI-001 must exist in fold');
    assert.equal(rec.state, 'approved');

    const approved = events.find(e => e.type === 'item.approved' && e.item === 'WI-001');
    assert.ok(approved, 'item.approved event must be in ledger');
    assert.equal((approved!.data as { by: string }).by, 'operator');

    const msgIn = events.find(e => e.type === 'msg.in' && e.item === 'WI-001');
    assert.ok(msgIn, 'msg.in trail event must be in ledger');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loopctl reject WI-001: appends item.rejected and msg.in events, fold shows rejected state', async () => {
  const dir = makeTemp('reject-wi');
  try {
    await appendEvent(dir, makeEvent('test', 'WI-001', 'item.captured', { source: 'cli', text: 'risky spine change' }));

    await runLoopctl(dir, 'reject', 'WI-001');

    const events = await loadAllEvents(dir);
    const result = fold(events);
    const rec = result.items.get('WI-001');
    assert.equal(rec?.state, 'rejected');

    const rejected = events.find(e => e.type === 'item.rejected' && e.item === 'WI-001');
    assert.ok(rejected, 'item.rejected event must be in ledger');
    assert.equal((rejected!.data as { by: string }).by, 'operator');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loopctl reject WI-001 --by reactor: stamps a machine closure, not the default actor', async () => {
  const dir = makeTemp('reject-wi-by-reactor');
  try {
    await appendEvent(dir, makeEvent('test', 'WI-001', 'item.captured', { source: 'cli', text: 'duplicate-of-merged closure' }));

    await runLoopctl(dir, 'reject', 'WI-001', '--by', 'reactor');

    const events = await loadAllEvents(dir);
    const result = fold(events);
    const rec = result.items.get('WI-001');
    assert.equal(rec?.state, 'rejected');
    assert.equal(rec?.rejectedBy, 'reactor');

    const rejected = events.find(e => e.type === 'item.rejected' && e.item === 'WI-001');
    assert.equal((rejected!.data as { by: string }).by, 'reactor');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loopctl approve: --trail text appears in msg.in event', async () => {
  const dir = makeTemp('approve-trail');
  try {
    await appendEvent(dir, makeEvent('test', 'WI-005', 'item.captured', { source: 'cli', text: 'trail test' }));

    await runLoopctl(dir, 'approve', 'WI-005', '--trail', '🛡 spine WI-005: approve');

    const events = await loadAllEvents(dir);
    const msgIn = events.find(e => e.type === 'msg.in' && e.item === 'WI-005');
    assert.ok(msgIn, 'msg.in must be written');
    assert.equal((msgIn!.data as { text: string }).text, '🛡 spine WI-005: approve');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loopctl approve on parked-unbuilt: emits item.unparked (not item.approved), fold shows queued', async () => {
  const dir = makeTemp('approve-parked-unbuilt');
  try {
    // Seed an item parked with no build ever dispatched (e.g. a mechanical park before
    // dispatch picked it up) — approve must route it back to the queue, not strand it
    // in an invisible 'approved' state with builds:[].
    await appendEvent(dir, makeEvent('test', 'WI-006', 'item.captured', { source: 'cli', text: 'parked before dispatch' }));
    await appendEvent(dir, makeEvent('reactor', 'WI-006', 'item.parked', { reason: 'touches-overstep', parkKind: 'ops' }));

    const out = await runLoopctl(dir, 'approve', 'WI-006');
    assert.ok(out.includes('Unparked WI-006'), `expected "Unparked WI-006", got: ${out}`);

    const events = await loadAllEvents(dir);
    const result = fold(events);
    const rec = result.items.get('WI-006');
    assert.ok(rec, 'WI-006 must exist in fold');
    assert.equal(rec.state, 'queued', 'parked-unbuilt approve must transition to queued, not approved');
    assert.equal(rec.builds.length, 0);

    const unparked = events.find(e => e.type === 'item.unparked' && e.item === 'WI-006');
    assert.ok(unparked, 'item.unparked event must be in ledger');
    assert.equal((unparked!.data as { by: string }).by, 'operator');

    const approved = events.find(e => e.type === 'item.approved' && e.item === 'WI-006');
    assert.ok(!approved, 'item.approved must NOT be emitted for parked-unbuilt approve');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Dependency-wait stored-spec approve (skip the LLM routing call) +
// double-verb-processing dedup (inReplyTo threaded onto every verb event)
// ---------------------------------------------------------------------------

test('loopctl approve: stored-spec + resolved dependency queues directly with the stored spec (no LLM call)', async () => {
  const dir = makeTemp('approve-stored-spec-resolved');
  try {
    await appendEvent(dir, makeEvent('test', 'WI-359', 'item.captured', { source: 'cli', text: 'window picker' }));
    await appendEvent(dir, makeEvent('reactor', 'WI-359', 'item.merged', { commit: 'abc123' }));

    await appendEvent(dir, makeEvent('test', 'WI-360', 'item.captured', { source: 'cli', text: 'Extend the fold to a 30d horizon.' }));
    await appendEvent(dir, makeEvent('reactor', 'WI-360', 'item.parked', {
      reason: 'WI-360 explicitly depends on WI-359, which has not merged yet.',
      parkKind: 'decision',
      storedSpec: 'Extend the fold to a 30d horizon.',
    }));

    const out = await runLoopctl(dir, 'approve', 'WI-360');
    assert.match(out, /stored spec/);

    const events = await loadAllEvents(dir);
    const result = fold(events);
    const rec = result.items.get('WI-360');
    assert.equal(rec?.state, 'queued');
    assert.equal(rec?.spec, 'Extend the fold to a 30d horizon.');

    const queued = events.find(e => e.type === 'item.queued' && e.item === 'WI-360');
    assert.ok(queued, 'item.queued must be emitted directly, carrying the stored spec');
    const unparked = events.find(e => e.type === 'item.unparked' && e.item === 'WI-360');
    assert.ok(unparked, 'item.unparked must be emitted alongside (park-field lifecycle)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loopctl approve: stored-spec but dependency NOT yet merged → refuses (no ledger write), item stays parked', async () => {
  const dir = makeTemp('approve-stored-spec-unresolved');
  try {
    // WI-359 stays 'captured' — not merged yet.
    await appendEvent(dir, makeEvent('test', 'WI-359', 'item.captured', { source: 'cli', text: 'window picker' }));

    await appendEvent(dir, makeEvent('test', 'WI-360', 'item.captured', { source: 'cli', text: 'Extend the fold to a 30d horizon.' }));
    await appendEvent(dir, makeEvent('reactor', 'WI-360', 'item.parked', {
      reason: 'WI-360 explicitly depends on WI-359, which has not merged yet.',
      parkKind: 'decision',
      storedSpec: 'Extend the fold to a 30d horizon.',
    }));

    const out = await runLoopctl(dir, 'approve', 'WI-360');
    assert.match(out, /waiting on WI-359/);

    const events = await loadAllEvents(dir);
    const result = fold(events);
    const rec = result.items.get('WI-360');
    assert.equal(rec?.state, 'parked', 'must stay parked — never build ahead of an unresolved dependency');

    assert.ok(!events.some(e => e.type === 'item.queued' && e.item === 'WI-360'), 'item.queued must NOT be emitted');
    assert.ok(!events.some(e => e.type === 'item.unparked' && e.item === 'WI-360'), 'no ledger write on refusal');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loopctl approve: the trail msg.in is answered immediately (double-reply fix — never re-picked by engagement)', async () => {
  const dir = makeTemp('approve-inreplyto-dedup');
  try {
    await appendEvent(dir, makeEvent('test', 'WI-400', 'item.captured', { source: 'cli', text: 'parked before dispatch' }));
    await appendEvent(dir, makeEvent('reactor', 'WI-400', 'item.parked', { reason: 'touches-overstep', parkKind: 'ops' }));
    await appendEvent(dir, makeEvent('reactor', 'system', 'engagement.baseline', {}));

    await runLoopctl(dir, 'approve', 'WI-400');

    const events = await loadAllEvents(dir);
    const msgIn = events.find(e => e.type === 'msg.in' && e.item === 'WI-400');
    assert.ok(msgIn, 'msg.in trail event must be in ledger');

    const { unanswered } = projectEngagement(events);
    assert.ok(!unanswered.some(u => u.evId === msgIn!.id),
      "the approve verb's own trail message must never be re-picked as an unanswered engagement reply");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// reject/approve argument validation
// ---------------------------------------------------------------------------

test('loopctl reject --help: rejects a non-WI/BLD id with a non-zero exit, never touches the ledger', async () => {
  const dir = makeTemp('reject-help-junk-arg');
  try {
    await assert.rejects(
      () => execFileAsync(process.execPath, [CLI, 'reject', '--help'], {
        env: { ...process.env, LOOPKIT_LEDGER: dir },
      }),
      /Command failed/,
      'a junk id must exit non-zero',
    );

    const events = await loadAllEvents(dir);
    assert.equal(events.length, 0, 'no events must be appended for an invalid id');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loopctl approve not-a-real-id: rejects a non-WI/BLD id with a non-zero exit, never touches the ledger', async () => {
  const dir = makeTemp('approve-junk-arg');
  try {
    await appendEvent(dir, makeEvent('test', 'WI-001', 'item.captured', { source: 'cli', text: 'unrelated item' }));

    await assert.rejects(
      () => execFileAsync(process.execPath, [CLI, 'approve', 'not-a-real-id'], {
        env: { ...process.env, LOOPKIT_LEDGER: dir },
      }),
      /Command failed/,
      'a junk id must exit non-zero',
    );

    const events = await loadAllEvents(dir);
    // Only the seeded item.captured must be present — no approve/msg.in appended.
    assert.equal(events.length, 1, 'no new events must be appended for an invalid id');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// approve on a with-builds item whose branch is gone
// ---------------------------------------------------------------------------

test('loopctl approve on a parked-with-builds item whose branch no longer exists: emits item.unparked + item.queued, not item.approved', async () => {
  const dir = makeTemp('approve-branch-gone');
  try {
    // Seed a parked item that WAS dispatched (so builds.length > 0 after the park archives
    // currentBuild) but whose branch name is pure fiction — the CLI resolves REPO_ROOT to
    // this actual git checkout, so `git rev-parse --verify <branch>` genuinely fails for any
    // branch name that was never created, exercising the real spawnSync check.
    await appendEvent(dir, makeEvent('test', 'WI-500', 'item.captured', { source: 'cli', text: 'branch-gone item' }));
    await appendEvent(dir, makeEvent('reactor', 'WI-500', 'item.routed', { route: 'build', reply: 'queued' }));
    await appendEvent(dir, makeEvent('reactor', 'WI-500', 'item.queued', {
      spec: 'branch-gone item', touches: 'packages/ui/', model: 'sonnet',
    }));
    await appendEvent(dir, makeEvent('dispatch', 'WI-500', 'build.dispatched', {
      attempt: 1, worktree: '/tmp/wt-500', branch: 'this-branch-definitely-does-not-exist', model: 'sonnet',
    }));
    await appendEvent(dir, makeEvent('dispatch', 'WI-500', 'item.parked', {
      reason: 'needs-decision: touches spine', parkKind: 'decision',
    }));

    const out = await runLoopctl(dir, 'approve', 'WI-500');
    assert.match(out, /branch lost — requeued for rebuild/, `expected the branch-lost message, got: ${out}`);

    const events = await loadAllEvents(dir);
    const result = fold(events);
    const rec = result.items.get('WI-500');
    assert.ok(rec, 'WI-500 must exist in fold');
    assert.equal(rec.state, 'queued', 'branch-gone approve must transition to queued, not approved');

    const approved = events.find(e => e.type === 'item.approved' && e.item === 'WI-500');
    assert.ok(!approved, 'item.approved must NOT be emitted when the branch is gone');

    const unparked = events.find(e => e.type === 'item.unparked' && e.item === 'WI-500');
    assert.ok(unparked, 'item.unparked event must be in ledger');

    const queued = events.find(e => e.type === 'item.queued' && e.item === 'WI-500' && e.actor === 'cli');
    assert.ok(queued, 'a fresh item.queued (requeue) event must be in ledger');
    const qd = queued!.data as { spec: string; touches?: string; model?: string };
    assert.equal(qd.spec, 'branch-gone item', 'spec must carry over onto the requeue');
    assert.equal(qd.touches, 'packages/ui/', 'touches must carry over onto the requeue');
    assert.equal(qd.model, 'sonnet', 'model must carry over onto the requeue');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loopctl new: defaults source to "cli", actor "cli"', async () => {
  const dir = makeTemp('new-default');
  try {
    const out = await runLoopctl(dir, 'new', 'plain capture');
    assert.ok(out.includes('Created WI-001'), `expected "Created WI-001", got: ${out}`);

    const events = await loadAllEvents(dir);
    const cap = events.find(e => e.type === 'item.captured' && e.item === 'WI-001');
    assert.ok(cap, 'item.captured must be in ledger');
    assert.equal((cap!.data as { source: string }).source, 'cli');
    assert.equal(cap!.actor, 'cli');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loopctl summary --json: threads carry the full msg.in/out bodies', async () => {
  const dir = makeTemp('summary-threads-messages');
  try {
    // An EXT-origin item with one opening message in and one reply out.
    await appendEvent(dir, makeEvent('operator', 'WI-007', 'item.captured', { source: 'ext:EXT-007', text: 'the equipment delivery is late' }));
    await appendEvent(dir, makeEvent('operator', 'WI-007', 'msg.in', { text: 'the equipment delivery is late' }));
    await appendEvent(dir, makeEvent('reactor', 'WI-007', 'msg.out', { text: 'On it — logged as a maintenance task.' }));

    const out = await runLoopctl(dir, 'summary', '--json');
    const summary = JSON.parse(out) as { threads: Array<{ id: string; externalRef?: string; outCount: number; messages: Array<{ direction: string; text: string }> }> };
    const thread = summary.threads.find((t) => t.id === 'WI-007');
    assert.ok(thread, 'WI-007 must appear in threads (it has a reply)');
    assert.equal(thread!.externalRef, 'EXT-007');
    assert.equal(thread!.outCount, 1);
    // The re-point of console thread rendering to the fold depends on these bodies.
    assert.ok(Array.isArray(thread!.messages), 'threads[].messages must be present');
    const bodies = thread!.messages.map((m) => `${m.direction}:${m.text}`);
    assert.ok(bodies.includes('in:the equipment delivery is late'), `msg.in body missing, got: ${JSON.stringify(bodies)}`);
    assert.ok(bodies.includes('out:On it — logged as a maintenance task.'), `msg.out body missing, got: ${JSON.stringify(bodies)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loopctl summary --json: parkKind round-trips fold → summary active[]', async () => {
  const dir = makeTemp('summary-parkkind-roundtrip');
  try {
    // An ops-park (mechanical failure) and a decision-park (the operator must call it).
    await appendEvent(dir, makeEvent('cli', 'WI-081', 'item.captured', { source: 'cli', text: 'ops item' }));
    await appendEvent(dir, makeEvent('dispatch', 'WI-081', 'item.parked', { reason: 'tests-red: boom', parkKind: 'ops' }));
    await appendEvent(dir, makeEvent('cli', 'WI-082', 'item.captured', { source: 'cli', text: 'decision item' }));
    await appendEvent(dir, makeEvent('dispatch', 'WI-082', 'item.parked', { reason: 'needs-decision: touches spine', parkKind: 'decision' }));

    const out = await runLoopctl(dir, 'summary', '--json');
    const summary = JSON.parse(out) as { active: Array<{ id: string; parkKind?: string; parkReason?: string }> };
    const ops = summary.active.find((i) => i.id === 'WI-081');
    const dec = summary.active.find((i) => i.id === 'WI-082');
    assert.ok(ops, 'ops-parked item must be active');
    assert.equal(ops!.parkKind, 'ops', 'parkKind:ops must survive fold → summary --json');
    assert.ok(dec, 'decision-parked item must be active');
    assert.equal(dec!.parkKind, 'decision', 'parkKind:decision must survive fold → summary --json');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Unaccepted merged items never age out of recentMerged
// ---------------------------------------------------------------------------

test('loopctl summary --json: an unaccepted merged item older than 7 days still appears in recentMerged', async () => {
  const dir = makeTemp('recent-merged-old-unaccepted');
  try {
    // Merged 30 days ago, never accepted — it still needs an operator decision, so it must
    // never silently vanish from the acceptance window regardless of age.
    await appendEvent(dir, makeEvent('reactor', 'WI-600', 'item.merged', { commit: 'abc600' }, '2026-06-17T00:00:00Z'));

    const out = await runLoopctl(dir, 'summary', '--json');
    const summary = JSON.parse(out) as { recentMerged: Array<{ id: string; accepted: boolean }> };
    const row = summary.recentMerged.find((r) => r.id === 'WI-600');
    assert.ok(row, 'an old unaccepted merged item must still appear in recentMerged');
    assert.equal(row!.accepted, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loopctl summary --json: an item accepted more than 7 days ago does NOT appear in recentMerged', async () => {
  const dir = makeTemp('recent-merged-old-accepted');
  try {
    // Merged and accepted 30 days ago — the 7-day window still applies once the operator
    // decision is already resolved (accepted), so this must age out.
    await appendEvent(dir, makeEvent('reactor', 'WI-601', 'item.merged', { commit: 'abc601' }, '2026-06-17T00:00:00Z'));
    await appendEvent(dir, makeEvent('operator', 'WI-601', 'item.accepted', { by: 'operator' }, '2026-06-17T01:00:00Z'));

    const out = await runLoopctl(dir, 'summary', '--json');
    const summary = JSON.parse(out) as { recentMerged: Array<{ id: string }> };
    const row = summary.recentMerged.find((r) => r.id === 'WI-601');
    assert.ok(!row, 'a merged item accepted more than 7 days ago must age out of recentMerged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loopctl summary --json: a recently-accepted item (within 7 days) still appears in recentMerged', async () => {
  const dir = makeTemp('recent-merged-fresh-accepted');
  try {
    await appendEvent(dir, makeEvent('reactor', 'WI-602', 'item.merged', { commit: 'abc602' }));
    await appendEvent(dir, makeEvent('operator', 'WI-602', 'item.accepted', { by: 'operator' }));

    const out = await runLoopctl(dir, 'summary', '--json');
    const summary = JSON.parse(out) as { recentMerged: Array<{ id: string; accepted: boolean }> };
    const row = summary.recentMerged.find((r) => r.id === 'WI-602');
    assert.ok(row, 'a freshly-accepted merged item must still appear in recentMerged');
    assert.equal(row!.accepted, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// recentMerged30d — the same merged-item shape, trimmed to a 30-day horizon
// ---------------------------------------------------------------------------

test('loopctl summary --json: an item accepted 20 days ago appears in recentMerged30d but not recentMerged', async () => {
  const dir = makeTemp('recent-merged-30d-mid-window');
  try {
    // Accepted 20 days before "now" — outside the 7-day recentMerged window but well
    // inside the 30-day recentMerged30d window.
    const acceptedAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    await appendEvent(dir, makeEvent('reactor', 'WI-610', 'item.merged', { commit: 'abc610' }, acceptedAt));
    await appendEvent(dir, makeEvent('operator', 'WI-610', 'item.accepted', { by: 'operator' }, acceptedAt));

    const out = await runLoopctl(dir, 'summary', '--json');
    const summary = JSON.parse(out) as {
      recentMerged: Array<{ id: string }>;
      recentMerged30d: Array<{ id: string; accepted: boolean }>;
    };
    assert.ok(!summary.recentMerged.find((r) => r.id === 'WI-610'), 'a 20-day-old accepted item must age out of recentMerged (7d)');
    const row30d = summary.recentMerged30d.find((r) => r.id === 'WI-610');
    assert.ok(row30d, 'a 20-day-old accepted item must still appear in recentMerged30d');
    assert.equal(row30d!.accepted, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loopctl summary --json: an item accepted more than 30 days ago does NOT appear in recentMerged30d', async () => {
  const dir = makeTemp('recent-merged-30d-old-accepted');
  try {
    const acceptedAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    await appendEvent(dir, makeEvent('reactor', 'WI-611', 'item.merged', { commit: 'abc611' }, acceptedAt));
    await appendEvent(dir, makeEvent('operator', 'WI-611', 'item.accepted', { by: 'operator' }, acceptedAt));

    const out = await runLoopctl(dir, 'summary', '--json');
    const summary = JSON.parse(out) as { recentMerged30d: Array<{ id: string }> };
    assert.ok(!summary.recentMerged30d.find((r) => r.id === 'WI-611'), 'a 40-day-old accepted item must age out of recentMerged30d');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loopctl summary --json: an unaccepted merged item older than 30 days still appears in recentMerged30d', async () => {
  const dir = makeTemp('recent-merged-30d-old-unaccepted');
  try {
    const mergedAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    await appendEvent(dir, makeEvent('reactor', 'WI-612', 'item.merged', { commit: 'abc612' }, mergedAt));

    const out = await runLoopctl(dir, 'summary', '--json');
    const summary = JSON.parse(out) as { recentMerged30d: Array<{ id: string; accepted: boolean }> };
    const row = summary.recentMerged30d.find((r) => r.id === 'WI-612');
    assert.ok(row, 'an old unaccepted merged item must still appear in recentMerged30d');
    assert.equal(row!.accepted, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loopctl summary --json: a captured-only EXT (no reply yet) is a thread carrying its opening message', async () => {
  const dir = makeTemp('summary-captured-only-thread');
  try {
    // A freshly-captured EXT with NO reply yet — the fold must surface it so the console
    // shows a just-sent intent immediately, not only once a reply exists.
    await appendEvent(dir, makeEvent('operator', 'WI-009', 'item.captured', { source: 'ext:EXT-009', text: 'can we move the weekly sync' }));

    const out = await runLoopctl(dir, 'summary', '--json');
    const summary = JSON.parse(out) as { threads: Array<{ id: string; externalRef?: string; outCount: number; messages: Array<{ direction: string; text: string }> }> };
    const thread = summary.threads.find((t) => t.id === 'WI-009');
    assert.ok(thread, 'a captured-only EXT must appear as a thread');
    assert.equal(thread!.externalRef, 'EXT-009');
    assert.equal(thread!.outCount, 0, 'no reply yet');
    // The opening message (item.captured.text) is projected as the first in-message.
    assert.ok(
      thread!.messages.some((m) => m.direction === 'in' && m.text === 'can we move the weekly sync'),
      `opening captured message missing, got: ${JSON.stringify(thread!.messages)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loopctl summary --json: active[] carries the dispatched branch for a building item', async () => {
  const dir = makeTemp('summary-branch');
  try {
    await appendEvent(dir, makeEvent('cli', 'WI-300', 'item.captured', { source: 'cli', text: 'polish the run card' }));
    await appendEvent(dir, makeEvent('reactor', 'WI-300', 'item.routed', { route: 'build', reply: 'queued' }));
    await appendEvent(dir, makeEvent('reactor', 'WI-300', 'item.queued', { spec: 'polish the run card', touches: 'packages/ui/', model: 'sonnet' }));
    await appendEvent(dir, makeEvent('dispatch', 'WI-300', 'build.dispatched', {
      attempt: 1, worktree: '/tmp/wt-300', branch: 'wi-300-a1', model: 'sonnet', pid: 4242,
    }));

    const out = await runLoopctl(dir, 'summary', '--json');
    const summary = JSON.parse(out) as { active: Array<{ id: string; branch?: string }> };
    const item = summary.active.find((i) => i.id === 'WI-300');
    assert.ok(item, 'WI-300 must be active (building)');
    assert.equal(item!.branch, 'wi-300-a1', 'currentBuild.branch must round-trip as branch');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loopctl summary --json: active[] omits branch when no build has been dispatched (never invent a field)', async () => {
  const dir = makeTemp('summary-no-branch');
  try {
    await appendEvent(dir, makeEvent('cli', 'WI-301', 'item.captured', { source: 'cli', text: 'plain queued item' }));
    await appendEvent(dir, makeEvent('reactor', 'WI-301', 'item.routed', { route: 'build', reply: 'queued' }));
    await appendEvent(dir, makeEvent('reactor', 'WI-301', 'item.queued', { spec: 'plain queued item', touches: 'packages/ui/' }));

    const out = await runLoopctl(dir, 'summary', '--json');
    const summary = JSON.parse(out) as { active: Array<{ id: string; branch?: string }> };
    const item = summary.active.find((i) => i.id === 'WI-301');
    assert.ok(item, 'WI-301 must be active (queued)');
    assert.equal(item!.branch, undefined, 'no build dispatched yet — branch must be absent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loopctl summary --json: active[] carries the scout brief text/at/model for a briefed item', async () => {
  const dir = makeTemp('summary-brief');
  try {
    await appendEvent(dir, makeEvent('cli', 'WI-350', 'item.captured', { source: 'cli', text: 'context manifest item' }));
    await appendEvent(dir, makeEvent('reactor', 'WI-350', 'item.routed', { route: 'build', reply: 'queued' }));
    await appendEvent(dir, makeEvent('reactor', 'WI-350', 'item.queued', { spec: 'context manifest item', touches: 'packages/ui/', model: 'sonnet' }));
    await appendEvent(dir, makeEvent('dispatch', 'WI-350', 'item.briefed', { brief: 'Scope: work-projection.ts evidenceDrill only. Do not touch nav.' }));

    const out = await runLoopctl(dir, 'summary', '--json');
    const summary = JSON.parse(out) as { active: Array<{ id: string; brief?: { text: string; at: string; model?: string } }> };
    const item = summary.active.find((i) => i.id === 'WI-350');
    assert.ok(item, 'WI-350 must be active (queued)');
    assert.ok(item!.brief, 'brief must round-trip');
    assert.equal(item!.brief!.text, 'Scope: work-projection.ts evidenceDrill only. Do not touch nav.');
    assert.equal(item!.brief!.model, 'sonnet');
    assert.ok(item!.brief!.at, 'brief.at timestamp must be present');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loopctl summary --json: active[] omits brief when the item was never briefed (never fabricate a context pack)', async () => {
  const dir = makeTemp('summary-no-brief');
  try {
    await appendEvent(dir, makeEvent('cli', 'WI-351', 'item.captured', { source: 'cli', text: 'unbriefed item' }));
    await appendEvent(dir, makeEvent('reactor', 'WI-351', 'item.routed', { route: 'build', reply: 'queued' }));
    await appendEvent(dir, makeEvent('reactor', 'WI-351', 'item.queued', { spec: 'unbriefed item', touches: 'packages/ui/' }));

    const out = await runLoopctl(dir, 'summary', '--json');
    const summary = JSON.parse(out) as { active: Array<{ id: string; brief?: unknown }> };
    const item = summary.active.find((i) => i.id === 'WI-351');
    assert.ok(item, 'WI-351 must be active (queued)');
    assert.equal(item!.brief, undefined, 'no item.briefed event — brief must be absent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loopctl summary --json: queueBlocking marks a touches-disjoint queued item runnable', async () => {
  const dir = makeTemp('queue-blocking-runnable');
  try {
    await appendEvent(dir, makeEvent('cli', 'WI-310', 'item.captured', { source: 'cli', text: 'a clean queued item' }));
    await appendEvent(dir, makeEvent('reactor', 'WI-310', 'item.routed', { route: 'build', reply: 'queued' }));
    await appendEvent(dir, makeEvent('reactor', 'WI-310', 'item.queued', { spec: 'a clean queued item', touches: 'docs/decisions/' }));

    const out = await runLoopctl(dir, 'summary', '--json');
    const summary = JSON.parse(out) as { queueBlocking: Array<{ id: string; runnable: boolean; reason?: string }> };
    const row = summary.queueBlocking.find((r) => r.id === 'WI-310');
    assert.ok(row, 'WI-310 must appear in queueBlocking');
    assert.equal(row!.runnable, true);
    assert.equal(row!.reason, undefined, 'a runnable item must not carry a reason');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loopctl summary --json: queueBlocking names the in-flight item a touches-overlapping queued item is waiting on', async () => {
  const dir = makeTemp('queue-blocking-touches');
  try {
    // WI-320 is building with touches packages/ui/; WI-321 is queued with an overlapping prefix.
    await appendEvent(dir, makeEvent('cli', 'WI-320', 'item.captured', { source: 'cli', text: 'in-flight build' }));
    await appendEvent(dir, makeEvent('reactor', 'WI-320', 'item.routed', { route: 'build', reply: 'queued' }));
    await appendEvent(dir, makeEvent('reactor', 'WI-320', 'item.queued', { spec: 'in-flight build', touches: 'packages/ui/' }));
    await appendEvent(dir, makeEvent('dispatch', 'WI-320', 'build.dispatched', { attempt: 1, worktree: '/tmp/wt-320', branch: 'wi-320-a1' }));

    await appendEvent(dir, makeEvent('cli', 'WI-321', 'item.captured', { source: 'cli', text: 'overlapping queued item' }));
    await appendEvent(dir, makeEvent('reactor', 'WI-321', 'item.routed', { route: 'build', reply: 'queued' }));
    await appendEvent(dir, makeEvent('reactor', 'WI-321', 'item.queued', { spec: 'overlapping queued item', touches: 'packages/ui/src/projections/' }));

    const out = await runLoopctl(dir, 'summary', '--json');
    const summary = JSON.parse(out) as { queueBlocking: Array<{ id: string; runnable: boolean; reason?: string }> };
    const row = summary.queueBlocking.find((r) => r.id === 'WI-321');
    assert.ok(row, 'WI-321 must appear in queueBlocking');
    assert.equal(row!.runnable, false);
    assert.match(row!.reason ?? '', /waiting on WI-320/, `expected the concrete blocker id, got: ${row!.reason}`);
    assert.match(row!.reason ?? '', /touches packages\/ui/, `expected the overlapping segment, got: ${row!.reason}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loopctl summary --json: queueBlocking flags a breaker-tripped queued item needing a fresh unpark', async () => {
  const dir = makeTemp('queue-blocking-breaker');
  try {
    await appendEvent(dir, makeEvent('cli', 'WI-330', 'item.captured', { source: 'cli', text: 'exhausted item' }, '2026-01-01T00:00:00Z'));
    await appendEvent(dir, makeEvent('reactor', 'WI-330', 'item.routed', { route: 'build', reply: 'queued' }, '2026-01-01T00:00:01Z'));
    // 5 dispatch attempts (BUILDER_BREAKER_N) with no fresh unpark since the last park.
    // Explicit, monotonically increasing timestamps (not Date.now()) so the fold's ts-sort
    // never races real wall-clock resolution under parallel test load.
    for (let attempt = 1; attempt <= 5; attempt++) {
      const queuedTs = `2026-01-01T00:0${attempt}:00Z`;
      const dispatchedTs = `2026-01-01T00:0${attempt}:30Z`;
      const crashedTs = `2026-01-01T00:0${attempt}:45Z`;
      await appendEvent(dir, makeEvent('reactor', 'WI-330', 'item.queued', { spec: 'exhausted item', touches: 'apps/example/src/' }, queuedTs));
      await appendEvent(dir, makeEvent('dispatch', 'WI-330', 'build.dispatched', { attempt, worktree: `/tmp/wt-330-${attempt}`, branch: `wi-330-a${attempt}` }, dispatchedTs));
      await appendEvent(dir, makeEvent('dispatch', 'WI-330', 'build.crashed', { reason: 'boom' }, crashedTs));
    }
    // Park and unpark pinned to the IDENTICAL instant: the real-world case this test targets is
    // a same-millisecond park+unpark collision, where cli.ts's strict `>` must not treat a tied
    // unpark as fresh. (A strictly-later unpark is the separate "fresh unpark clears the breaker"
    // case covered in beats.test.ts.)
    await appendEvent(dir, makeEvent('dispatch', 'WI-330', 'item.parked', { reason: 'breaker: 5 attempts exhausted', parkKind: 'ops' }, '2026-01-01T00:06:00Z'));
    await appendEvent(dir, makeEvent('operator', 'WI-330', 'item.unparked', { by: 'operator' }, '2026-01-01T00:06:00Z'));
    // Re-queued after unpark but NOT re-parked since — still breaker-tripped per dispatch.ts's own check.

    const out = await runLoopctl(dir, 'summary', '--json');
    const summary = JSON.parse(out) as { queueBlocking: Array<{ id: string; runnable: boolean; reason?: string }> };
    const row = summary.queueBlocking.find((r) => r.id === 'WI-330');
    assert.ok(row, 'WI-330 must appear in queueBlocking');
    assert.equal(row!.runnable, false);
    assert.match(row!.reason ?? '', /5 attempts.*fresh unpark/, `expected the breaker reason, got: ${row!.reason}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loopctl summary --json: queueBlocking surfaces a parked item with its park reason', async () => {
  const dir = makeTemp('queue-blocking-parked');
  try {
    await appendEvent(dir, makeEvent('cli', 'WI-340', 'item.captured', { source: 'cli', text: 'parked item' }));
    await appendEvent(dir, makeEvent('reactor', 'WI-340', 'item.routed', { route: 'build', reply: 'queued' }));
    await appendEvent(dir, makeEvent('reactor', 'WI-340', 'item.queued', { spec: 'parked item', touches: 'docs/decisions/' }));
    await appendEvent(dir, makeEvent('dispatch', 'WI-340', 'item.parked', { reason: 'touches spine — needs your call', parkKind: 'decision' }));

    const out = await runLoopctl(dir, 'summary', '--json');
    const summary = JSON.parse(out) as { queueBlocking: Array<{ id: string; runnable: boolean; reason?: string }> };
    const row = summary.queueBlocking.find((r) => r.id === 'WI-340');
    assert.ok(row, 'WI-340 must appear in queueBlocking');
    assert.equal(row!.runnable, false);
    assert.equal(row!.reason, 'parked: touches spine — needs your call');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loopctl summary --json: queueBlocking is empty when the queue is empty', async () => {
  const dir = makeTemp('queue-blocking-empty');
  try {
    const out = await runLoopctl(dir, 'summary', '--json');
    const summary = JSON.parse(out) as { queueBlocking: unknown[] };
    assert.deepEqual(summary.queueBlocking, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loopctl new --source ext:EXT-042: stamps the ext origin (importer dedup key) and actor "operator"', async () => {
  const dir = makeTemp('new-source');
  try {
    const out = await runLoopctl(dir, 'new', 'console intent', '--source', 'ext:EXT-042');
    assert.ok(out.includes('Created WI-001'), `expected "Created WI-001", got: ${out}`);

    const events = await loadAllEvents(dir);
    const cap = events.find(e => e.type === 'item.captured' && e.item === 'WI-001');
    assert.ok(cap, 'item.captured must be in ledger');
    // buildLegacyToWiMap keys on data.source — this is what lets the reactor sync skip re-capture.
    assert.equal((cap!.data as { source: string }).source, 'ext:EXT-042');
    assert.equal((cap!.data as { text: string }).text, 'console intent');
    // Mirrors the importer's attribution for operator-originated captures.
    assert.equal(cap!.actor, 'operator');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// accept verb tests
// ---------------------------------------------------------------------------

test('loopctl accept WI-001: merged item transitions to accepted state, emits item.accepted + msg.in', async () => {
  const dir = makeTemp('accept-merged');
  try {
    // Seed a merged item
    await appendEvent(dir, makeEvent('reactor', 'WI-001', 'item.merged', { commit: 'abc123' }));

    const out = await runLoopctl(dir, 'accept', 'WI-001');
    assert.ok(out.includes('Accepted WI-001'), `expected "Accepted WI-001", got: ${out}`);

    const events = await loadAllEvents(dir);
    const result = fold(events);
    const rec = result.items.get('WI-001');
    assert.ok(rec, 'WI-001 must exist in fold');
    assert.equal(rec.state, 'accepted');

    const accepted = events.find(e => e.type === 'item.accepted' && e.item === 'WI-001');
    assert.ok(accepted, 'item.accepted event must be in ledger');
    assert.equal((accepted!.data as { by: string }).by, 'operator');

    const msgIn = events.find(e => e.type === 'msg.in' && e.item === 'WI-001');
    assert.ok(msgIn, 'msg.in trail event must be in ledger');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loopctl accept WI-001 on non-merged item: is a no-op, emits NO item.accepted', async () => {
  const dir = makeTemp('accept-non-merged');
  try {
    // Seed a captured (non-merged) item
    await appendEvent(dir, makeEvent('test', 'WI-001', 'item.captured', { source: 'cli', text: 'not merged yet' }));

    const out = await runLoopctl(dir, 'accept', 'WI-001');
    assert.ok(out.includes('no-op'), `expected "no-op" message, got: ${out}`);

    const events = await loadAllEvents(dir);
    const accepted = events.find(e => e.type === 'item.accepted' && e.item === 'WI-001');
    assert.equal(accepted, undefined, 'item.accepted must NOT be emitted for a non-merged item');

    const result = fold(events);
    const rec = result.items.get('WI-001');
    // State unchanged
    assert.equal(rec?.state, 'captured');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loopctl accept WI-001: --trail text appears in msg.in event', async () => {
  const dir = makeTemp('accept-trail');
  try {
    await appendEvent(dir, makeEvent('reactor', 'WI-001', 'item.merged', { commit: 'abc123' }));

    await runLoopctl(dir, 'accept', 'WI-001', '--trail', '✅ accept WI-001');

    const events = await loadAllEvents(dir);
    const msgIn = events.find(e => e.type === 'msg.in' && e.item === 'WI-001');
    assert.ok(msgIn, 'msg.in must be written');
    assert.equal((msgIn!.data as { text: string }).text, '✅ accept WI-001');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loopctl events --item WI-001 --json: returns only events for that item in RawEvent shape, oldest-first', async () => {
  const dir = makeTemp('events-item');
  try {
    await appendEvent(dir, makeEvent('test', 'WI-001', 'item.captured', { source: 'cli', text: 'events test' }));
    await appendEvent(dir, makeEvent('reactor', 'WI-001', 'item.queued', { spec: 'build the thing' }));
    // A second item's event must NOT appear in the output
    await appendEvent(dir, makeEvent('test', 'WI-002', 'item.captured', { source: 'cli', text: 'other item' }));

    const out = await runLoopctl(dir, 'events', '--item', 'WI-001', '--json');
    const events = JSON.parse(out) as Array<{ id: string; ts: string; actor: string; item: string; type: string; data: Record<string, unknown> }>;

    assert.ok(Array.isArray(events), 'output must be a JSON array');
    assert.equal(events.length, 2, 'must return exactly 2 events for WI-001');
    assert.ok(events.every(e => e.item === 'WI-001'), 'all events must be for WI-001');
    assert.ok(events.every(e => typeof e.id === 'string' && typeof e.ts === 'string' && typeof e.type === 'string'), 'RawEvent shape: id, ts, type must be strings');
    assert.equal(events[0]!.type, 'item.captured', 'first event must be item.captured (oldest-first)');
    assert.equal(events[1]!.type, 'item.queued', 'second event must be item.queued');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loopctl state: quarantined invalid id produces no stderr warning on the CLI path', async () => {
  const dir = makeTemp('quarantine-state');
  try {
    // Write an event with a UUID id (a legacy id style) that fails validateEvent
    const badId = 'f6217bf7-c67c-4842-8daf-c132321d8cad';
    const badLine = JSON.stringify({
      id: badId,
      ts: '2026-07-10T08:31:34.021Z',
      actor: 'console',
      item: 'WI-121',
      type: 'item.unparked',
      data: { by: 'operator' },
    });
    writeFileSync(join(dir, 'work-2026-07.jsonl'), badLine + '\n');
    // Quarantine the bad id so warnings are suppressed
    writeFileSync(join(dir, 'quarantine.json'), JSON.stringify({ ids: [badId], _note: 'test fixture' }));

    const { stderr } = await execFileAsync(process.execPath, [CLI, 'state'], {
      env: { ...process.env, LOOPKIT_LEDGER: dir },
    });
    const warnings = (stderr ?? '').split('\n').filter(l => l.includes(badId));
    assert.equal(warnings.length, 0, `expected no stderr warnings for quarantined id ${badId}, got:\n${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
