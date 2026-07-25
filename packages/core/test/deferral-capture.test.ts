/**
 * deferral-capture.test.ts — WI-177: successful-but-partial delivery reaches the board.
 *
 * A build worker that finds its item mis-scoped ships the smallest safe slice and states the
 * remainder in the manifest's STRUCTURED `deferred` field. Before this slice the remainder lived
 * only in the run directory (free-text `notes`), so the item closed `merged` with nothing on the
 * board saying work was outstanding.
 *
 * Covers:
 *   parser   — `deferred` is typed and its honest-negative vocabulary reads as absent
 *   contract — free-text `notes` is NEVER the source of a capture
 *   prompt   — the manifest template teaches the field
 *   e2e      — a merged parent with a deferral mints ONE child, `item.captured` and nothing else
 *   e2e      — no deferral ⇒ no child (byte-identical to pre-slice behaviour)
 *   idempot. — the `deferral:<parent>` stamp means a re-run never mints a second child
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { makeEvent, LedgerEvent } from '../src/schema.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import {
  runDispatch, parseManifest, WorkerManifest,
  captureDeferralChildren, deferralSourceStamp, MANIFEST_INSTRUCTION,
} from '../src/beats/dispatch.js';
import { fold } from '../src/fold.js';
import { LlmProvider, ProviderRequest, ProviderResult } from '../src/providers/types.js';
import { LoopkitConfig, CONFIG_DEFAULTS } from '../src/config.js';

let testCount = 0;
function makeTempDir(): string {
  const dir = join(tmpdir(), `loopkit-wi177-${process.pid}-${++testCount}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function cleanDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function makeTestConfig(overrides: Partial<LoopkitConfig> = {}): LoopkitConfig {
  return {
    ...CONFIG_DEFAULTS,
    gateCommand: 'exit 0',
    gateWorkdir: '.',
    breakerN: 5,
    promptsDir: '.ai/loops/prompts',
    notifyHook: '.ai/notify-phone.sh',
    salvage: { enabled: false, maxPatchKb: 256 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseManifest — the structured field and its honest-negative vocabulary
// ---------------------------------------------------------------------------

test('parseManifest: a non-empty `deferred` is carried through as a typed field', () => {
  const m = parseManifest(JSON.stringify({
    wi: 'WI-001', filesTouched: ['src/a.ts'], testsAdded: [], confidence: 0.6,
    notes: 'shipped slice 1 of 3',
    deferred: 'slices 2 and 3: the projection rewrite and its screen',
  }));
  assert.equal(m?.deferred, 'slices 2 and 3: the projection rewrite and its screen');
});

test('parseManifest: an absent, blank, "none" or unfilled-placeholder `deferred` reads as nothing outstanding', () => {
  const base = { wi: 'WI-001', filesTouched: [], testsAdded: [], confidence: 1, notes: 'n' };
  for (const value of [undefined, '', '   ', 'none', 'None.', 'n/a', 'nothing', '-', 42, { a: 1 }, ['x']]) {
    const m = parseManifest(JSON.stringify({ ...base, deferred: value }));
    assert.equal(m?.deferred, undefined, `deferred=${JSON.stringify(value)} must not mint a phantom child`);
  }
  // The prompt's own placeholder, echoed back unfilled.
  const echoed = parseManifest(JSON.stringify({ ...base, deferred: '<optional: the outstanding work you deliberately did NOT ship>' }));
  assert.equal(echoed?.deferred, undefined, 'an unfilled template placeholder is not a deferral');
});

test('parseManifest: free-text `notes` is NEVER read as a deferral (structured field only)', () => {
  const m = parseManifest(JSON.stringify({
    wi: 'WI-001', filesTouched: [], testsAdded: [], confidence: 0.4,
    notes: 'DEFERRED: the whole second half of this item is outstanding, please re-queue it',
  }));
  assert.equal(m?.deferred, undefined, 'prose in notes must not become a work item — the field is the contract');
});

test('MANIFEST_INSTRUCTION teaches the deferral field and says it is captured, not queued', () => {
  assert.match(MANIFEST_INSTRUCTION, /"deferred"/);
  assert.match(MANIFEST_INSTRUCTION, /not queued/i);
});

// ---------------------------------------------------------------------------
// captureDeferralChildren — the capture terminal
// ---------------------------------------------------------------------------

test('captureDeferralChildren: mints ONE captured child per parent, never queues it', async () => {
  const ledgerDir = makeTempDir();
  try {
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'big item' }),
      makeEvent('cli', 'WI-001', 'item.queued', { spec: 'big item' }),
      makeEvent('dispatch', 'WI-001', 'item.merged', { commit: 'abc1234', deployed: false }),
    ]);

    const ids = await captureDeferralChildren(ledgerDir, [
      { parentId: 'WI-001', deferred: 'the projection and its screen' },
    ]);
    assert.equal(ids.length, 1);

    const events = await loadAllEvents(ledgerDir);
    const childEvents = events.filter(e => e.item === ids[0]);
    assert.equal(childEvents.length, 1, 'exactly ONE event on the child — capture and nothing else');
    assert.equal(childEvents[0]!.type, 'item.captured');
    const data = childEvents[0]!.data as { source?: string; text?: string };
    assert.equal(data.source, deferralSourceStamp('WI-001'));
    assert.match(data.text ?? '', /WI-001/, 'the child must cite the parent WI');
    assert.match(data.text ?? '', /the projection and its screen/, 'the child must carry the deferral text');

    const rec = fold(events).items.get(ids[0]!)!;
    assert.equal(rec.state, 'captured', 'the child enters INTAKE — a human or routing decides, never auto-queued');
  } finally {
    cleanDir(ledgerDir);
  }
});

test('captureDeferralChildren: the deferral:<parent> stamp makes a repeat call a no-op', async () => {
  const ledgerDir = makeTempDir();
  try {
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'big item' }),
      makeEvent('cli', 'WI-001', 'item.queued', { spec: 'big item' }),
    ]);
    const first = await captureDeferralChildren(ledgerDir, [{ parentId: 'WI-001', deferred: 'remainder' }]);
    const second = await captureDeferralChildren(ledgerDir, [{ parentId: 'WI-001', deferred: 'remainder' }]);
    assert.equal(first.length, 1);
    assert.equal(second.length, 0, 'a re-run (crash/replay) must never mint a duplicate remainder item');
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.type === 'item.captured' && (e.data as { source?: string }).source?.startsWith('deferral:')).length, 1);
  } finally {
    cleanDir(ledgerDir);
  }
});

test('captureDeferralChildren: an empty list writes nothing at all', async () => {
  const ledgerDir = makeTempDir();
  try {
    await appendEvents(ledgerDir, [makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'x' })]);
    const before = (await loadAllEvents(ledgerDir)).length;
    const ids = await captureDeferralChildren(ledgerDir, []);
    assert.equal(ids.length, 0);
    assert.equal((await loadAllEvents(ledgerDir)).length, before, 'no deferrals ⇒ byte-identical ledger');
  } finally {
    cleanDir(ledgerDir);
  }
});

// ---------------------------------------------------------------------------
// End-to-end through a real merge
// ---------------------------------------------------------------------------

async function seedRepo(tmpDir: string, events: LedgerEvent[]): Promise<{ repoRoot: string; ledgerDir: string; artifactDir: string }> {
  const repoRoot = join(tmpDir, 'repo');
  const ledgerDir = join(tmpDir, 'ledger');
  const artifactDir = join(tmpDir, 'artifacts');
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
  mkdirSync(artifactDir, { recursive: true });
  mkdirSync(ledgerDir, { recursive: true });
  const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
  g(['init', '-b', 'master']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  writeFileSync(join(repoRoot, 'base.txt'), 'base', 'utf8');
  g(['add', 'base.txt']);
  g(['commit', '-m', 'init']);
  await appendEvents(ledgerDir, events);
  return { repoRoot, ledgerDir, artifactDir };
}

/** A worker that ships a real commit and writes the given manifest. */
function workerWriting(manifest: WorkerManifest): LlmProvider {
  return {
    name: 'fake',
    async run(req: ProviderRequest): Promise<ProviderResult> {
      const { mkdirSync: md, writeFileSync: wf } = await import('node:fs');
      const { spawnSync: sp } = await import('node:child_process');
      md(join(req.cwd!, 'src'), { recursive: true });
      wf(join(req.cwd!, 'src/x.ts'), '// x', 'utf8');
      sp('git', ['add', 'src/x.ts'], { cwd: req.cwd, stdio: 'pipe' });
      sp('git', ['commit', '-m', `feat(${manifest.wi}): partial slice`], { cwd: req.cwd, stdio: 'pipe' });
      wf(join(req.cwd!, `MANIFEST-${manifest.wi}.json`), JSON.stringify(manifest), 'utf8');
      return { ok: true, text: 'done' };
    },
  };
}

test('WI-177 e2e: a merged item whose manifest declares a deferral leaves a captured remainder on the board', async () => {
  const tmpDir = makeTempDir();
  try {
    const { repoRoot, ledgerDir, artifactDir } = await seedRepo(tmpDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'three-slice feature' }),
      makeEvent('cli', 'WI-001', 'item.queued', { spec: 'three-slice feature', touches: 'src/' }),
    ]);

    await runDispatch({
      repoRoot, ledgerDir, autonomy: 'on',
      provider: workerWriting({
        wi: 'WI-001', filesTouched: ['src/x.ts'], testsAdded: [], confidence: 0.5,
        notes: 'shipped slice 1 only',
        deferred: 'slices 2 and 3 — the projection rewrite and its screen',
      }),
      gateResult: { passed: true, reason: 'ok' },
      branchProbe: () => 'master',
      pushProbe: () => ({ status: 0 }),
      config: makeTestConfig(),
      authProbeResult: { ok: true },
      artifactRunsDir: artifactDir,
    });

    const events = await loadAllEvents(ledgerDir);
    const folded = fold(events);
    assert.equal(folded.items.get('WI-001')?.state, 'merged', 'precondition: the partial slice really shipped');

    const child = [...folded.items.values()].find(r => r.source === deferralSourceStamp('WI-001'));
    assert.ok(child, 'the remainder must be visible on the board, not only in the run directory');
    assert.equal(child!.state, 'captured', 'intake only — a worker may propose, never queue');
    assert.match(child!.sourceText ?? '', /projection rewrite/);
    assert.equal(
      events.filter(e => e.item === child!.id && e.type === 'item.queued').length, 0,
      'no item.queued may accompany the capture — that would make this a worker re-scope channel',
    );
  } finally {
    cleanDir(tmpDir);
  }
});

test('WI-177 e2e: a fully-delivered item (no `deferred`) captures nothing — unchanged behaviour', async () => {
  const tmpDir = makeTempDir();
  try {
    const { repoRoot, ledgerDir, artifactDir } = await seedRepo(tmpDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'a one-slice feature' }),
      makeEvent('cli', 'WI-001', 'item.queued', { spec: 'a one-slice feature', touches: 'src/' }),
    ]);

    await runDispatch({
      repoRoot, ledgerDir, autonomy: 'on',
      provider: workerWriting({
        wi: 'WI-001', filesTouched: ['src/x.ts'], testsAdded: [], confidence: 1,
        notes: 'fully delivered',
      }),
      gateResult: { passed: true, reason: 'ok' },
      branchProbe: () => 'master',
      pushProbe: () => ({ status: 0 }),
      config: makeTestConfig(),
      authProbeResult: { ok: true },
      artifactRunsDir: artifactDir,
    });

    const folded = fold(await loadAllEvents(ledgerDir));
    assert.equal(folded.items.get('WI-001')?.state, 'merged');
    assert.equal(
      [...folded.items.values()].filter(r => r.source?.startsWith('deferral:')).length, 0,
      'no deferral declared ⇒ no child item; the common path is untouched',
    );
  } finally {
    cleanDir(tmpDir);
  }
});
