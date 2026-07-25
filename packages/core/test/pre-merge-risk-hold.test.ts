/**
 * pre-merge-risk-hold.test.ts — WI-180: the `must`-tier risk classes are evaluated BEFORE landing.
 *
 * Acceptance tier is computed only after merge, from the real diff, so it governs what the
 * operator is TOLD, never what was permitted to land. This slice adds an optional, config-gated,
 * **default-OFF** pre-merge read of the SAME classifier that parks (never fails) on `must`.
 *
 * Explicitly NOT an authorization model: no identity, no approval event, no RBAC. On a
 * single-operator plane, operator intent plus configured autonomy IS the authorization.
 *
 * Covers:
 *   default   — the flag is off in DEFAULTS and off after loadConfig with no config file
 *   off-path  — flag off ⇒ a risk-pattern diff merges exactly as it does today (the load-bearing
 *               property: byte-identical behaviour)
 *   on-path   — flag on ⇒ the same build parks `decision` with gate.parked{reason:'risk-tier'},
 *               keeps its branch, and never merges
 *   parks-not-fails — the park is not a gate failure and the item is recoverable
 *   classifier — preMergeRiskHoldReason returns null for every non-`must` tier, and ignores the
 *               judge (advisory, and a judge fail is a review signal, not a landing-risk class)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { makeEvent, LedgerEvent } from '../src/schema.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { runDispatch } from '../src/beats/dispatch.js';
import { preMergeRiskHoldReason } from '../src/acceptance.js';
import { fold } from '../src/fold.js';
import { LlmProvider, ProviderRequest, ProviderResult } from '../src/providers/types.js';
import { LoopkitConfig, CONFIG_DEFAULTS, loadConfig } from '../src/config.js';

let testCount = 0;
function makeTempDir(): string {
  const dir = join(tmpdir(), `loopkit-wi180-${process.pid}-${++testCount}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function cleanDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const BOUNDS = { surfacePrefixes: ['src/public/'], planePrefixes: ['.loopkit/'], riskPatterns: ['migrations/', 'auth/', 'billing/'] };

// ---------------------------------------------------------------------------
// The classifier read
// ---------------------------------------------------------------------------

test('preMergeRiskHoldReason: a risk-pattern path holds; everything else does not', () => {
  assert.match(preMergeRiskHoldReason(['src/migrations/003_add.sql'], BOUNDS) ?? '', /pre-merge risk hold/);
  assert.match(preMergeRiskHoldReason(['src/auth/session.ts'], BOUNDS) ?? '', /risk-flagged/);
  // Non-must tiers all fall through — the check only ever holds `must`.
  assert.equal(preMergeRiskHoldReason([], BOUNDS), null, 'no code ⇒ auto tier ⇒ no hold');
  assert.equal(preMergeRiskHoldReason(['.loopkit/state.json'], BOUNDS), null, 'plane-only ⇒ auto ⇒ no hold');
  assert.equal(preMergeRiskHoldReason(['src/public/app.ts'], BOUNDS), null, 'surface ⇒ review ⇒ no hold');
  assert.equal(preMergeRiskHoldReason(['src/lib/util.ts'], BOUNDS), null, 'ordinary code ⇒ optional ⇒ no hold');
});

test('preMergeRiskHoldReason: a judge fail is NOT a landing-risk class (the judge runs later and is advisory)', () => {
  // Passing the same file list post-merge WITH a judge fail would classify `must`; this pre-merge
  // read deliberately never sees a verdict, so an ordinary file never holds on judge grounds.
  assert.equal(preMergeRiskHoldReason(['src/lib/util.ts'], BOUNDS), null);
});

// ---------------------------------------------------------------------------
// Default-off — the load-bearing property
// ---------------------------------------------------------------------------

test('WI-180: the flag is OFF in the framework defaults and after a bare loadConfig', () => {
  assert.equal(CONFIG_DEFAULTS.preMergeRiskHold?.enabled, false);
  const repoRoot = makeTempDir();
  try {
    assert.equal(loadConfig(repoRoot).preMergeRiskHold?.enabled, false, 'no config file ⇒ off');
  } finally {
    cleanDir(repoRoot);
  }
});

test('WI-180: an explicit `true` in loopkit.config.json turns it on', () => {
  const repoRoot = makeTempDir();
  try {
    writeFileSync(join(repoRoot, 'loopkit.config.json'), JSON.stringify({ preMergeRiskHold: { enabled: true } }), 'utf8');
    assert.equal(loadConfig(repoRoot).preMergeRiskHold?.enabled, true);
  } finally {
    cleanDir(repoRoot);
  }
});

// ---------------------------------------------------------------------------
// End-to-end through a real build
// ---------------------------------------------------------------------------

function makeTestConfig(overrides: Partial<LoopkitConfig> = {}): LoopkitConfig {
  return {
    ...CONFIG_DEFAULTS,
    gateCommand: 'exit 0',
    gateWorkdir: '.',
    breakerN: 5,
    promptsDir: '.ai/loops/prompts',
    notifyHook: '.ai/notify-phone.sh',
    salvage: { enabled: false, maxPatchKb: 256 },
    autoApprove: { ...CONFIG_DEFAULTS.autoApprove, escalationPatterns: ['migrations/'] },
    ...overrides,
  };
}

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

/** A worker that ships a migration — a `must`-tier risk class under the config above. */
const migrationWorker: LlmProvider = {
  name: 'fake',
  async run(req: ProviderRequest): Promise<ProviderResult> {
    const { mkdirSync: md, writeFileSync: wf } = await import('node:fs');
    const { spawnSync: sp } = await import('node:child_process');
    md(join(req.cwd!, 'src', 'migrations'), { recursive: true });
    wf(join(req.cwd!, 'src/migrations/003_add_column.sql'), 'ALTER TABLE x ADD y;', 'utf8');
    sp('git', ['add', 'src/migrations/003_add_column.sql'], { cwd: req.cwd, stdio: 'pipe' });
    sp('git', ['commit', '-m', 'feat(WI-001): migration'], { cwd: req.cwd, stdio: 'pipe' });
    return { ok: true, text: 'done' };
  },
};

const SEED: LedgerEvent[] = [
  makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'add a column' }),
  makeEvent('cli', 'WI-001', 'item.queued', { spec: 'add a column', touches: 'src/' }),
];

test('WI-180: flag OFF — a must-tier risk diff merges exactly as it does today', async () => {
  const tmpDir = makeTempDir();
  try {
    const { repoRoot, ledgerDir, artifactDir } = await seedRepo(tmpDir, SEED);
    await runDispatch({
      repoRoot, ledgerDir, autonomy: 'on', provider: migrationWorker,
      gateResult: { passed: true, reason: 'ok' },
      branchProbe: () => 'master',
      pushProbe: () => ({ status: 0 }),
      config: makeTestConfig(),   // preMergeRiskHold defaults to { enabled: false }
      authProbeResult: { ok: true },
      artifactRunsDir: artifactDir,
      judgeEnabled: false,
    });
    const events = await loadAllEvents(ledgerDir);
    assert.equal(fold(events).items.get('WI-001')?.state, 'merged', 'default-off must not change what lands');
    assert.equal(events.filter(e => e.type === 'gate.parked').length, 0, 'no risk-tier park while the flag is off');
  } finally {
    cleanDir(tmpDir);
  }
});

test('WI-180: flag ON — the same build PARKS for the operator instead of landing, and never merges', async () => {
  const tmpDir = makeTempDir();
  try {
    const { repoRoot, ledgerDir, artifactDir } = await seedRepo(tmpDir, SEED);
    const result = await runDispatch({
      repoRoot, ledgerDir, autonomy: 'on', provider: migrationWorker,
      gateResult: { passed: true, reason: 'ok' },
      branchProbe: () => 'master',
      pushProbe: () => ({ status: 0 }),
      config: makeTestConfig({ preMergeRiskHold: { enabled: true } }),
      authProbeResult: { ok: true },
      artifactRunsDir: artifactDir,
      judgeEnabled: false,
    });

    const events = await loadAllEvents(ledgerDir);
    const folded = fold(events);
    assert.equal(folded.items.get('WI-001')?.state, 'parked', 'a must-tier risk class must not land unreviewed');

    const gateParked = events.find(e => e.type === 'gate.parked' && e.item === 'WI-001');
    assert.ok(gateParked, 'the hold is recorded as its own gate.parked class');
    assert.equal((gateParked!.data as { reason?: string }).reason, 'risk-tier');

    const parked = events.find(e => e.type === 'item.parked' && e.item === 'WI-001');
    assert.equal((parked!.data as { parkKind?: string }).parkKind, 'decision', 'it reaches the operator, not the health lane');
    assert.match((parked!.data as { reason?: string }).reason ?? '', /pre-merge risk hold/);
    assert.match((parked!.data as { reason?: string }).reason ?? '', /migrations/);

    // PARKS, never FAILS: no gate.failed, and the branch survives for review + a later merge.
    assert.equal(events.filter(e => e.type === 'gate.failed' && e.item === 'WI-001').length, 0, 'a hold is not a build failure');
    assert.equal(events.filter(e => e.type === 'item.merged' && e.item === 'WI-001').length, 0);
    const step = result.dispatched.find(d => d.item === 'WI-001');
    assert.ok(step?.branch, 'the branch is reported so the operator can review it');
    const branches = spawnSync('git', ['branch', '--list', step!.branch!], { cwd: repoRoot, stdio: 'pipe' }).stdout.toString();
    assert.match(branches, new RegExp(step!.branch!), 'the work is preserved on its branch, not discarded');
  } finally {
    cleanDir(tmpDir);
  }
});

test('WI-180: flag ON — a diff with no risk-class path is untouched by the hold', async () => {
  const tmpDir = makeTempDir();
  try {
    const { repoRoot, ledgerDir, artifactDir } = await seedRepo(tmpDir, SEED);
    const ordinaryWorker: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        const { mkdirSync: md, writeFileSync: wf } = await import('node:fs');
        const { spawnSync: sp } = await import('node:child_process');
        md(join(req.cwd!, 'src'), { recursive: true });
        wf(join(req.cwd!, 'src/util.ts'), '// util', 'utf8');
        sp('git', ['add', 'src/util.ts'], { cwd: req.cwd, stdio: 'pipe' });
        sp('git', ['commit', '-m', 'feat(WI-001): util'], { cwd: req.cwd, stdio: 'pipe' });
        return { ok: true, text: 'done' };
      },
    };
    await runDispatch({
      repoRoot, ledgerDir, autonomy: 'on', provider: ordinaryWorker,
      gateResult: { passed: true, reason: 'ok' },
      branchProbe: () => 'master',
      pushProbe: () => ({ status: 0 }),
      config: makeTestConfig({ preMergeRiskHold: { enabled: true } }),
      authProbeResult: { ok: true },
      artifactRunsDir: artifactDir,
      judgeEnabled: false,
    });
    assert.equal(fold(await loadAllEvents(ledgerDir)).items.get('WI-001')?.state, 'merged',
      'the hold is narrow — ordinary work still ships unattended with the flag on');
  } finally {
    cleanDir(tmpDir);
  }
});
