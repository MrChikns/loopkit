/**
 * certification-doctrine.test.ts — WI-057: leader-leader "certify, don't brief"
 * (intent-based leadership — "a certification of understanding, not an assertion of
 * completion"). Pins:
 *   - parseManifest: a well-formed certification block is extracted; a malformed/partial one
 *     is dropped entirely (never half-populated), same all-or-nothing shape as the manifest's
 *     other structured fields.
 *   - fold back-compat: an item.merged event with no `certification` field folds exactly as
 *     before (no crash, `mergeCertification` stays undefined).
 *   - fold: a well-formed certification payload folds onto the record as `mergeCertification`.
 *   - end-to-end (single-item + batch manifest-attributed + batch commit-subject-fallback):
 *     the worker's manifest certification lands on the item.merged event's `certification`
 *     field via `runDispatch`.
 *   - the worker prompt (MANIFEST_INSTRUCTION + buildBatchPrompt) requires the three fields.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { makeEvent, LedgerEvent } from '../src/schema.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import {
  runDispatch, parseManifest, buildPrompt, buildBatchPrompt, MANIFEST_INSTRUCTION,
} from '../src/beats/dispatch.js';
import { fold } from '../src/fold.js';
import { LlmProvider, ProviderRequest, ProviderResult } from '../src/providers/types.js';
import { LoopkitConfig, CONFIG_DEFAULTS } from '../src/config.js';

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

const CERT = {
  couldBreak: 'The migration script could strand rows mid-batch.',
  detection: 'The nightly integrity check would flag orphaned rows.',
  rollback: 'Re-run the down-migration; it is idempotent.',
};

// ---------------------------------------------------------------------------
// parseManifest — certification extraction
// ---------------------------------------------------------------------------

test('parseManifest: a well-formed certification block is extracted', () => {
  const input = JSON.stringify({
    wi: 'WI-800', filesTouched: ['a.ts'], testsAdded: [], confidence: 0.9, notes: 'ok',
    certification: CERT,
  });
  const result = parseManifest(input);
  assert.ok(result);
  assert.deepEqual(result!.certification, CERT);
});

test('parseManifest: a malformed (partial) certification block is dropped entirely', () => {
  const input = JSON.stringify({
    wi: 'WI-801', filesTouched: ['a.ts'], testsAdded: [], confidence: 0.9, notes: 'ok',
    // Missing 'rollback' — the whole block must be dropped, not partially populated.
    certification: { couldBreak: CERT.couldBreak, detection: CERT.detection },
  });
  const result = parseManifest(input);
  assert.ok(result);
  assert.equal(result!.certification, undefined);
});

test('parseManifest: no certification field at all still parses the rest of the manifest (back-compat)', () => {
  const input = JSON.stringify({ wi: 'WI-802', filesTouched: ['a.ts'], testsAdded: [], confidence: 0.9, notes: 'ok' });
  const result = parseManifest(input);
  assert.ok(result);
  assert.equal(result!.certification, undefined);
  assert.equal(result!.wi, 'WI-802');
});

// ---------------------------------------------------------------------------
// fold back-compat + payload folding
// ---------------------------------------------------------------------------

test('fold back-compat: item.merged with no certification field folds exactly as before', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-810', 'item.captured', { source: 'cli', text: 'x' }),
    makeEvent('conductor', 'WI-810', 'item.queued', { spec: 'spec' }),
    makeEvent('dispatch', 'WI-810', 'item.merged', { commit: 'abc123', deployed: false }),
  ];
  const result = fold(events);
  const item = result.items.get('WI-810');
  assert.ok(item);
  assert.equal(item.state, 'merged');
  assert.equal(item.mergeCommit, 'abc123');
  assert.equal(item.mergeCertification, undefined);
});

test('fold: a well-formed certification payload folds onto the record as mergeCertification', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-811', 'item.captured', { source: 'cli', text: 'x' }),
    makeEvent('conductor', 'WI-811', 'item.queued', { spec: 'spec' }),
    makeEvent('dispatch', 'WI-811', 'item.merged', { commit: 'abc123', deployed: false, certification: CERT }),
  ];
  const result = fold(events);
  const item = result.items.get('WI-811');
  assert.ok(item);
  assert.deepEqual(item.mergeCertification, CERT);
});

test('fold: a malformed (partial) certification payload folds to undefined, never half-populated', () => {
  const events: LedgerEvent[] = [
    makeEvent('operator', 'WI-812', 'item.captured', { source: 'cli', text: 'x' }),
    makeEvent('conductor', 'WI-812', 'item.queued', { spec: 'spec' }),
    {
      id: 'ev-01TESTCERTIFICATIONPARTIAL',
      ts: '2026-07-20T12:00:00.000Z',
      actor: 'dispatch',
      item: 'WI-812',
      type: 'item.merged',
      data: { commit: 'abc123', deployed: false, certification: { couldBreak: CERT.couldBreak } },
    } as unknown as LedgerEvent,
  ];
  const result = fold(events);
  const item = result.items.get('WI-812');
  assert.ok(item);
  assert.equal(item.mergeCertification, undefined);
});

// ---------------------------------------------------------------------------
// Worker prompt contract
// ---------------------------------------------------------------------------

test('MANIFEST_INSTRUCTION requires the three certification fields', () => {
  assert.ok(MANIFEST_INSTRUCTION.includes('certification'), 'instruction must mention certification');
  assert.ok(MANIFEST_INSTRUCTION.includes('couldBreak'), 'instruction must include couldBreak');
  assert.ok(MANIFEST_INSTRUCTION.includes('detection'), 'instruction must include detection');
  assert.ok(MANIFEST_INSTRUCTION.includes('rollback'), 'instruction must include rollback');
});

test('buildPrompt (single-item) still includes the certification instruction', () => {
  const prompt = buildPrompt('implement this feature', undefined, undefined, undefined, undefined, undefined);
  assert.ok(prompt.includes('certification'), 'single-item prompt must require certification');
});

test('buildBatchPrompt includes the certification instruction per item', () => {
  const items = [{ id: 'WI-001', spec: 'do A' }, { id: 'WI-002', spec: 'do B' }];
  const prompt = buildBatchPrompt(items);
  assert.ok(prompt.includes('certification'), 'batch prompt must require certification');
  assert.ok(prompt.includes('couldBreak'), 'batch prompt must include couldBreak');
});

// ---------------------------------------------------------------------------
// End-to-end: certification flows from the worker manifest onto item.merged
// ---------------------------------------------------------------------------

test('single-item merge: a manifest certification lands on the item.merged event', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-wi057-single-'));
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
      makeEvent('cli', 'WI-900', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-900', 'item.queued', { spec: 'do x', touches: 'src/', model: 'sonnet', priority: 'medium' }, '2026-01-01T00:01:00Z'),
    ]);

    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        const { mkdirSync: md, writeFileSync: wf } = await import('node:fs');
        const { spawnSync: sp } = await import('node:child_process');
        md(join(req.cwd!, 'src'), { recursive: true });
        wf(join(req.cwd!, 'src/x.ts'), '// x', 'utf8');
        sp('git', ['add', 'src/x.ts'], { cwd: req.cwd, stdio: 'pipe' });
        sp('git', ['commit', '-m', 'feat(WI-900): x'], { cwd: req.cwd, stdio: 'pipe' });
        wf(join(req.cwd!, 'MANIFEST-WI-900.json'), JSON.stringify({
          wi: 'WI-900', filesTouched: ['src/x.ts'], testsAdded: [], confidence: 0.9, notes: 'ok',
          certification: CERT,
        }), 'utf8');
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
    });

    const events = await loadAllEvents(ledgerDir);
    const merge = events.find(e => e.type === 'item.merged' && e.item === 'WI-900');
    assert.ok(merge, 'item.merged event exists');
    assert.deepEqual((merge!.data as { certification?: unknown }).certification, CERT);

    const folded = fold(events);
    assert.deepEqual(folded.items.get('WI-900')?.mergeCertification, CERT);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('single-item merge: NO manifest certification → item.merged carries no certification field (back-compat)', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-wi057-nocert-'));
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
      makeEvent('cli', 'WI-901', 'item.captured', { source: 'cli', text: 'x' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-901', 'item.queued', { spec: 'do x', touches: 'src/', model: 'sonnet', priority: 'medium' }, '2026-01-01T00:01:00Z'),
    ]);

    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        const { mkdirSync: md, writeFileSync: wf } = await import('node:fs');
        const { spawnSync: sp } = await import('node:child_process');
        md(join(req.cwd!, 'src'), { recursive: true });
        wf(join(req.cwd!, 'src/x.ts'), '// x', 'utf8');
        sp('git', ['add', 'src/x.ts'], { cwd: req.cwd, stdio: 'pipe' });
        sp('git', ['commit', '-m', 'feat(WI-901): x'], { cwd: req.cwd, stdio: 'pipe' });
        // No manifest at all — legacy/uncooperative worker.
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
    });

    const events = await loadAllEvents(ledgerDir);
    const merge = events.find(e => e.type === 'item.merged' && e.item === 'WI-901');
    assert.ok(merge);
    assert.equal((merge!.data as { certification?: unknown }).certification, undefined);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('batch (manifest-attributed): each item carries its OWN certification on item.merged', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-wi057-batch-manifest-'));
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
      makeEvent('cli', 'WI-910', 'item.captured', { source: 'cli', text: 'a' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-910', 'item.queued', { spec: 'do A', touches: 'src/', model: 'sonnet', priority: 'medium' }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-911', 'item.captured', { source: 'cli', text: 'b' }, '2026-01-01T00:02:00Z'),
      makeEvent('cli', 'WI-911', 'item.queued', { spec: 'do B', touches: 'src/', model: 'sonnet', priority: 'medium' }, '2026-01-01T00:03:00Z'),
    ]);

    const cert2 = { couldBreak: 'Other risk', detection: 'Other signal', rollback: 'Other rollback' };

    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        const { mkdirSync: md, writeFileSync: wf } = await import('node:fs');
        const { spawnSync: sp } = await import('node:child_process');
        md(join(req.cwd!, 'src'), { recursive: true });
        wf(join(req.cwd!, 'src/a.ts'), '// a', 'utf8');
        sp('git', ['add', 'src/a.ts'], { cwd: req.cwd, stdio: 'pipe' });
        sp('git', ['commit', '-m', 'feat: implement A'], { cwd: req.cwd, stdio: 'pipe' });
        wf(join(req.cwd!, 'src/b.ts'), '// b', 'utf8');
        sp('git', ['add', 'src/b.ts'], { cwd: req.cwd, stdio: 'pipe' });
        sp('git', ['commit', '-m', 'feat: implement B'], { cwd: req.cwd, stdio: 'pipe' });
        wf(join(req.cwd!, 'MANIFEST-WI-910.json'), JSON.stringify({
          wi: 'WI-910', filesTouched: ['src/a.ts'], testsAdded: [], confidence: 0.9, notes: 'A done',
          certification: CERT,
        }), 'utf8');
        wf(join(req.cwd!, 'MANIFEST-WI-911.json'), JSON.stringify({
          wi: 'WI-911', filesTouched: ['src/b.ts'], testsAdded: [], confidence: 0.85, notes: 'B done',
          certification: cert2,
        }), 'utf8');
        return { ok: true, text: 'done' };
      },
    };

    await runDispatch({
      repoRoot, ledgerDir, autonomy: 'on', provider,
      gateResult: { passed: true, reason: 'ok' },
      branchProbe: () => 'master',
      pushProbe: () => ({ status: 0 }),
      config: makeTestConfig({ batchMaxItems: 3 }),
      authProbeResult: { ok: true },
    });

    const events = await loadAllEvents(ledgerDir);
    const m1 = events.find(e => e.type === 'item.merged' && e.item === 'WI-910');
    const m2 = events.find(e => e.type === 'item.merged' && e.item === 'WI-911');
    assert.ok(m1);
    assert.ok(m2);
    assert.deepEqual((m1!.data as { certification?: unknown }).certification, CERT);
    assert.deepEqual((m2!.data as { certification?: unknown }).certification, cert2);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('batch (commit-subject fallback): a manifest certification still lands even without a filesTouched hit', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-wi057-batch-fallback-'));
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
      makeEvent('cli', 'WI-920', 'item.captured', { source: 'cli', text: 'a' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-920', 'item.queued', { spec: 'do A', touches: 'src/', model: 'sonnet', priority: 'medium' }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-921', 'item.captured', { source: 'cli', text: 'b' }, '2026-01-01T00:02:00Z'),
      makeEvent('cli', 'WI-921', 'item.queued', { spec: 'do B', touches: 'src/', model: 'sonnet', priority: 'medium' }, '2026-01-01T00:03:00Z'),
    ]);

    // Commit subjects carry the id (fallback attribution path), and the manifest carries a
    // certification but an EMPTY filesTouched (so manifest-first attribution never fires,
    // only the fallback branch — which must still pick up the certification).
    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        const { mkdirSync: md, writeFileSync: wf } = await import('node:fs');
        const { spawnSync: sp } = await import('node:child_process');
        md(join(req.cwd!, 'src'), { recursive: true });
        wf(join(req.cwd!, 'src/a.ts'), '// a', 'utf8');
        sp('git', ['add', 'src/a.ts'], { cwd: req.cwd, stdio: 'pipe' });
        sp('git', ['commit', '-m', 'feat(WI-920): do A'], { cwd: req.cwd, stdio: 'pipe' });
        wf(join(req.cwd!, 'src/b.ts'), '// b', 'utf8');
        sp('git', ['add', 'src/b.ts'], { cwd: req.cwd, stdio: 'pipe' });
        sp('git', ['commit', '-m', 'feat(WI-921): do B'], { cwd: req.cwd, stdio: 'pipe' });
        wf(join(req.cwd!, 'MANIFEST-WI-920.json'), JSON.stringify({
          wi: 'WI-920', filesTouched: [], testsAdded: [], confidence: 0.9, notes: 'A done',
          certification: CERT,
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
    });
    assert.equal(result.dispatched.length, 1);

    const events = await loadAllEvents(ledgerDir);
    const m1 = events.find(e => e.type === 'item.merged' && e.item === 'WI-920');
    assert.ok(m1);
    assert.equal((m1!.data as { attribution?: string }).attribution, 'commit-subject');
    assert.deepEqual((m1!.data as { certification?: unknown }).certification, CERT);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
