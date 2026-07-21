/**
 * audit.test.ts — `loopctl audit <target>` (target-readiness hygiene checker).
 *
 * Covers:
 *   1. checks.ts: each pure check classifies a fabricated AuditProbeData snapshot correctly
 *   2. score.ts: cumulative tiering (0-5) from check outcomes
 *   3. runAudit: end-to-end against a real tmp target tree (git repo + ledger + config)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  AuditProbeData,
  checkLedgerPresent,
  checkLedgerReadable,
  checkGatesConfigured,
  checkBudgetDefined,
  checkRecentCommits,
  checkRecentEvents,
  checkServiceLabels,
  checkDepsWorkdirs,
  checkGateEnv,
  findPlaneEnvExtras,
  runChecks,
} from '../src/audit/checks.js';
import { scoreAutonomyTier } from '../src/audit/score.js';
import { runAudit } from '../src/audit/index.js';
import { appendEvents } from '../src/ledger.js';
import { makeEvent } from '../src/schema.js';

// ---------------------------------------------------------------------------
// checks.ts (pure)
// ---------------------------------------------------------------------------

const BASE: AuditProbeData = {
  configPresent: false,
  recentCommitDays: 7,
  recentEventDays: 30,
};

test('checkLedgerPresent: passes only with a non-empty segment list', () => {
  assert.equal(checkLedgerPresent(BASE).passed, false);
  assert.equal(checkLedgerPresent({ ...BASE, ledgerSegments: [] }).passed, false);
  assert.equal(checkLedgerPresent({ ...BASE, ledgerSegments: ['work-2026-07.jsonl'] }).passed, true);
});

test('checkLedgerReadable: undefined (not probed) and false (parse failure) both fail', () => {
  assert.equal(checkLedgerReadable(BASE).passed, false);
  assert.equal(checkLedgerReadable({ ...BASE, ledgerReadable: false }).passed, false);
  assert.equal(checkLedgerReadable({ ...BASE, ledgerReadable: true }).passed, true);
});

test('checkGatesConfigured: requires both configPresent and a non-empty gateCommand', () => {
  assert.equal(checkGatesConfigured(BASE).passed, false);
  assert.equal(checkGatesConfigured({ ...BASE, configPresent: true }).passed, false);
  assert.equal(checkGatesConfigured({ ...BASE, configPresent: true, gateCommand: '  ' }).passed, false);
  assert.equal(checkGatesConfigured({ ...BASE, configPresent: true, gateCommand: 'npm test' }).passed, true);
  // A gateCommand without configPresent (shouldn't happen from real probes, but stay strict).
  assert.equal(checkGatesConfigured({ ...BASE, gateCommand: 'npm test' }).passed, false);
});

test('checkBudgetDefined: requires a positive finite ceiling', () => {
  assert.equal(checkBudgetDefined(BASE).passed, false);
  assert.equal(checkBudgetDefined({ ...BASE, budgetUsd: 0 }).passed, false);
  assert.equal(checkBudgetDefined({ ...BASE, budgetUsd: -5 }).passed, false);
  assert.equal(checkBudgetDefined({ ...BASE, budgetUsd: 12.5 }).passed, true);
});

test('checkRecentCommits / checkRecentEvents: undefined = unmeasurable, 0 = measured-but-idle, >0 = active', () => {
  assert.equal(checkRecentCommits(BASE).passed, false);
  assert.equal(checkRecentCommits({ ...BASE, recentCommitCount: 0 }).passed, false);
  assert.equal(checkRecentCommits({ ...BASE, recentCommitCount: 3 }).passed, true);

  assert.equal(checkRecentEvents(BASE).passed, false);
  assert.equal(checkRecentEvents({ ...BASE, recentEventCount: 0 }).passed, false);
  assert.equal(checkRecentEvents({ ...BASE, recentEventCount: 5 }).passed, true);
});

test('runChecks: returns all nine checks in a stable order', () => {
  const ids = runChecks(BASE).map(c => c.id);
  assert.deepEqual(ids, [
    'ledger-present', 'ledger-readable', 'gates-configured',
    'budget-defined', 'recent-commits', 'recent-events',
    'service-labels', 'deps-workdirs', 'gate-env',
  ]);
});

// ---------------------------------------------------------------------------
// Onboarding preflight detectors (service labels · manifest depsWorkdirs · gate env) —
// each finding must NAME THE FIX, not just the problem.
// ---------------------------------------------------------------------------

test('checkServiceLabels: a configured loop label matching no installed service fires and names the fix', () => {
  const r = checkServiceLabels({
    ...BASE,
    reactorLabel: 'com.example.reactor',
    dispatchLabel: 'com.example.dispatch',
    installedServiceLabels: ['com.example.reactor'], // dispatch missing
  });
  assert.equal(r.passed, false);
  assert.ok(r.message.includes('com.example.dispatch'), r.message);
  assert.ok(/launchctl bootstrap/.test(r.message), 'the finding must name the bootstrap fix');
  assert.ok(/loops\.reactorLabel\/dispatchLabel/.test(r.message), 'the finding must name the config fix');
});

test('checkServiceLabels: matching labels pass; unconfigured labels and an unprobeable platform skip gracefully', () => {
  assert.equal(checkServiceLabels({
    ...BASE,
    reactorLabel: 'com.example.reactor',
    installedServiceLabels: ['com.example.reactor'],
  }).passed, true);
  // No labels configured → pass with a note, never a failure.
  const unconfigured = checkServiceLabels(BASE);
  assert.equal(unconfigured.passed, true);
  assert.ok(/watchdog|disabled/i.test(unconfigured.message), unconfigured.message);
  // Labels configured but service manager unprobeable (non-darwin) → skip, never fail.
  const skipped = checkServiceLabels({ ...BASE, reactorLabel: 'com.example.reactor' });
  assert.equal(skipped.passed, true);
  assert.ok(/skipped/i.test(skipped.message), skipped.message);
});

test('checkDepsWorkdirs: package.json + empty manifest depsWorkdirs fires with the exact manifest snippet', () => {
  const r = checkDepsWorkdirs({
    ...BASE,
    manifestPresent: true,
    manifestDepsWorkdirs: [],
    packageJsonPresent: true,
  });
  assert.equal(r.passed, false);
  assert.ok(r.message.includes('"depsWorkdirs": ["."]'), `the finding must carry the exact snippet (got: ${r.message})`);
  assert.ok(/127/.test(r.message), 'the finding must explain the 127 failure mode');
});

test('checkDepsWorkdirs: passes when deps are declared, and skips when there is no manifest or no package.json', () => {
  assert.equal(checkDepsWorkdirs({
    ...BASE, manifestPresent: true, manifestDepsWorkdirs: ['.'], packageJsonPresent: true,
  }).passed, true);
  assert.equal(checkDepsWorkdirs({ ...BASE, manifestPresent: false }).passed, true);
  assert.equal(checkDepsWorkdirs({
    ...BASE, manifestPresent: true, manifestDepsWorkdirs: [], packageJsonPresent: false,
  }).passed, true);
  // Present but unreadable manifest → fail, naming the repair.
  const unreadable = checkDepsWorkdirs({ ...BASE, manifestPresent: true, packageJsonPresent: true });
  assert.equal(unreadable.passed, false);
  assert.ok(/repair/i.test(unreadable.message), unreadable.message);
});

test('checkGateEnv: stray plane identity vars fire and name each var + the unset fix', () => {
  const extras = findPlaneEnvExtras({
    LOOPKIT_HOME: '/home/plane',       // allowed (shim export)
    LOOPKIT_AUTONOMY: 'on',            // allowed (shim export)
    LOOPKIT_LEDGER: '/somewhere/else', // leak
    LOOPKIT_REPO: '/another/repo',     // leak
    PATH: '/usr/bin',
  });
  assert.deepEqual(extras, ['LOOPKIT_LEDGER', 'LOOPKIT_REPO']);
  const r = checkGateEnv({ ...BASE, planeEnvExtras: extras });
  assert.equal(r.passed, false);
  assert.ok(r.message.includes('LOOPKIT_LEDGER') && r.message.includes('LOOPKIT_REPO'), r.message);
  assert.ok(/unset LOOPKIT_LEDGER LOOPKIT_REPO/.test(r.message), 'the finding must name the exact unset fix');
  assert.ok(r.message.includes('LOOPKIT_HOME'), 'the finding must name what IS allowed');
});

test('checkGateEnv: a clean env (only the shim exports) passes', () => {
  assert.deepEqual(findPlaneEnvExtras({ LOOPKIT_HOME: '/h', LOOPKIT_AUTONOMY: 'on', HOME: '/u' }), []);
  assert.equal(checkGateEnv({ ...BASE, planeEnvExtras: [] }).passed, true);
});

// ---------------------------------------------------------------------------
// score.ts (pure)
// ---------------------------------------------------------------------------

test('scoreAutonomyTier: cumulative tiers, never skip ahead of a failed prerequisite', () => {
  const none = scoreAutonomyTier(runChecks(BASE));
  assert.equal(none.tier, 0);

  const ledgerOnly = scoreAutonomyTier(runChecks({
    ...BASE, ledgerSegments: ['work-2026-07.jsonl'], ledgerReadable: true,
  }));
  assert.equal(ledgerOnly.tier, 1);

  const withGates = scoreAutonomyTier(runChecks({
    ...BASE, ledgerSegments: ['work-2026-07.jsonl'], ledgerReadable: true,
    configPresent: true, gateCommand: 'npm test',
  }));
  assert.equal(withGates.tier, 2);

  const withBudget = scoreAutonomyTier(runChecks({
    ...BASE, ledgerSegments: ['work-2026-07.jsonl'], ledgerReadable: true,
    configPresent: true, gateCommand: 'npm test', budgetUsd: 10,
  }));
  assert.equal(withBudget.tier, 3);

  const withSomeActivity = scoreAutonomyTier(runChecks({
    ...BASE, ledgerSegments: ['work-2026-07.jsonl'], ledgerReadable: true,
    configPresent: true, gateCommand: 'npm test', budgetUsd: 10, recentCommitCount: 2,
  }));
  assert.equal(withSomeActivity.tier, 4);

  const fullyActive = scoreAutonomyTier(runChecks({
    ...BASE, ledgerSegments: ['work-2026-07.jsonl'], ledgerReadable: true,
    configPresent: true, gateCommand: 'npm test', budgetUsd: 10,
    recentCommitCount: 2, recentEventCount: 4,
  }));
  assert.equal(fullyActive.tier, 5);

  // Gates skipped but budget somehow set (shouldn't happen via real probes) — tier caps at 1,
  // never jumps to 3 on a later check alone.
  const skippedPrereq = scoreAutonomyTier(runChecks({
    ...BASE, ledgerSegments: ['work-2026-07.jsonl'], ledgerReadable: true, budgetUsd: 10,
  }));
  assert.equal(skippedPrereq.tier, 1);
});

// ---------------------------------------------------------------------------
// runAudit (end-to-end against a real tmp target tree)
// ---------------------------------------------------------------------------

let testCount = 0;
function makeTempDir(): string {
  const dir = join(tmpdir(), `loopkit-audit-${process.pid}-${++testCount}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function cleanDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
function git(repoRoot: string, args: string[]): void {
  spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
}

test('runAudit: bare directory (no git, no ledger, no config) scores tier 0', async () => {
  const target = makeTempDir();
  try {
    const result = await runAudit(target, { now: Date.parse('2026-07-19T12:00:00Z') });
    assert.equal(result.score.tier, 0);
    assert.equal(result.checks.find(c => c.id === 'ledger-present')?.passed, false);
    assert.equal(result.checks.find(c => c.id === 'gates-configured')?.passed, false);
  } finally {
    cleanDir(target);
  }
});

test('runAudit: fully onboarded + active target scores tier 5', async () => {
  const target = makeTempDir();
  try {
    git(target, ['init', '-b', 'master']);
    git(target, ['config', 'user.email', 't@t']);
    git(target, ['config', 'user.name', 't']);
    writeFileSync(join(target, 'README.md'), 'target', 'utf8');
    git(target, ['add', 'README.md']);
    git(target, ['commit', '-m', 'init']);

    writeFileSync(
      join(target, 'loopkit.config.json'),
      JSON.stringify({ gateCommand: 'npm test', budget: { dispatchDailyUsd: 5 } }),
      'utf8',
    );

    const ledgerDir = join(target, '.ai', 'ledger');
    mkdirSync(ledgerDir, { recursive: true });
    const now = Date.parse('2026-07-19T12:00:00Z');
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'test' }, new Date(now - 60_000).toISOString()),
    ]);

    const result = await runAudit(target, { now });
    assert.equal(result.score.tier, 5, JSON.stringify(result.checks));
    assert.equal(result.checks.find(c => c.id === 'recent-commits')?.passed, true);
    assert.equal(result.checks.find(c => c.id === 'recent-events')?.passed, true);
  } finally {
    cleanDir(target);
  }
});

test('runAudit: preflight probes — manifest depsWorkdirs gap, injected service labels, and gate-env leak all surface end-to-end', async () => {
  const target = makeTempDir();
  try {
    // A node repo (package.json) with a registered-target manifest that declares NO depsWorkdirs.
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'demo' }), 'utf8');
    writeFileSync(join(target, 'loopkit.target.json'), JSON.stringify({ name: 'demo' }), 'utf8');
    writeFileSync(
      join(target, 'loopkit.config.json'),
      JSON.stringify({
        gateCommand: 'npm test',
        loops: { reactorLabel: 'com.example.reactor', dispatchLabel: 'com.example.dispatch' },
      }),
      'utf8',
    );

    const result = await runAudit(target, {
      now: Date.parse('2026-07-19T12:00:00Z'),
      serviceLabelsProbe: () => ['com.example.reactor'], // dispatch label not installed
      env: { LOOPKIT_HOME: '/h', LOOPKIT_AUTONOMY: 'on', LOOPKIT_LEDGER: '/leak' },
    });

    const labels = result.checks.find(c => c.id === 'service-labels')!;
    assert.equal(labels.passed, false);
    assert.ok(labels.message.includes('com.example.dispatch'), labels.message);

    const deps = result.checks.find(c => c.id === 'deps-workdirs')!;
    assert.equal(deps.passed, false);
    assert.ok(deps.message.includes('"depsWorkdirs": ["."]'), deps.message);

    const env = result.checks.find(c => c.id === 'gate-env')!;
    assert.equal(env.passed, false);
    assert.ok(env.message.includes('LOOPKIT_LEDGER'), env.message);
  } finally {
    cleanDir(target);
  }
});

test('runAudit: a malformed loopkit.config.json degrades to gates-configured=false, never throws', async () => {
  const target = makeTempDir();
  try {
    writeFileSync(join(target, 'loopkit.config.json'), '{ not valid json', 'utf8');
    const result = await runAudit(target);
    assert.equal(result.checks.find(c => c.id === 'gates-configured')?.passed, false);
  } finally {
    cleanDir(target);
  }
});
