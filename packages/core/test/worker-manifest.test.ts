/**
 * worker-manifest.test.ts — Tests for typed worker manifests.
 *
 * Covers:
 *   parser       — valid manifest, missing fields (defaulted), confidence clamping, malformed JSON → null
 *   prompts      — single and batch prompts contain the manifest instruction
 *   dirty-check  — untracked MANIFEST-WI-NNN.json is exempt; a stray MANIFESTO.md is not
 *   evidence     — valid manifest is copied to the evidence path; malformed is not
 *   batch attrib — two items, disjoint filesTouched, no id-prefixed subjects → manifest-attributed
 *   fallback     — manifest absent → commit-subject fallback works + attribution:'commit-subject'
 *   malformed    — malformed manifest → fallback, no crash
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { makeEvent, LedgerEvent } from '../src/schema.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import {
  runDispatch,
  isDependencyPlumbing, isWorkerManifest,
  parseManifest, WorkerManifest,
  buildPrompt, buildBatchPrompt, MANIFEST_INSTRUCTION,
} from '../src/beats/dispatch.js';
import { fold } from '../src/fold.js';
import { LlmProvider, ProviderRequest, ProviderResult } from '../src/providers/types.js';
import { LoopkitConfig, CONFIG_DEFAULTS } from '../src/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testCount = 0;

function makeTempDir(): string {
  const dir = join(tmpdir(), `loopkit-wi227-${process.pid}-${++testCount}-${Date.now()}`);
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

async function seedLedger(ledgerDir: string, events: LedgerEvent[]): Promise<void> {
  mkdirSync(ledgerDir, { recursive: true });
  await appendEvents(ledgerDir, events);
}

// ---------------------------------------------------------------------------
// parseManifest — unit tests
// ---------------------------------------------------------------------------

test('parseManifest: valid manifest returns typed object', () => {
  const input = JSON.stringify({
    wi: 'WI-123',
    filesTouched: ['src/a.ts', 'src/b.ts'],
    testsAdded: ['test/a.test.ts'],
    confidence: 0.9,
    notes: 'all done',
  });
  const result = parseManifest(input);
  assert.ok(result !== null, 'should parse valid manifest');
  assert.equal(result!.wi, 'WI-123');
  assert.deepEqual(result!.filesTouched, ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(result!.testsAdded, ['test/a.test.ts']);
  assert.equal(result!.confidence, 0.9);
  assert.equal(result!.notes, 'all done');
});

test('parseManifest: missing fields are defaulted', () => {
  const input = JSON.stringify({ wi: 'WI-456' });
  const result = parseManifest(input);
  assert.ok(result !== null, 'should parse partial manifest');
  assert.equal(result!.wi, 'WI-456');
  assert.deepEqual(result!.filesTouched, []);
  assert.deepEqual(result!.testsAdded, []);
  assert.equal(result!.confidence, 0);
  assert.equal(result!.notes, '');
});

test('parseManifest: confidence is clamped to [0, 1]', () => {
  const overHigh = parseManifest(JSON.stringify({ confidence: 1.5 }));
  assert.ok(overHigh !== null);
  assert.equal(overHigh!.confidence, 1, 'confidence > 1 clamped to 1');

  const negative = parseManifest(JSON.stringify({ confidence: -0.5 }));
  assert.ok(negative !== null);
  assert.equal(negative!.confidence, 0, 'negative confidence clamped to 0');

  const inRange = parseManifest(JSON.stringify({ confidence: 0.75 }));
  assert.ok(inRange !== null);
  assert.equal(inRange!.confidence, 0.75);
});

test('parseManifest: non-string entries in arrays are filtered', () => {
  const input = JSON.stringify({
    filesTouched: ['good.ts', 42, null, 'also-good.ts'],
    testsAdded: [true, 'test.ts'],
  });
  const result = parseManifest(input);
  assert.ok(result !== null);
  assert.deepEqual(result!.filesTouched, ['good.ts', 'also-good.ts']);
  assert.deepEqual(result!.testsAdded, ['test.ts']);
});

test('parseManifest: malformed JSON returns null', () => {
  assert.equal(parseManifest('not-json'), null);
  assert.equal(parseManifest('{broken: true'), null);
  assert.equal(parseManifest(''), null);
});

test('parseManifest: array root returns null', () => {
  assert.equal(parseManifest('[]'), null);
  assert.equal(parseManifest('[1, 2, 3]'), null);
});

test('parseManifest: null root returns null', () => {
  assert.equal(parseManifest('null'), null);
});

// ---------------------------------------------------------------------------
// Prompt content — single and batch contain the manifest instruction
// ---------------------------------------------------------------------------

// Test buildPrompt and buildBatchPrompt directly (both are exported for testability).

test('buildPrompt contains MANIFEST instruction', () => {
  const prompt = buildPrompt('implement this feature', undefined, undefined, undefined, undefined, undefined);
  assert.ok(prompt.includes('MANIFEST'), 'single-item prompt must contain MANIFEST instruction');
  assert.ok(prompt.includes('MANIFEST-'), 'prompt must name the manifest file pattern');
  assert.ok(prompt.includes('filesTouched'), 'prompt must mention filesTouched field');
  assert.ok(prompt.includes('confidence'), 'prompt must mention confidence field');
});

test('buildPrompt with repairEvidence still includes MANIFEST instruction', () => {
  const prompt = buildPrompt('fix the bug', undefined, undefined, undefined, 'REPAIR EVIDENCE: prior diff', undefined);
  assert.ok(prompt.includes('MANIFEST'), 'repair prompt must also include MANIFEST instruction');
  assert.ok(prompt.includes('REPAIR EVIDENCE'), 'repair prompt must retain repair evidence');
  // MANIFEST instruction comes after REQUEST
  const reqIdx = prompt.indexOf('REQUEST:');
  const manifestIdx = prompt.indexOf('MANIFEST');
  assert.ok(reqIdx < manifestIdx, 'MANIFEST instruction must come after REQUEST');
});

test('buildPrompt with resumeNote still includes MANIFEST instruction', () => {
  const prompt = buildPrompt('resume', undefined, undefined, undefined, undefined, 'RESUME NOTE: prior patch');
  assert.ok(prompt.includes('MANIFEST'), 'resume prompt must also include MANIFEST instruction');
});

test('buildBatchPrompt contains MANIFEST instruction per item', () => {
  const items = [
    { id: 'WI-001', spec: 'do A' },
    { id: 'WI-002', spec: 'do B' },
  ];
  const prompt = buildBatchPrompt(items);
  assert.ok(prompt.includes('MANIFEST'), 'batch prompt must contain MANIFEST instruction');
  assert.ok(prompt.includes('MANIFEST-WI-001'), 'batch prompt must name the first item manifest file');
  assert.ok(prompt.includes('filesTouched'), 'batch prompt must mention filesTouched field');
});

test('buildPrompt warns the worker off copying private decision-log ids into commit messages', () => {
  const prompt = buildPrompt('implement this feature');
  assert.ok(
    /decision-log id/i.test(prompt) && /D-NNN/.test(prompt),
    'single-item prompt must warn against copying a private D-NNN id into the commit message',
  );
});

test('buildBatchPrompt warns the worker off copying private decision-log ids into commit messages', () => {
  const items = [{ id: 'WI-001', spec: 'do A' }];
  const prompt = buildBatchPrompt(items);
  assert.ok(
    /decision-log id/i.test(prompt) && /D-NNN/.test(prompt),
    'batch prompt must warn against copying a private D-NNN id into each item commit message',
  );
});

test('MANIFEST_INSTRUCTION is exported and contains the required fields', () => {
  assert.ok(MANIFEST_INSTRUCTION.includes('MANIFEST'), 'instruction must include MANIFEST keyword');
  assert.ok(MANIFEST_INSTRUCTION.includes('filesTouched'), 'instruction must include filesTouched');
  assert.ok(MANIFEST_INSTRUCTION.includes('testsAdded'), 'instruction must include testsAdded');
  assert.ok(MANIFEST_INSTRUCTION.includes('confidence'), 'instruction must include confidence');
  assert.ok(MANIFEST_INSTRUCTION.includes('notes'), 'instruction must include notes');
});

// ---------------------------------------------------------------------------
// Dirty-check exemption — isWorkerManifest
// ---------------------------------------------------------------------------

test('isWorkerManifest exempts MANIFEST-WI-*.json filenames', () => {
  const manifests = [
    '?? MANIFEST-WI-123.json',
    '?? MANIFEST-WI-001.json',
    '?? MANIFEST-WI-999.json',
    ' M MANIFEST-WI-XYZ.json',
  ];
  for (const line of manifests) {
    assert.equal(isWorkerManifest(line), true, `should exempt: ${line}`);
  }
});

test('isWorkerManifest does NOT exempt unrelated files', () => {
  const notManifests = [
    '?? MANIFESTO.md',
    '?? src/MANIFEST-WI-123.json',     // not at root
    '?? MANIFEST-WI-123.ts',           // wrong extension
    '?? MANIFEST.json',                // missing WI- prefix
    '?? MANIFEST-WI-.json',            // empty id
    '?? some/path/MANIFEST-WI-1.json', // not root-level
  ];
  for (const line of notManifests) {
    assert.equal(isWorkerManifest(line), false, `should NOT exempt: ${line}`);
  }
});

test('verifyWorktreeState: untracked MANIFEST-WI-123.json does not trigger dirty-check park', async () => {
  // We test this indirectly: a build that leaves a manifest file uncommitted should still
  // pass the worktree verification step (the manifest is not dirty).
  const tmpDir = makeTempDir();
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'base.txt'), 'base', 'utf8');
    g(['add', 'base.txt']);
    g(['commit', '-m', 'init']);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-001', 'item.queued', {
        spec: 'do x', touches: 'src/', model: 'sonnet', priority: 'medium',
      }, '2026-01-01T00:01:00Z'),
    ]);

    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        const { mkdirSync: md, writeFileSync: wf } = await import('node:fs');
        const { spawnSync: sp } = await import('node:child_process');
        md(join(req.cwd!, 'src'), { recursive: true });
        wf(join(req.cwd!, 'src/x.ts'), '// x', 'utf8');
        sp('git', ['add', 'src/x.ts'], { cwd: req.cwd, stdio: 'pipe' });
        sp('git', ['commit', '-m', 'feat(WI-001): x'], { cwd: req.cwd, stdio: 'pipe' });
        // Leave manifest file uncommitted — this should NOT cause a dirty-tree park
        wf(join(req.cwd!, 'MANIFEST-WI-001.json'), JSON.stringify({
          wi: 'WI-001', filesTouched: ['src/x.ts'], testsAdded: [], confidence: 0.9, notes: 'ok',
        }), 'utf8');
        return { ok: true, text: 'done' };
      },
    };

    const result = await runDispatch({
      repoRoot, ledgerDir, autonomy: 'on', provider,
      gateResult: { passed: true, reason: 'ok' },
      branchProbe: () => 'master',
      pushProbe: () => ({ status: 0 }),
      config: makeTestConfig(),
      authProbeResult: { ok: true },
    });

    assert.equal(result.dispatched[0].gateOutcome, 'passed', 'manifest file must not cause dirty-tree park');

    const events = await loadAllEvents(ledgerDir);
    const folded = fold(events);
    assert.equal(folded.items.get('WI-001')?.state, 'merged', 'WI-001 must reach merged state');
  } finally {
    cleanDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Manifest copied to evidence path
// ---------------------------------------------------------------------------

test('valid manifest is copied to evidence path after gate pass', async () => {
  const tmpDir = makeTempDir();
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    const artifactDir = join(tmpDir, 'artifacts');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
    mkdirSync(artifactDir, { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'base.txt'), 'base', 'utf8');
    g(['add', 'base.txt']);
    g(['commit', '-m', 'init']);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-001', 'item.queued', {
        spec: 'do x', touches: 'src/', model: 'sonnet', priority: 'medium',
      }, '2026-01-01T00:01:00Z'),
    ]);

    const manifest: WorkerManifest = {
      wi: 'WI-001',
      filesTouched: ['src/x.ts'],
      testsAdded: ['test/x.test.ts'],
      confidence: 0.85,
      notes: 'implementation complete',
    };

    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        const { mkdirSync: md, writeFileSync: wf } = await import('node:fs');
        const { spawnSync: sp } = await import('node:child_process');
        md(join(req.cwd!, 'src'), { recursive: true });
        wf(join(req.cwd!, 'src/x.ts'), '// x', 'utf8');
        sp('git', ['add', 'src/x.ts'], { cwd: req.cwd, stdio: 'pipe' });
        sp('git', ['commit', '-m', 'feat(WI-001): x'], { cwd: req.cwd, stdio: 'pipe' });
        wf(join(req.cwd!, 'MANIFEST-WI-001.json'), JSON.stringify(manifest), 'utf8');
        return { ok: true, text: 'done' };
      },
    };

    await runDispatch({
      repoRoot, ledgerDir, autonomy: 'on', provider,
      gateResult: { passed: true, reason: 'ok' },
      branchProbe: () => 'master',
      pushProbe: () => ({ status: 0 }),
      config: makeTestConfig(),
      authProbeResult: { ok: true },
      artifactRunsDir: artifactDir,
    });

    const evidencePath = join(artifactDir, 'WI-001-attempt-1.manifest.json');
    assert.ok(existsSync(evidencePath), 'evidence file must exist');
    const saved = JSON.parse(readFileSync(evidencePath, 'utf8')) as WorkerManifest;
    assert.equal(saved.wi, 'WI-001');
    assert.equal(saved.confidence, 0.85);
    assert.deepEqual(saved.filesTouched, ['src/x.ts']);
  } finally {
    cleanDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Batch attribution: manifest-first
// ---------------------------------------------------------------------------

test('batch: two items with disjoint filesTouched manifests, no id-prefixed commit subjects → both attributed via manifest', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-wi227-batch-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    const artifactDir = join(tmpDir, 'artifacts');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
    mkdirSync(artifactDir, { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'x.txt'), 'x', 'utf8');
    g(['add', 'x.txt']);
    g(['commit', '-m', 'init']);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'a' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-001', 'item.queued', { spec: 'do A', touches: 'src/', model: 'sonnet', priority: 'medium' }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-002', 'item.captured', { source: 'cli', text: 'b' }, '2026-01-01T00:02:00Z'),
      makeEvent('cli', 'WI-002', 'item.queued', { spec: 'do B', touches: 'src/', model: 'sonnet', priority: 'medium' }, '2026-01-01T00:03:00Z'),
    ]);

    // Worker writes commits WITHOUT item-id-prefixed subjects, plus disjoint manifests.
    // This tests that manifest attribution fires rather than commit-subject fallback.
    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        const { mkdirSync: md, writeFileSync: wf } = await import('node:fs');
        const { spawnSync: sp } = await import('node:child_process');
        md(join(req.cwd!, 'src'), { recursive: true });
        // Commit 1: touches src/a.ts — no id in subject
        wf(join(req.cwd!, 'src/a.ts'), '// a', 'utf8');
        sp('git', ['add', 'src/a.ts'], { cwd: req.cwd, stdio: 'pipe' });
        sp('git', ['commit', '-m', 'feat: implement A'], { cwd: req.cwd, stdio: 'pipe' });
        // Commit 2: touches src/b.ts — no id in subject
        wf(join(req.cwd!, 'src/b.ts'), '// b', 'utf8');
        sp('git', ['add', 'src/b.ts'], { cwd: req.cwd, stdio: 'pipe' });
        sp('git', ['commit', '-m', 'feat: implement B'], { cwd: req.cwd, stdio: 'pipe' });
        // Write manifests with DISJOINT filesTouched
        wf(join(req.cwd!, 'MANIFEST-WI-001.json'), JSON.stringify({
          wi: 'WI-001', filesTouched: ['src/a.ts'], testsAdded: [], confidence: 0.9, notes: 'A done',
        }), 'utf8');
        wf(join(req.cwd!, 'MANIFEST-WI-002.json'), JSON.stringify({
          wi: 'WI-002', filesTouched: ['src/b.ts'], testsAdded: [], confidence: 0.85, notes: 'B done',
        }), 'utf8');
        return { ok: true, text: 'done' };
      },
    };

    const result = await runDispatch({
      repoRoot, ledgerDir, autonomy: 'on', provider,
      gateResult: { passed: true, reason: 'ok' },
      branchProbe: () => 'master',
      pushProbe: () => ({ status: 0 }),
      config: makeTestConfig({ batchMaxItems: 3 }),
      authProbeResult: { ok: true },
      artifactRunsDir: artifactDir,
    });

    assert.equal(result.dispatched.length, 1, 'one worktree dispatched');

    const events = await loadAllEvents(ledgerDir);
    const folded = fold(events);
    assert.equal(folded.items.get('WI-001')?.state, 'merged', 'WI-001 must be merged');
    assert.equal(folded.items.get('WI-002')?.state, 'merged', 'WI-002 must be merged');

    const mergeEvents = events.filter(e => e.type === 'item.merged');
    const m1 = mergeEvents.find(e => e.item === 'WI-001');
    const m2 = mergeEvents.find(e => e.item === 'WI-002');
    assert.ok(m1, 'WI-001 must have item.merged event');
    assert.ok(m2, 'WI-002 must have item.merged event');
    assert.equal((m1!.data as { attribution?: string }).attribution, 'manifest', 'WI-001 must be attributed via manifest');
    assert.equal((m2!.data as { attribution?: string }).attribution, 'manifest', 'WI-002 must be attributed via manifest');

    // Evidence files must exist for both items
    assert.ok(existsSync(join(artifactDir, 'WI-001-attempt-1.manifest.json')), 'WI-001 evidence exists');
    assert.ok(existsSync(join(artifactDir, 'WI-002-attempt-1.manifest.json')), 'WI-002 evidence exists');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fallback: manifest absent → commit-subject fallback
// ---------------------------------------------------------------------------

test('batch: manifest absent → commit-subject fallback attributed correctly', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-wi227-fallback-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'x.txt'), 'x', 'utf8');
    g(['add', 'x.txt']);
    g(['commit', '-m', 'init']);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'a' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-001', 'item.queued', { spec: 'do A', touches: 'src/', model: 'sonnet', priority: 'medium' }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-002', 'item.captured', { source: 'cli', text: 'b' }, '2026-01-01T00:02:00Z'),
      makeEvent('cli', 'WI-002', 'item.queued', { spec: 'do B', touches: 'src/', model: 'sonnet', priority: 'medium' }, '2026-01-01T00:03:00Z'),
    ]);

    // Worker writes commits WITH item-id-prefixed subjects, but NO manifests.
    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        const { mkdirSync: md, writeFileSync: wf } = await import('node:fs');
        const { spawnSync: sp } = await import('node:child_process');
        md(join(req.cwd!, 'src'), { recursive: true });
        wf(join(req.cwd!, 'src/a.ts'), '// a', 'utf8');
        sp('git', ['add', 'src/a.ts'], { cwd: req.cwd, stdio: 'pipe' });
        sp('git', ['commit', '-m', 'feat(WI-001): do A'], { cwd: req.cwd, stdio: 'pipe' });
        wf(join(req.cwd!, 'src/b.ts'), '// b', 'utf8');
        sp('git', ['add', 'src/b.ts'], { cwd: req.cwd, stdio: 'pipe' });
        sp('git', ['commit', '-m', 'feat(WI-002): do B'], { cwd: req.cwd, stdio: 'pipe' });
        // No manifest files written
        return { ok: true, text: 'done' };
      },
    };

    const result = await runDispatch({
      repoRoot, ledgerDir, autonomy: 'on', provider,
      gateResult: { passed: true, reason: 'ok' },
      branchProbe: () => 'master',
      pushProbe: () => ({ status: 0 }),
      config: makeTestConfig({ batchMaxItems: 3 }),
      authProbeResult: { ok: true },
    });

    assert.equal(result.dispatched.length, 1);

    const events = await loadAllEvents(ledgerDir);
    const folded = fold(events);
    assert.equal(folded.items.get('WI-001')?.state, 'merged', 'WI-001 merged via commit-subject fallback');
    assert.equal(folded.items.get('WI-002')?.state, 'merged', 'WI-002 merged via commit-subject fallback');

    const mergeEvents = events.filter(e => e.type === 'item.merged');
    const m1 = mergeEvents.find(e => e.item === 'WI-001');
    const m2 = mergeEvents.find(e => e.item === 'WI-002');
    assert.equal((m1!.data as { attribution?: string }).attribution, 'commit-subject', 'WI-001 must be attributed via commit-subject');
    assert.equal((m2!.data as { attribution?: string }).attribution, 'commit-subject', 'WI-002 must be attributed via commit-subject');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Malformed manifest → fallback, no crash
// ---------------------------------------------------------------------------

test('batch: malformed manifest → fallback attribution, no crash', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-wi227-malformed-'));
  try {
    const repoRoot = join(tmpDir, 'repo');
    const ledgerDir = join(tmpDir, 'ledger');
    mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });

    const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    g(['init', '-b', 'master']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(repoRoot, 'x.txt'), 'x', 'utf8');
    g(['add', 'x.txt']);
    g(['commit', '-m', 'init']);

    await seedLedger(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'a' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-001', 'item.queued', { spec: 'do A', touches: 'src/', model: 'sonnet', priority: 'medium' }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-002', 'item.captured', { source: 'cli', text: 'b' }, '2026-01-01T00:02:00Z'),
      makeEvent('cli', 'WI-002', 'item.queued', { spec: 'do B', touches: 'src/', model: 'sonnet', priority: 'medium' }, '2026-01-01T00:03:00Z'),
    ]);

    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        const { mkdirSync: md, writeFileSync: wf } = await import('node:fs');
        const { spawnSync: sp } = await import('node:child_process');
        md(join(req.cwd!, 'src'), { recursive: true });
        wf(join(req.cwd!, 'src/a.ts'), '// a', 'utf8');
        sp('git', ['add', 'src/a.ts'], { cwd: req.cwd, stdio: 'pipe' });
        sp('git', ['commit', '-m', 'feat(WI-001): do A'], { cwd: req.cwd, stdio: 'pipe' });
        wf(join(req.cwd!, 'src/b.ts'), '// b', 'utf8');
        sp('git', ['add', 'src/b.ts'], { cwd: req.cwd, stdio: 'pipe' });
        sp('git', ['commit', '-m', 'feat(WI-002): do B'], { cwd: req.cwd, stdio: 'pipe' });
        // Both manifests are intentionally malformed
        wf(join(req.cwd!, 'MANIFEST-WI-001.json'), '{invalid json', 'utf8');
        wf(join(req.cwd!, 'MANIFEST-WI-002.json'), 'null', 'utf8');
        return { ok: true, text: 'done' };
      },
    };

    // Should not throw — fail-open
    const result = await runDispatch({
      repoRoot, ledgerDir, autonomy: 'on', provider,
      gateResult: { passed: true, reason: 'ok' },
      branchProbe: () => 'master',
      pushProbe: () => ({ status: 0 }),
      config: makeTestConfig({ batchMaxItems: 3 }),
      authProbeResult: { ok: true },
    });

    assert.equal(result.dispatched.length, 1, 'dispatched must complete (no crash)');

    // Both should still be merged (fallback to commit-subject)
    const events = await loadAllEvents(ledgerDir);
    const folded = fold(events);
    assert.equal(folded.items.get('WI-001')?.state, 'merged', 'WI-001 merged even with malformed manifest');
    assert.equal(folded.items.get('WI-002')?.state, 'merged', 'WI-002 merged even with malformed manifest');

    // Both should fall back to commit-subject attribution
    const mergeEvents = events.filter(e => e.type === 'item.merged');
    const m1 = mergeEvents.find(e => e.item === 'WI-001');
    const m2 = mergeEvents.find(e => e.item === 'WI-002');
    assert.equal((m1!.data as { attribution?: string }).attribution, 'commit-subject');
    assert.equal((m2!.data as { attribution?: string }).attribution, 'commit-subject');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
