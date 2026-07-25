/**
 * reactor-merge-judge.test.ts — the reactor's post-merge judge backstop (stepMergeJudge).
 *
 * Root cause it fixes: the advisory merge-review judge (review.verdict) was implemented ONLY in the
 * dispatch beat's pre-merge terminal loop. Attended lanes (conductor / coordinator) emit item.merged
 * with the same shape but run no judge — so an attended-run plane produces ZERO review.verdict
 * events, starving the acceptance tier of its quality input. The reactor now judges any merged plane
 * item that carries no verdict yet, regardless of which lane merged it.
 *
 * Covers:
 *   mergeVerdictData  — pure verdict-event shaping (parsed pass/fail, unparseable, provider-fail→unavailable)
 *   reactor           — an unjudged plane merge gets a reactor review.verdict + cost.usage{loop:judge}
 *   reactor           — an already-judged merge is NOT re-judged (no duplicate verdict)
 *   reactor           — a registered-target merge is skipped (its commit range is not locally reachable)
 *   reactor           — a plane merge whose commit range is unreachable (fake sha) is skipped, never fabricated
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { makeEvent, LedgerEvent } from '../src/schema.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { runReactor } from '../src/beats/reactor.js';
import { mergeVerdictData } from '../src/judge.js';
import { CONFIG_DEFAULTS, LoopkitConfig } from '../src/config.js';
import { LlmProvider, ProviderResult } from '../src/providers/types.js';

let n = 0;
function tmp(): string {
  const d = join(tmpdir(), `loopkit-merge-judge-${process.pid}-${++n}-${Date.now()}`);
  mkdirSync(d, { recursive: true });
  return d;
}
function clean(d: string): void { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }

// Config is passed in directly (opts.config) so these tests never touch loadConfig / LOOPKIT_HOME.
function cfg(overrides: Partial<LoopkitConfig> = {}): LoopkitConfig {
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

/** git-init a repo with a base commit, then a second commit; return both SHAs + a changed file. */
function initRepoWithRange(repoRoot: string): { baseSha: string; headSha: string } {
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
  mkdirSync(join(repoRoot, '.ai', 'loops', 'prompts'), { recursive: true });
  writeFileSync(join(repoRoot, '.ai', 'loops', 'prompts', 'conductor.md'), 'stub', 'utf8');
  writeFileSync(join(repoRoot, '.ai', 'loops', 'prompts', 'engagement.md'), 'stub', 'utf8');
  const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
  g(['init', '-b', 'master']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  writeFileSync(join(repoRoot, 'x.txt'), 'x', 'utf8');
  g(['add', 'x.txt']);
  g(['commit', '-m', 'init']);
  const baseSha = g(['rev-parse', 'HEAD']).stdout.toString().trim();
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  writeFileSync(join(repoRoot, 'src', 'feature.ts'), 'export const feature = 1;\n', 'utf8');
  g(['add', '.']);
  g(['commit', '-m', 'feat: add feature']);
  const headSha = g(['rev-parse', 'HEAD']).stdout.toString().trim();
  return { baseSha, headSha };
}

/** A provider that answers any run() with a fixed judge grammar block. */
function makeJudgeProvider(text: string): LlmProvider {
  return {
    name: 'fakejudge',
    async run(): Promise<ProviderResult> {
      return { ok: true, text, usage: { in: 40, out: 20, usd: 0.0004 } };
    },
  };
}

const JUDGE_PASS = `VERDICT: pass
CONFIDENCE: 0.88
SPEC_SATISFIED: yes
SCOPE_CREEP: none
TEST_THEATRE: none
REASONS:
- src/feature.ts matches the spec`;

/** Build a merged plane item (no target) with a real, locally-reachable commit range. */
function mergedPlaneItem(id: string, baseSha: string, headSha: string, mergedAtIso: string): LedgerEvent[] {
  return [
    makeEvent('operator', id, 'item.captured', { source: 'cli', text: `build ${id}` }),
    makeEvent('conductor', id, 'item.queued', { spec: 'add feature to src/feature.ts', touches: 'src/' }),
    makeEvent('conductor', id, 'item.merged', {
      commit: headSha, sessionId: 'ses-attended',
      baseSha, headSha, changedFiles: ['src/feature.ts'], gateCommand: 'exit 0',
    }, mergedAtIso),
  ];
}

// ---------------------------------------------------------------------------
// mergeVerdictData — pure unit tests (no env, no git)
// ---------------------------------------------------------------------------

test('mergeVerdictData: parsed pass passes through with model + judge tag', () => {
  const v = mergeVerdictData(
    { parsed: { verdict: 'pass', confidence: 0.9, specSatisfied: 'yes', scopeCreep: 'none', testTheatre: 'none', reasons: ['ok'] } },
    'sonnet',
  );
  assert.equal(v.verdict, 'pass');
  assert.equal(v.confidence, 0.9);
  assert.equal(v.model, 'sonnet');
  assert.equal(v.judge, 'merge-review');
  assert.equal(v.reason, undefined, 'parsed verdict carries no provider-error reason');
});

test('mergeVerdictData: parsed unparseable passes through as unparseable', () => {
  const v = mergeVerdictData(
    { parsed: { verdict: 'unparseable', confidence: 0, specSatisfied: 'unknown', scopeCreep: 'unknown', testTheatre: 'unknown', reasons: ['unparseable judge output: ...'], raw: '...' } },
    'sonnet',
  );
  assert.equal(v.verdict, 'unparseable');
  assert.equal(v.confidence, 0);
});

test('mergeVerdictData: provider failure (parsed:null) → unavailable carrying the reason', () => {
  const v = mergeVerdictData({ parsed: null, providerError: 'judge provider timeout' }, 'sonnet');
  assert.equal(v.verdict, 'unavailable');
  assert.equal(v.confidence, 0);
  assert.equal(v.judge, 'merge-review');
  assert.ok((v.reason ?? '').includes('judge provider timeout'), 'reason must carry provider error');
  assert.ok(v.reasons[0]!.startsWith('judge unavailable:'), 'a REASONS bullet flags the gap');
});

// ---------------------------------------------------------------------------
// reactor backstop — integration
// ---------------------------------------------------------------------------

test('reactor: an unjudged plane merge gets a reactor review.verdict + cost.usage{loop:judge}', async () => {
  const base = tmp();
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  const { baseSha, headSha } = initRepoWithRange(repoRoot);
  await appendEvents(ledgerDir, mergedPlaneItem('WI-500', baseSha, headSha, new Date(Date.now() - 3_600_000).toISOString()));

  try {
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on',
      provider: makeJudgeProvider(JUDGE_PASS), pidProbe: () => true, config: cfg(),
    });
    const events = await loadAllEvents(ledgerDir);

    const verdicts = events.filter(e => e.type === 'review.verdict' && e.item === 'WI-500');
    assert.equal(verdicts.length, 1, 'reactor must emit exactly one review.verdict for the unjudged merge');
    assert.equal(verdicts[0]!.actor, 'reactor', 'verdict must be attributed to the reactor backstop');
    const vData = verdicts[0]!.data as { verdict: string; judge: string };
    assert.equal(vData.verdict, 'pass');
    assert.equal(vData.judge, 'merge-review');

    const judgeCost = events.filter(e =>
      e.type === 'cost.usage' && e.item === 'WI-500' && (e.data as { loop: string }).loop === 'judge');
    assert.equal(judgeCost.length, 1, 'reactor must meter the judge call as cost.usage{loop:judge}');
  } finally { clean(base); }
});

test('reactor: an already-judged merge is not re-judged (no duplicate verdict)', async () => {
  const base = tmp();
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  const { baseSha, headSha } = initRepoWithRange(repoRoot);
  await appendEvents(ledgerDir, [
    ...mergedPlaneItem('WI-501', baseSha, headSha, new Date(Date.now() - 3_600_000).toISOString()),
    // A pre-existing verdict (e.g. the beat's own pre-merge judge already stamped this lane).
    makeEvent('dispatch', 'WI-501', 'review.verdict', {
      verdict: 'pass', confidence: 0.95, specSatisfied: 'yes', scopeCreep: 'none',
      testTheatre: 'none', reasons: ['already judged'], model: 'sonnet', judge: 'merge-review',
    } as import('../src/schema.js').ReviewVerdictData),
  ]);

  try {
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on',
      provider: makeJudgeProvider(JUDGE_PASS), pidProbe: () => true, config: cfg(),
    });
    const events = await loadAllEvents(ledgerDir);
    const verdicts = events.filter(e => e.type === 'review.verdict' && e.item === 'WI-501');
    assert.equal(verdicts.length, 1, 'the reactor must NOT append a second verdict to an already-judged item');
    assert.equal(verdicts[0]!.actor, 'dispatch', 'the sole verdict remains the original one');
  } finally { clean(base); }
});

test('reactor: a registered-target merge is skipped by the backstop (range not locally reachable)', async () => {
  const base = tmp();
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  const { baseSha, headSha } = initRepoWithRange(repoRoot);
  await appendEvents(ledgerDir, [
    // targetId on capture → the item belongs to a registered target; its merge landed in the
    // target's repo, not the plane repo, so its commit range is not locally reachable here.
    makeEvent('operator', 'WI-502', 'item.captured', { source: 'cli', text: 'target build', target: 'acme', targetId: 'tgt-abc' }),
    makeEvent('conductor', 'WI-502', 'item.queued', { spec: 'x', touches: 'src/' }),
    makeEvent('conductor', 'WI-502', 'item.merged', {
      commit: headSha, sessionId: 'ses-attended',
      baseSha, headSha, changedFiles: ['src/feature.ts'], gateCommand: 'exit 0',
    }),
  ]);

  try {
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on',
      provider: makeJudgeProvider(JUDGE_PASS), pidProbe: () => true, config: cfg(),
    });
    const events = await loadAllEvents(ledgerDir);
    const verdicts = events.filter(e => e.type === 'review.verdict' && e.item === 'WI-502');
    assert.equal(verdicts.length, 0, 'target-repo merges are deferred — the backstop only judges plane merges');
  } finally { clean(base); }
});

test('reactor: a plane merge with an unreachable commit range is skipped, never fabricated', async () => {
  const base = tmp();
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  initRepoWithRange(repoRoot);
  // Fake, unreachable SHAs → empty diff → skip (do not fabricate a verdict on absent material).
  await appendEvents(ledgerDir, mergedPlaneItem('WI-503', 'deadbeef', 'cafebabe', new Date(Date.now() - 3_600_000).toISOString()));

  try {
    await runReactor({
      repoRoot, ledgerDir, autonomy: 'on',
      provider: makeJudgeProvider(JUDGE_PASS), pidProbe: () => true, config: cfg(),
    });
    const events = await loadAllEvents(ledgerDir);
    const verdicts = events.filter(e => e.type === 'review.verdict' && e.item === 'WI-503');
    assert.equal(verdicts.length, 0, 'an unreachable range yields an empty diff — the item is skipped, not fabricated');
  } finally { clean(base); }
});
