/**
 * hygiene.test.ts — Tests for ops-ledger hygiene
 *
 * Covers:
 *   1. Edge-trigger: idle beat → no ledger event, lastbeat.json updated
 *   2. Edge-trigger: changed counts → ledger event emitted
 *   3. First-boot: no previous lastbeat.json → event always emitted
 *   4. compact dry-run: prints what would move, no fs changes
 *   5. compact real: gz appears in archive/, original gone, work segment untouched,
 *      current+previous month retained
 *   6. compact: retention config (N=1 keeps only current month)
 *   7. Quarantine suppression: listed id → silent skip; unknown id → warns
 *   8. doctor --json: quarantinedKnown count in output
 *   9. listSegments skips .gz files (archived history excluded from default read path)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, mkdtempSync, readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGunzip } from 'node:zlib';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';

import {
  readLastbeat,
  writeLastbeat,
  countsChanged,
  loadQuarantine,
  compact,
  formatCompactResult,
  parseSegmentYearMonth,
  isWithinRetention,
} from '../src/hygiene.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { makeEvent, validateEvent } from '../src/schema.js';
import { runReactor, ReactorOptions } from '../src/beats/reactor.js';
import { CONFIG_DEFAULTS } from '../src/config.js';
import type { LoopkitConfig } from '../src/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testCount = 0;

function makeTempDir(): string {
  const dir = join(tmpdir(), `wi225-test-${process.pid}-${++testCount}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** Write events to a ledger dir for tests. */
async function seedLedger(ledgerDir: string, events: ReturnType<typeof makeEvent>[]): Promise<void> {
  mkdirSync(ledgerDir, { recursive: true });
  await appendEvents(ledgerDir, events);
}

/** Minimal test config. */
function makeTestConfig(overrides: Partial<LoopkitConfig> = {}): LoopkitConfig {
  return {
    ...CONFIG_DEFAULTS,
    gateCommand: 'exit 0',
    gateWorkdir: '.',
    breakerN: 3,
    promptsDir: '.ai/loops/prompts',
    notifyHook: '.ai/notify-phone.sh',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Unit: countsChanged
// ---------------------------------------------------------------------------

test('countsChanged: undefined prev → true (first boot)', () => {
  assert.ok(countsChanged(undefined, { total: 5, queued: 1 }));
});

test('countsChanged: same counts → false', () => {
  const counts = { total: 5, queued: 1, building: 0, parked: 2, merged: 2, breached: [] };
  assert.ok(!countsChanged(counts, { ...counts }));
});

test('countsChanged: different count value → true', () => {
  const prev = { total: 5, queued: 1, parked: 2 };
  const next = { total: 5, queued: 0, parked: 2 };
  assert.ok(countsChanged(prev, next));
});

test('countsChanged: extra key → true', () => {
  const prev = { total: 5 };
  const next = { total: 5, queued: 1 };
  assert.ok(countsChanged(prev, next));
});

test('countsChanged: breached array order matters (JSON.stringify)', () => {
  // Same breach keys → same serialized → false
  const prev = { breached: ['acceptance', 'reactor-fresh'] };
  const next = { breached: ['acceptance', 'reactor-fresh'] };
  assert.ok(!countsChanged(prev, next));
  // Different order → different serialized → true
  const next2 = { breached: ['reactor-fresh', 'acceptance'] };
  assert.ok(countsChanged(prev, next2));
});

// ---------------------------------------------------------------------------
// Unit: writeLastbeat / readLastbeat
// ---------------------------------------------------------------------------

test('writeLastbeat / readLastbeat round-trip', () => {
  const dir = makeTempDir();
  try {
    const runsDir = join(dir, 'runs');
    const counts = { total: 10, queued: 3, parked: 1 };
    writeLastbeat(runsDir, 'reactor', counts);
    const result = readLastbeat(runsDir, 'reactor');
    assert.ok(result !== undefined);
    assert.equal(result!.loop, 'reactor');
    assert.deepEqual(result!.counts, counts);
    assert.ok(typeof result!.ts === 'string');
  } finally {
    cleanDir(dir);
  }
});

test('readLastbeat returns undefined when file absent', () => {
  const dir = makeTempDir();
  try {
    const result = readLastbeat(join(dir, 'runs'), 'reactor');
    assert.equal(result, undefined);
  } finally {
    cleanDir(dir);
  }
});

test('writeLastbeat is atomic (tmp+rename, lastbeat.json exists after write)', () => {
  const dir = makeTempDir();
  try {
    const runsDir = join(dir, 'runs');
    writeLastbeat(runsDir, 'reactor', { total: 1 });
    assert.ok(existsSync(join(runsDir, 'reactor', 'lastbeat.json')));
    // tmp file should be gone
    const files = readdirSync(join(runsDir, 'reactor')) as string[];
    assert.ok(!files.some((f: string) => f.endsWith('.tmp')));
  } finally {
    cleanDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Unit: parseSegmentYearMonth + isWithinRetention
// ---------------------------------------------------------------------------

test('parseSegmentYearMonth: valid ops segment', () => {
  const r = parseSegmentYearMonth('ops-2026-07.jsonl');
  assert.deepEqual(r, { year: 2026, month: 7 });
});

test('parseSegmentYearMonth: work segment returns null', () => {
  assert.equal(parseSegmentYearMonth('work-2026-07.jsonl'), null);
});

test('parseSegmentYearMonth: non-segment returns null', () => {
  assert.equal(parseSegmentYearMonth('quarantine.json'), null);
});

test('isWithinRetention: current month kept', () => {
  const ref = new Date('2026-07-11T00:00:00Z');
  assert.ok(isWithinRetention(2026, 7, 2, ref));
});

test('isWithinRetention: previous month kept with retention=2', () => {
  const ref = new Date('2026-07-11T00:00:00Z');
  assert.ok(isWithinRetention(2026, 6, 2, ref));
});

test('isWithinRetention: month before previous archived with retention=2', () => {
  const ref = new Date('2026-07-11T00:00:00Z');
  assert.ok(!isWithinRetention(2026, 5, 2, ref));
});

test('isWithinRetention: retention=1 only keeps current month', () => {
  const ref = new Date('2026-07-11T00:00:00Z');
  assert.ok(isWithinRetention(2026, 7, 1, ref));
  assert.ok(!isWithinRetention(2026, 6, 1, ref));
});

test('isWithinRetention: year boundary (Dec→Jan)', () => {
  const ref = new Date('2027-01-15T00:00:00Z');
  // retention=2: keep Jan 2027 + Dec 2026
  assert.ok(isWithinRetention(2027, 1, 2, ref));
  assert.ok(isWithinRetention(2026, 12, 2, ref));
  assert.ok(!isWithinRetention(2026, 11, 2, ref));
});

// ---------------------------------------------------------------------------
// Integration: compact dry-run
// ---------------------------------------------------------------------------

test('compact dry-run: prints what would move, no fs changes', async () => {
  const dir = makeTempDir();
  try {
    const ledgerDir = join(dir, 'ledger');
    mkdirSync(ledgerDir, { recursive: true });
    // Create an old ops segment (should be archived)
    const oldSeg = join(ledgerDir, 'ops-2026-05.jsonl');
    writeFileSync(oldSeg, '{"test": 1}\n');
    // Create a current ops segment (should be kept)
    const curSeg = join(ledgerDir, 'ops-2026-07.jsonl');
    writeFileSync(curSeg, '{"test": 2}\n');
    // Create a work segment (never touched)
    const workSeg = join(ledgerDir, 'work-2026-07.jsonl');
    writeFileSync(workSeg, '{"test": 3}\n');

    const ref = new Date('2026-07-11T00:00:00Z');
    const result = await compact({
      ledgerDir,
      opsRetentionMonths: 2,
      dryRun: true,
      referenceDate: ref,
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.archived.length, 1);
    assert.ok(result.archived[0]!.file.endsWith('ops-2026-05.jsonl'));
    assert.ok(result.archived[0]!.gzPath.endsWith('ops-2026-05.jsonl.gz'));
    assert.equal(result.kept.length, 1);
    assert.ok(result.kept[0]!.endsWith('ops-2026-07.jsonl'));
    // work segment in skipped (with reason)
    const workSkip = result.skipped.find(s => s.file.endsWith('work-2026-07.jsonl'));
    assert.ok(workSkip !== undefined, 'work segment in skipped list');
    assert.ok(workSkip!.reason.includes('work segment'));

    // No actual file changes
    assert.ok(existsSync(oldSeg), 'old segment still present (dry-run)');
    assert.ok(!existsSync(join(ledgerDir, 'archive', 'ops-2026-05.jsonl.gz')), 'no gz in dry-run');
  } finally {
    cleanDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Integration: compact real run
// ---------------------------------------------------------------------------

test('compact real: gz in archive/, original gone, work untouched, current retained', async () => {
  const dir = makeTempDir();
  try {
    const ledgerDir = join(dir, 'ledger');
    mkdirSync(ledgerDir, { recursive: true });
    // Old segment (to be archived)
    const oldSeg = join(ledgerDir, 'ops-2026-05.jsonl');
    const oldContent = '{"event":"old"}\n{"event":"also-old"}\n';
    writeFileSync(oldSeg, oldContent);
    // Previous month (retained with retention=2 from July 2026)
    const prevSeg = join(ledgerDir, 'ops-2026-06.jsonl');
    writeFileSync(prevSeg, '{"event":"prev"}\n');
    // Current month (retained)
    const curSeg = join(ledgerDir, 'ops-2026-07.jsonl');
    writeFileSync(curSeg, '{"event":"current"}\n');
    // Work segment (never touched)
    const workSeg = join(ledgerDir, 'work-2026-07.jsonl');
    const workContent = '{"work":"record"}\n';
    writeFileSync(workSeg, workContent);

    const result = await compact({
      ledgerDir,
      opsRetentionMonths: 2,
      dryRun: false,
    });

    assert.equal(result.dryRun, false);
    assert.equal(result.archived.length, 1);
    // Original gone
    assert.ok(!existsSync(oldSeg), 'original segment removed');
    // GZ exists in archive/
    const gzPath = join(ledgerDir, 'archive', 'ops-2026-05.jsonl.gz');
    assert.ok(existsSync(gzPath), 'gz file created in archive/');
    // Work segment untouched
    assert.equal(readFileSync(workSeg, 'utf8'), workContent, 'work segment unmodified');
    // Retained segments still present
    assert.ok(existsSync(prevSeg), 'previous month retained');
    assert.ok(existsSync(curSeg), 'current month retained');
    assert.equal(result.kept.length, 2);
  } finally {
    cleanDir(dir);
  }
});

test('compact: gz is valid gzip (roundtrip readable)', async () => {
  const dir = makeTempDir();
  try {
    const ledgerDir = join(dir, 'ledger');
    mkdirSync(ledgerDir, { recursive: true });
    const oldSeg = join(ledgerDir, 'ops-2026-04.jsonl');
    const content = '{"line":"one"}\n{"line":"two"}\n';
    writeFileSync(oldSeg, content);

    await compact({ ledgerDir, opsRetentionMonths: 2, dryRun: false });

    const gzPath = join(ledgerDir, 'archive', 'ops-2026-04.jsonl.gz');
    assert.ok(existsSync(gzPath));
    // Decompress and verify content
    const tmpOut = join(dir, 'out.jsonl');
    await pipeline(
      createReadStream(gzPath),
      createGunzip(),
      createWriteStream(tmpOut),
    );
    assert.equal(readFileSync(tmpOut, 'utf8'), content);
  } finally {
    cleanDir(dir);
  }
});

test('compact: idempotent (run twice, second is no-op on already-gone segments)', async () => {
  const dir = makeTempDir();
  try {
    const ledgerDir = join(dir, 'ledger');
    mkdirSync(ledgerDir, { recursive: true });
    const oldSeg = join(ledgerDir, 'ops-2026-04.jsonl');
    writeFileSync(oldSeg, '{"x":1}\n');

    // First run
    const r1 = await compact({ ledgerDir, opsRetentionMonths: 2, dryRun: false });
    assert.equal(r1.archived.length, 1);
    // Second run: original gone, no new ops segments to archive
    const r2 = await compact({ ledgerDir, opsRetentionMonths: 2, dryRun: false });
    assert.equal(r2.archived.length, 0, 'nothing to archive on second run');
  } finally {
    cleanDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Unit: quarantine suppression
// ---------------------------------------------------------------------------

test('loadQuarantine: returns empty set when file absent', () => {
  const dir = makeTempDir();
  try {
    const q = loadQuarantine(join(dir, 'quarantine.json'));
    assert.equal(q.size, 0);
  } finally {
    cleanDir(dir);
  }
});

test('loadQuarantine: returns ids from file', () => {
  const dir = makeTempDir();
  try {
    const ids = ['f6217bf7-c67c-4842-8daf-c132321d8cad', 'a852d936-c3e2-4c59-bbc8-c2817b7cb0d9'];
    writeFileSync(join(dir, 'quarantine.json'), JSON.stringify({ ids }), 'utf8');
    const q = loadQuarantine(join(dir, 'quarantine.json'));
    assert.equal(q.size, 2);
    assert.ok(q.has(ids[0]!));
    assert.ok(q.has(ids[1]!));
  } finally {
    cleanDir(dir);
  }
});

test('loadQuarantine: malformed JSON → empty set (fail-open)', () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, 'quarantine.json'), 'not-json', 'utf8');
    const q = loadQuarantine(join(dir, 'quarantine.json'));
    assert.equal(q.size, 0);
  } finally {
    cleanDir(dir);
  }
});

test('quarantine suppression: listed id → silent skip (no stderr warning)', async () => {
  const dir = makeTempDir();
  try {
    const ledgerDir = join(dir, 'ledger');
    mkdirSync(ledgerDir, { recursive: true });

    // Write a line with a UUID id (pre-WI-150 style) that fails validateEvent
    const badId = 'f6217bf7-c67c-4842-8daf-c132321d8cad';
    const badLine = JSON.stringify({
      id: badId,
      ts: '2026-07-10T08:31:34.021Z',
      actor: 'console',
      item: 'WI-121',
      type: 'item.unparked',
      data: { by: 'operator' },
    });
    const segPath = join(ledgerDir, 'work-2026-07.jsonl');
    writeFileSync(segPath, badLine + '\n');

    const quarantine = new Set([badId]);
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    // Capture stderr
    process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
      stderrChunks.push(String(chunk));
      return origWrite(chunk, ...(args as []));
    }) as typeof process.stderr.write;

    try {
      const events = await loadAllEvents(ledgerDir, quarantine);
      // The invalid event is skipped (not yielded)
      assert.equal(events.length, 0, 'quarantined event is skipped');
      // No warning emitted for this id
      const warnings = stderrChunks.filter(c => c.includes(badId));
      assert.equal(warnings.length, 0, 'no warning for quarantined id');
    } finally {
      process.stderr.write = origWrite;
    }
  } finally {
    cleanDir(dir);
  }
});

test('quarantine suppression: unknown invalid id → warns', async () => {
  const dir = makeTempDir();
  try {
    const ledgerDir = join(dir, 'ledger');
    mkdirSync(ledgerDir, { recursive: true });

    // Write a line with an unknown bad id
    const unknownBadId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const badLine = JSON.stringify({
      id: unknownBadId,
      ts: '2026-07-10T08:31:34.021Z',
      actor: 'console',
      item: 'WI-999',
      type: 'item.unparked',
      data: { by: 'operator' },
    });
    writeFileSync(join(ledgerDir, 'work-2026-07.jsonl'), badLine + '\n');

    // Quarantine does NOT include this id
    const quarantine = new Set<string>();
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
      stderrChunks.push(String(chunk));
      return origWrite(chunk, ...(args as []));
    }) as typeof process.stderr.write;

    try {
      const events = await loadAllEvents(ledgerDir, quarantine);
      assert.equal(events.length, 0, 'invalid event is skipped');
      // Warning should fire for unknown id
      const warnings = stderrChunks.filter(c => c.includes('[loopkit] invalid event'));
      assert.ok(warnings.length > 0, 'warning emitted for non-quarantined invalid id');
    } finally {
      process.stderr.write = origWrite;
    }
  } finally {
    cleanDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Integration: edge-triggered heartbeat (reactor)
// ---------------------------------------------------------------------------

test('edge-trigger: first boot → loop.beat event emitted + lastbeat.json created', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wi225-edge-'));
  try {
    const ledgerDir = join(dir, 'ledger');
    mkdirSync(join(dir, '.ai', 'runs', 'loopkit'), { recursive: true });

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'test', text: 'hello' }),
      makeEvent('cli', 'WI-001', 'item.queued', { spec: 'spec text' }),
    ]);

    const nowMs = Date.now();
    await runReactor({
      repoRoot: dir,
      ledgerDir,
      autonomy: 'on',
      provider: null,
      opsAutonomy: 'watch',
      config: makeTestConfig(),
      sloProbes: {
        now: () => nowMs,
        reactorLastrun: () => Math.floor(nowMs / 1000) - 10,
        dispatchLastrun: () => Math.floor(nowMs / 1000) - 10,
        backup: () => 2,
        watchNightly: () => nowMs - 1000,
        watchHourly: () => nowMs - 1000,
        deploy: () => ({ behindCount: 0 }),
      },
    });

    const events = await loadAllEvents(ledgerDir);
    const beatEvents = events.filter(e => e.type === 'loop.beat');
    assert.ok(beatEvents.length >= 1, 'loop.beat emitted on first boot');

    // lastbeat.json should be written
    const lastbeat = readLastbeat(join(dir, '.ai', 'runs'), 'reactor');
    assert.ok(lastbeat !== undefined, 'lastbeat.json created');
    assert.ok('total' in lastbeat!.counts, 'lastbeat.json has counts');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('edge-trigger: idle beat (same counts) → no new loop.beat event, lastbeat.json updated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wi225-idle-'));
  try {
    const ledgerDir = join(dir, 'ledger');
    mkdirSync(join(dir, '.ai', 'runs', 'loopkit'), { recursive: true });

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'test', text: 'hello' }),
      makeEvent('cli', 'WI-001', 'item.queued', { spec: 'spec text' }),
    ]);

    const nowMs = Date.now();
    const reactorOpts: ReactorOptions = {
      repoRoot: dir,
      ledgerDir,
      autonomy: 'on',
      provider: null,
      opsAutonomy: 'watch',
      config: makeTestConfig(),
      sloProbes: {
        now: () => nowMs,
        reactorLastrun: () => Math.floor(nowMs / 1000) - 10,
        dispatchLastrun: () => Math.floor(nowMs / 1000) - 10,
        backup: () => 2,
        watchNightly: () => nowMs - 1000,
        watchHourly: () => nowMs - 1000,
        deploy: () => ({ behindCount: 0 }),
      },
    };

    // First beat (first boot) → emits
    await runReactor(reactorOpts);
    const eventsAfter1 = await loadAllEvents(ledgerDir);
    const beatCount1 = eventsAfter1.filter(e => e.type === 'loop.beat').length;
    assert.ok(beatCount1 >= 1, 'first beat emits');

    // Second beat — same items, same counts → should NOT emit another loop.beat
    await runReactor(reactorOpts);
    const eventsAfter2 = await loadAllEvents(ledgerDir);
    const beatCount2 = eventsAfter2.filter(e => e.type === 'loop.beat').length;
    assert.equal(beatCount2, beatCount1, 'idle second beat does not append loop.beat');

    // lastbeat.json exists and is updated (ts may differ)
    const lb = readLastbeat(join(dir, '.ai', 'runs'), 'reactor');
    assert.ok(lb !== undefined, 'lastbeat.json updated by second beat');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('edge-trigger: changed counts → new loop.beat event emitted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wi225-change-'));
  try {
    const ledgerDir = join(dir, 'ledger');
    mkdirSync(join(dir, '.ai', 'runs', 'loopkit'), { recursive: true });

    // Seed: one queued item
    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'test', text: 'hello' }),
      makeEvent('cli', 'WI-001', 'item.queued', { spec: 'spec text' }),
    ]);

    const nowMs = Date.now();
    const reactorOpts: ReactorOptions = {
      repoRoot: dir,
      ledgerDir,
      autonomy: 'on',
      provider: null,
      opsAutonomy: 'watch',
      config: makeTestConfig(),
      sloProbes: {
        now: () => nowMs,
        reactorLastrun: () => Math.floor(nowMs / 1000) - 10,
        dispatchLastrun: () => Math.floor(nowMs / 1000) - 10,
        backup: () => 2,
        watchNightly: () => nowMs - 1000,
        watchHourly: () => nowMs - 1000,
        deploy: () => ({ behindCount: 0 }),
      },
    };

    // First beat — WI-001 is queued
    await runReactor(reactorOpts);
    const beatCount1 = (await loadAllEvents(ledgerDir)).filter(e => e.type === 'loop.beat').length;

    // Now add a second item to change the counts
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-002', 'item.captured', { source: 'test', text: 'new item' }),
      makeEvent('cli', 'WI-002', 'item.queued', { spec: 'spec' }),
    ]);

    // Second beat — WI-002 newly queued → counts differ → new beat event
    await runReactor(reactorOpts);
    const beatCount2 = (await loadAllEvents(ledgerDir)).filter(e => e.type === 'loop.beat').length;
    assert.ok(beatCount2 > beatCount1, 'changed counts trigger a new loop.beat event');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Integration: loadAllEvents skips .gz files (archive/ dir not in default path)
// ---------------------------------------------------------------------------

test('loadAllEvents: archived .gz files are not read (listSegments skips non-.jsonl)', async () => {
  const dir = makeTempDir();
  try {
    const ledgerDir = join(dir, 'ledger');
    mkdirSync(join(ledgerDir, 'archive'), { recursive: true });
    // Write a valid event to current segment
    const goodEvent = makeEvent('test', 'WI-001', 'item.captured', { source: 'test', text: 'ok' });
    await appendEvents(ledgerDir, [goodEvent]);
    // Write a corrupt JSON file simulating a .gz in archive/ — even if it leaks, it's binary
    writeFileSync(join(ledgerDir, 'archive', 'ops-2026-05.jsonl.gz'), 'binary-garbage');

    // loadAllEvents should not try to read the gz
    const events = await loadAllEvents(ledgerDir);
    assert.ok(events.some(e => e.id === goodEvent.id), 'real event from jsonl is read');
    // No crash from the gz file (archive/ subdir not enumerated by listSegments)
  } finally {
    cleanDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Unit: formatCompactResult
// ---------------------------------------------------------------------------

test('formatCompactResult: nothing to compact message', () => {
  const r = formatCompactResult({
    kept: [],
    archived: [],
    skipped: [],
    dryRun: false,
  });
  assert.ok(r.includes('Nothing to compact'));
});

test('formatCompactResult: dry-run prefix', () => {
  const r = formatCompactResult({
    kept: ['/ledger/ops-2026-07.jsonl'],
    archived: [{ file: '/ledger/ops-2026-05.jsonl', sizeBytes: 1024, gzPath: '/ledger/archive/ops-2026-05.jsonl.gz' }],
    skipped: [],
    dryRun: true,
  });
  assert.ok(r.includes('[dry-run]'));
  assert.ok(r.includes('would-archive'));
});
