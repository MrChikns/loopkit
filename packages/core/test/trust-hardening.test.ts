/**
 * trust-hardening.test.ts — proofs for the trust-hardening slice.
 *
 * Covers the three independently-reviewed defects + two supporting invariants:
 *   (a) acceptance tier classifies from ACTUAL merge evidence, not declared touches metadata —
 *       a merge with real changed files but empty declared touches can never fold as
 *       "no code changed → auto".
 *   (b) a judge attempt that produced no usable verdict is never silent: it records
 *       review.verdict:'unavailable' and floors the item at 'review' (while a never-judged item
 *       stays auto).
 *   (c) provider resolution is per-item, fail-closed: a 'private' item never resolves an
 *       external-only chain, and an invalid/unknown sensitivity is treated as 'private'.
 *   evidence — dispatch records base/head/changedFiles/gateCommand on item.merged.
 *   deploy — a merge with an empty deployCommand appends no deploy events and runs no command.
 *
 * Vocabulary is generic (operator/task); fixtures use WI- ids because the fold + acceptance
 * projections pin the `^WI-\d+$` addressee format.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { makeEvent, LedgerEvent, ItemMergedData, MERGE_EVIDENCE_FILES_CAP } from '../src/schema.js';
import { fold } from '../src/fold.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { runDispatch, runPlanningLane, runTargetLane } from '../src/beats/dispatch.js';
import { mergeEvidence, groupSensitivity, resolveProviderForSensitivity, itemSensitivity } from '../src/beats/dispatch.js';
import { runReactor } from '../src/beats/reactor.js';
import { fireDeployOnMerge } from '../src/beats/worktree-deps.js';
import {
  classifyAcceptanceTier,
  acceptanceClassifyFiles,
  hasEvidenceGap,
  overseerFloor,
  AcceptanceTierClassifyConfig,
} from '../src/acceptance.js';
import { makeRegistry, normalizeSensitivity } from '../src/providers/registry.js';
import { loadConfig, CONFIG_DEFAULTS, LoopkitConfig } from '../src/config.js';
import { LlmProvider, ProviderRequest, ProviderResult } from '../src/providers/types.js';

// ---------------------------------------------------------------------------
// Test helpers (mirrors judge-review.test.ts / acceptance-tiers.test.ts)
// ---------------------------------------------------------------------------

let testCount = 0;

function makeTempDir(): string {
  const dir = join(tmpdir(), `loopkit-trust-${process.pid}-${++testCount}-${Date.now()}`);
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
    ...overrides,
  };
}

async function makeDispatchEnv(ledgerEvents: LedgerEvent[]): Promise<{
  repoRoot: string;
  ledgerDir: string;
  cleanup: () => void;
}> {
  const base = makeTempDir();
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  mkdirSync(join(repoRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
  mkdirSync(ledgerDir, { recursive: true });

  const { spawnSync } = await import('node:child_process');
  const g = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
  g(['init', '-b', 'master']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  writeFileSync(join(repoRoot, 'base.txt'), 'base', 'utf8');
  g(['add', 'base.txt']);
  g(['commit', '-m', 'init']);

  await appendEvents(ledgerDir, ledgerEvents);
  return { repoRoot, ledgerDir, cleanup: () => cleanDir(base) };
}

/** Provider that commits a file to the worktree and returns ok. */
function makeCommitProvider(filename = 'src/feature.ts', content = '// built'): LlmProvider {
  return {
    name: 'fake',
    async run(req: ProviderRequest): Promise<ProviderResult> {
      const { spawnSync } = await import('node:child_process');
      const { mkdirSync: mkdir, writeFileSync: wf } = await import('node:fs');
      mkdir(join(req.cwd!, 'src'), { recursive: true });
      wf(join(req.cwd!, filename), content, 'utf8');
      spawnSync('git', ['add', filename], { cwd: req.cwd, stdio: 'pipe' });
      spawnSync('git', ['commit', '-m', 'feat(WI-001): implement'], { cwd: req.cwd, stdio: 'pipe' });
      return { ok: true, text: 'done', usage: { in: 100, out: 50, usd: 0.001 } };
    },
  };
}

/** Minimal classifier config — no risk/plane/surface prefixes, so path class is neutral. */
function neutralClassifyConfig(overrides: Partial<AcceptanceTierClassifyConfig> = {}): AcceptanceTierClassifyConfig {
  return { surfacePrefixes: [], planePrefixes: [], riskPatterns: [], ...overrides };
}

// ===========================================================================
// (a) Merge evidence recorded on item.merged
// ===========================================================================

test('evidence: dispatch records base/head/changedFiles/gateCommand on item.merged', async () => {
  const { repoRoot, ledgerDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'build a thing' }),
    makeEvent('conductor', 'WI-001', 'item.queued', { spec: 'add a file', touches: 'src/' }),
  ]);
  try {
    await runDispatch({
      repoRoot, ledgerDir, autonomy: 'on',
      provider: makeCommitProvider('src/feature.ts'),
      config: makeTestConfig({ gateCommand: 'exit 0' }),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
      touchesDiffFiles: ['src/feature.ts'],
      pushProbe: () => ({ status: 0 }),
      scoutEnabled: false,
      judgeEnabled: false,
    });
    const events = await loadAllEvents(ledgerDir);
    const merged = events.filter(e => e.type === 'item.merged' && e.item === 'WI-001');
    assert.equal(merged.length, 1, 'item must merge');
    const d = merged[0]!.data as unknown as ItemMergedData;
    assert.deepEqual(d.changedFiles, ['src/feature.ts'], 'changedFiles must be the actual diff');
    assert.ok(d.baseSha && /^[0-9a-f]{7,40}$/.test(d.baseSha), 'baseSha must be a commit sha');
    assert.ok(d.headSha && d.headSha.length > 0, 'headSha (merge commit) must be recorded');
    assert.equal(d.gateCommand, 'exit 0', 'gateCommand must be the command that proved the build');
    assert.notEqual(d.changedFilesTruncated, true, 'a small diff is not truncated');
  } finally {
    cleanup();
  }
});

test('evidence: fold retains merge evidence on the item record', () => {
  const events: LedgerEvent[] = [
    makeEvent('cli', 'WI-002', 'item.captured', { source: 'cli', text: 'x' }),
    makeEvent('conductor', 'WI-002', 'item.queued', { spec: 's', touches: 'src/' }),
    makeEvent('dispatch', 'WI-002', 'item.merged', {
      commit: 'abc1234', deployed: false,
      baseSha: 'base000', headSha: 'head111',
      changedFiles: ['src/a.ts', 'src/b.ts'], gateCommand: 'npm test',
    } as ItemMergedData),
  ];
  const rec = fold(events).items.get('WI-002')!;
  assert.equal(rec.mergeBaseSha, 'base000');
  assert.equal(rec.mergeHeadSha, 'head111');
  assert.deepEqual(rec.mergeChangedFiles, ['src/a.ts', 'src/b.ts']);
  assert.equal(rec.mergeGateCommand, 'npm test');
});

test('evidence: changedFiles is capped and marks truncation past the cap', () => {
  const many = Array.from({ length: MERGE_EVIDENCE_FILES_CAP + 25 }, (_, i) => `src/f${i}.ts`);
  const ev = mergeEvidence('b', 'h', many, 'npm test');
  assert.equal(ev.changedFiles!.length, MERGE_EVIDENCE_FILES_CAP, 'list is capped');
  assert.equal(ev.changedFilesTruncated, true, 'truncation flag set past the cap');
});

// ===========================================================================
// (a) Evidence-based tier overrides empty declared touches — the hole closed
// ===========================================================================

test('tier: evidence with real files overrides empty declared touches (never auto)', () => {
  const cfg = neutralClassifyConfig();
  // The (a) hole: declared touches empty, but a real code file changed.
  const files = acceptanceClassifyFiles(['src/real.ts'], /* declaredTouches */ '');
  assert.deepEqual(files, ['src/real.ts'], 'evidence wins over empty declared touches');
  const { tier } = classifyAcceptanceTier(files, undefined, cfg);
  assert.notEqual(tier, 'auto', 'a merge with real changed files must never classify auto');
  assert.equal(tier, 'optional', 'non-surface real code → optional');
});

test('tier: empty declared touches WITHOUT evidence still classifies auto (legacy path)', () => {
  const cfg = neutralClassifyConfig();
  // Legacy item: no evidence (undefined), empty touches → falls back to touches → no files → auto.
  const files = acceptanceClassifyFiles(undefined, '');
  assert.deepEqual(files, [], 'no evidence + empty touches → empty file list');
  const { tier } = classifyAcceptanceTier(files, undefined, cfg);
  assert.equal(tier, 'auto', 'a genuine no-code legacy item keeps its auto path');
});

test('tier: evidence with zero files (no-code merge) classifies auto', () => {
  const cfg = neutralClassifyConfig();
  const files = acceptanceClassifyFiles([], 'src/'); // evidence present but empty → truly no-code
  assert.deepEqual(files, [], 'empty evidence wins over non-empty touches');
  const { tier } = classifyAcceptanceTier(files, undefined, cfg);
  assert.equal(tier, 'auto', 'a proven no-code merge stays auto');
});

// ===========================================================================
// (d) attended item.merged with no touches — evidence-gap conservative default
// ===========================================================================

const GATE_PROOF = { gateCommand: 'npm test' };

test('hasEvidenceGap: no evidence + no touches, but a gate ran → gap', () => {
  assert.equal(hasEvidenceGap(undefined, undefined, GATE_PROOF), true);
});

test('hasEvidenceGap: no evidence + no touches + no build proof → NOT a gap (genuine no-code stub merge)', () => {
  // A question/feedback item's item.merged is just `{ commit, deployed }` — no gate, no shas.
  // That must stay indistinguishable from "no code" and keep auto-accepting.
  assert.equal(hasEvidenceGap(undefined, undefined, undefined), false);
  assert.equal(hasEvidenceGap(undefined, undefined, {}), false);
});

test('hasEvidenceGap: evidence present (even empty array) → no gap, it is proven no-code', () => {
  assert.equal(hasEvidenceGap([], undefined, GATE_PROOF), false);
});

test('hasEvidenceGap: declared touches present → no gap', () => {
  assert.equal(hasEvidenceGap(undefined, 'packages/opsui/', GATE_PROOF), false);
});

test('hasEvidenceGap: baseSha/headSha alone (no gateCommand) also proves a real build → gap', () => {
  assert.equal(hasEvidenceGap(undefined, undefined, { baseSha: 'b', headSha: 'h' }), true);
});

test('tier: attended item.merged with gate proof but no touches/evidence → review, not auto', () => {
  // The reported bug: a fast-drain `item.merged --data` append carries the build's gateCommand/sha
  // evidence but the operator forgot `touches`. acceptanceClassifyFiles collapses to [] exactly
  // as the no-code path does, but the caller now also threads hasEvidenceGap through so the
  // classifier holds at 'review' instead of silently auto-accepting a code-bearing merge.
  const cfg = neutralClassifyConfig();
  const files = acceptanceClassifyFiles(undefined, undefined);
  const gap = hasEvidenceGap(undefined, undefined, GATE_PROOF);
  const { tier, reason } = classifyAcceptanceTier(files, undefined, cfg, gap);
  assert.equal(tier, 'review', 'missing touches on a proven build must never silently auto-accept');
  assert.match(reason, /conservative default/);
});

test('tier: a genuine no-code stub merge (no gate/sha proof) still classifies auto', () => {
  const cfg = neutralClassifyConfig();
  const files = acceptanceClassifyFiles(undefined, undefined);
  const gap = hasEvidenceGap(undefined, undefined, undefined);
  const { tier } = classifyAcceptanceTier(files, undefined, cfg, gap);
  assert.equal(tier, 'auto', 'a question/feedback item.merged with no build proof keeps its auto path');
});

test('tier: evidence-gap floor is upgrade-only — a judge fail still wins must', () => {
  const cfg = neutralClassifyConfig();
  const files = acceptanceClassifyFiles(undefined, undefined);
  const gap = hasEvidenceGap(undefined, undefined, GATE_PROOF);
  const { tier } = classifyAcceptanceTier(files, { verdict: 'fail' }, cfg, gap);
  assert.equal(tier, 'must');
});

test('tier: evidence-gap does not fire when touches ARE declared and match a surface prefix (opsui) → review', () => {
  // Requirement (2): touches that DO exist and land on a declared surface prefix must still
  // classify review via the ordinary surface rule, not fall through the evidence-gap path.
  const cfg: AcceptanceTierClassifyConfig = {
    surfacePrefixes: ['packages/opsui/'],
    planePrefixes: [],
    riskPatterns: [],
  };
  const files = acceptanceClassifyFiles(undefined, 'packages/opsui/');
  const gap = hasEvidenceGap(undefined, 'packages/opsui/', GATE_PROOF);
  assert.equal(gap, false, 'declared touches present — no evidence gap');
  const { tier, reason } = classifyAcceptanceTier(files, undefined, cfg, gap);
  assert.equal(tier, 'review');
  assert.match(reason, /user-facing surface/);
});

test('tier: evidence-gap default (omitted) preserves old behavior for direct callers (e.g. runClaimAuditGate)', () => {
  const cfg = neutralClassifyConfig();
  const { tier } = classifyAcceptanceTier([], undefined, cfg);
  assert.equal(tier, 'auto', 'a caller that never opts into evidenceGap keeps a real empty-files result auto');
});

// ---------------------------------------------------------------------------
// (a2) TRUNCATED diff evidence fails closed — a partially-known diff can never
//      auto/optional-accept, because a risk path beyond the cap is unseen.
// ---------------------------------------------------------------------------

test('tier: TRUNCATED diff evidence cannot be tiered below review (neutral paths)', () => {
  const cfg = neutralClassifyConfig();
  // The captured files look neutral (base tier would be 'optional'), but the diff was truncated —
  // an unseen risk path could exist beyond the cap, so the classifier must fail closed to 'review'.
  const files = ['src/a.ts', 'src/b.ts'];
  const { tier, reason } = classifyAcceptanceTier(files, undefined, cfg, false, /* evidenceTruncated */ true);
  assert.equal(tier, 'review', 'truncated evidence must never tier below review');
  assert.match(reason, /truncat/i, 'reason names truncation');
});

test('tier: TRUNCATED evidence on plane-only paths still floors at review (not auto)', () => {
  // Every captured path is plane-internal → base tier 'auto'. Truncation must still override that:
  // the unseen tail of the diff could touch a surface or risk path.
  const cfg = neutralClassifyConfig({ planePrefixes: ['src/'] });
  const files = ['src/plane.ts'];
  const untruncated = classifyAcceptanceTier(files, undefined, cfg, false, false);
  assert.equal(untruncated.tier, 'auto', 'a fully-known plane diff is auto');
  const truncated = classifyAcceptanceTier(files, undefined, cfg, false, true);
  assert.equal(truncated.tier, 'review', 'the SAME diff, truncated, floors to review');
});

test('tier: truncation floor is upgrade-only — a judge fail still wins must', () => {
  const cfg = neutralClassifyConfig();
  const files = ['src/a.ts'];
  const { tier } = classifyAcceptanceTier(files, { verdict: 'fail' }, cfg, false, true);
  assert.equal(tier, 'must', 'truncation never lowers a must-tier item');
});

test('tier: truncation default (omitted) preserves untruncated behavior', () => {
  const cfg = neutralClassifyConfig();
  const files = ['src/a.ts'];
  const { tier } = classifyAcceptanceTier(files, undefined, cfg);
  assert.equal(tier, 'optional', 'omitting evidenceTruncated keeps the base tier for a complete diff');
});

test('tier: an ABSENT-evidence approved merge (gate ran, no changedFiles, no touches) cannot tier below review', () => {
  // Mirrors the reactor's acceptance call for an approved merge that recorded a gate/sha but no
  // changed-file list and whose item carries no declared touches: acceptanceClassifyFiles collapses
  // to [] (which would otherwise read as no-code → auto), but hasEvidenceGap detects a real build,
  // so the classifier must fail closed to 'review'.
  const cfg = neutralClassifyConfig();
  const files = acceptanceClassifyFiles(undefined, undefined);   // no evidence + no touches → []
  assert.deepEqual(files, [], 'no evidence and no touches collapses to empty files');
  const gap = hasEvidenceGap(undefined, undefined, { gateCommand: 'npm test', baseSha: 'b', headSha: 'h' });
  assert.equal(gap, true, 'a gate/sha with no diff+touches is an evidence gap, not proven no-code');
  const { tier } = classifyAcceptanceTier(files, undefined, cfg, gap);
  assert.equal(tier, 'review', 'an approved merge with no changed-file evidence must never auto-accept');
});

test('fold: item.merged carrying changedFilesTruncated is retained on the record', () => {
  const events: LedgerEvent[] = [
    makeEvent('cli', 'WI-050', 'item.captured', { source: 'cli', text: 'big change' }),
    makeEvent('conductor', 'WI-050', 'item.queued', { spec: 's', touches: 'src/' }),
    makeEvent('reactor', 'WI-050', 'item.merged', {
      commit: 'abc1234', deployed: false,
      baseSha: 'base000', headSha: 'head111', gateCommand: 'npm test',
      changedFiles: ['src/a.ts'], changedFilesTruncated: true,
    } as ItemMergedData),
  ];
  const rec = fold(events).items.get('WI-050')!;
  assert.equal(rec.mergeChangedFilesTruncated, true, 'the fold retains the truncation flag for the classifier');
});

// ===========================================================================
// (b) Judge-unavailable floors at review; never-judged stays auto
// ===========================================================================

test('tier: judge-unavailable floors a real-code merge at review', () => {
  const cfg = neutralClassifyConfig();
  const files = ['src/real.ts'];
  const floor = overseerFloor(files, { verdict: 'unavailable', confidence: 0 }, 0.7);
  assert.ok(floor, 'unavailable must produce a floor');
  assert.equal(floor!.tier, 'review');
  // End to end through the classifier: base would be 'optional', floored up to 'review'.
  const { tier } = classifyAcceptanceTier(files, { verdict: 'unavailable', confidence: 0 }, cfg);
  assert.equal(tier, 'review', 'unavailable judge floors non-surface code at review, never auto/optional');
});

test('tier: never-judged real-code merge is NOT floored (stays at its base tier)', () => {
  const cfg = neutralClassifyConfig();
  const files = ['src/real.ts'];
  // No judge verdict at all (undefined) — the floor never fires; base tier stands.
  assert.equal(overseerFloor(files, undefined, 0.7), null, 'no judge attempt → no floor');
  const { tier } = classifyAcceptanceTier(files, undefined, cfg);
  assert.equal(tier, 'optional', 'never-judged non-surface code stays at base tier');
});

test('tier: judge-unavailable on a no-code item does NOT floor (nothing to review)', () => {
  // files empty → overseerFloor returns null even with an unavailable verdict, so a no-code
  // item stays auto (the "un-judged plane file stays auto" invariant is unaffected).
  assert.equal(overseerFloor([], { verdict: 'unavailable', confidence: 0 }, 0.7), null);
});

test('fold: review.verdict:unavailable is retained as a judgeVerdict', () => {
  const events: LedgerEvent[] = [
    makeEvent('cli', 'WI-003', 'item.captured', { source: 'cli', text: 'x' }),
    makeEvent('conductor', 'WI-003', 'item.queued', { spec: 's', touches: 'src/' }),
    makeEvent('dispatch', 'WI-003', 'review.verdict', {
      verdict: 'unavailable', confidence: 0, specSatisfied: 'unknown',
      scopeCreep: 'unknown', testTheatre: 'unknown', reasons: ['judge unavailable: timeout'],
      model: 'sonnet', judge: 'merge-review', reason: 'timeout',
    }),
  ];
  const rec = fold(events).items.get('WI-003')!;
  assert.equal(rec.judgeVerdict?.verdict, 'unavailable');
});

// ===========================================================================
// (c) Per-item fail-closed sensitivity resolution
// ===========================================================================

test('sensitivity: normalizeSensitivity fails closed on invalid values', () => {
  assert.equal(normalizeSensitivity('public'), 'public');
  assert.equal(normalizeSensitivity('internal'), 'internal');
  assert.equal(normalizeSensitivity('private'), 'private');
  // Anything unrecognized → most restrictive tier.
  assert.equal(normalizeSensitivity('secret'), 'private');
  assert.equal(normalizeSensitivity(undefined), 'private');
  assert.equal(normalizeSensitivity(42), 'private');
  assert.equal(normalizeSensitivity(''), 'private');
});

test('sensitivity: a private item never resolves an external-only chain', () => {
  // internal → external-only (claude-cli); private → local-only (ollama), and the private
  // allowlist forbids the external provider. Resolving the private tier must NEVER hand back
  // the external provider.
  const reg = makeRegistry({
    providers: { 'claude-cli': {}, 'ollama': {} },
    sensitivityAllowlists: { internal: ['claude-cli'], private: ['ollama'] },
    chains: { internal: ['claude-cli'], private: ['ollama'] },
  });
  const priv = reg.resolveWithHealth('private', { requireTools: false });
  assert.ok(priv, 'private resolves the local provider');
  assert.equal(priv!.name, 'ollama', 'private must resolve the local-only provider, never the external one');

  // Fail-closed: an invalid sensitivity is treated as private, so it too can only reach the
  // local chain — never the external internal chain.
  const bad = reg.resolveWithHealth(normalizeSensitivity('bogus'), { requireTools: false });
  assert.equal(bad!.name, 'ollama', 'invalid sensitivity resolves the private (local) chain, fail-closed');
});

test('sensitivity: a private item with an EMPTY allowlist resolves nothing (waits/parks)', () => {
  // Default private allowlist is empty — no provider is allowed, so resolution returns null and
  // the item is never routed to a disallowed provider (wait-or-park contract).
  const reg = makeRegistry({
    providers: { 'claude-cli': {}, 'ollama': {} },
    sensitivityAllowlists: { internal: ['claude-cli'] }, // private omitted → empty
    chains: { internal: ['claude-cli'], private: ['ollama'] },
  });
  assert.equal(reg.resolveWithHealth('private', { requireTools: false }), null,
    'private with no allowed provider resolves null — never routed to a disallowed one');
});

test('sensitivity: groupSensitivity takes the most restrictive member (fail-closed)', () => {
  const mk = (id: string, sensitivity?: string) =>
    fold([
      makeEvent('cli', id, 'item.captured',
        { source: 'cli', text: 'x', ...(sensitivity ? { sensitivity } : {}) } as import('../src/schema.js').ItemCapturedData),
    ]).items.get(id)!;
  assert.equal(groupSensitivity([mk('WI-101', 'public')]), 'public');
  assert.equal(groupSensitivity([mk('WI-102', 'public'), mk('WI-103', 'internal')]), 'internal');
  assert.equal(groupSensitivity([mk('WI-104', 'internal'), mk('WI-105', 'private')]), 'private');
  // An unknown member sensitivity fails closed to 'private' and dominates the group.
  assert.equal(groupSensitivity([mk('WI-106', 'public'), mk('WI-107', 'bogus')]), 'private');
  // Absent sensitivity defaults to 'internal' (documented capture default), not fail-closed.
  assert.equal(groupSensitivity([mk('WI-108')]), 'internal');
});

test('sensitivity: dispatch parks a private item fail-closed when no provider is allowed', async () => {
  // No injected provider → the real registry resolves per-group. The private tier has an empty
  // allowlist (default), so the build parks fail-closed instead of routing to the internal chain.
  const { repoRoot, ledgerDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'secret work', sensitivity: 'private' }),
    makeEvent('conductor', 'WI-001', 'item.queued', { spec: 'do secret thing', touches: 'src/' }),
  ]);
  try {
    await runDispatch({
      repoRoot, ledgerDir, autonomy: 'on',
      // No `provider` injected → registry resolves per group.
      config: makeTestConfig(),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
      scoutEnabled: false,
      judgeEnabled: false,
    });
    const events = await loadAllEvents(ledgerDir);
    const merged = events.filter(e => e.type === 'item.merged' && e.item === 'WI-001');
    assert.equal(merged.length, 0, 'a private item must NOT merge through a disallowed provider');
    const parked = events.filter(e => e.type === 'item.parked' && e.item === 'WI-001');
    assert.ok(parked.length >= 1, 'the private item must park fail-closed');
    const reason = (parked[parked.length - 1]!.data as { reason: string }).reason;
    assert.ok(/sensitivity\(private\)/.test(reason), `park reason must name the fail-closed sensitivity: ${reason}`);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (c2) Per-LANE fail-closed proof — the ONE shared resolver
//      (resolveProviderForSensitivity) is required at every content-bearing lane,
//      so a private-only item can never resolve the Claude provider.
// ---------------------------------------------------------------------------

/** Registry: internal → claude-cli (the leaky default), private → EMPTY (no provider allowed). */
function privateForbiddenRegistry(): ReturnType<typeof makeRegistry> {
  return makeRegistry({
    providers: { 'claude-cli': {} },
    // private omitted → empty allowlist; internal resolves the claude provider.
    sensitivityAllowlists: { internal: ['claude-cli'], public: ['claude-cli'] },
    chains: { internal: ['claude-cli'], public: ['claude-cli'], private: [] },
  });
}

/** A spy provider standing in for "the beat-global Claude provider" — its run MUST NOT be called. */
function spyClaudeProvider(): LlmProvider & { calls: number } {
  const p = {
    name: 'fake-claude-cli',
    calls: 0,
    async run(): Promise<ProviderResult> {
      p.calls++;
      return { ok: true, text: 'SHOULD NOT RUN', usage: { in: 1, out: 1, usd: 0 } };
    },
  };
  return p;
}

test('sensitivity(resolver): the ONE resolver returns the claude provider for internal but NULL for private', () => {
  const reg = privateForbiddenRegistry();
  const fallback = spyClaudeProvider();
  // internal → resolves a claude-named provider (the leaky default the lanes used to always use).
  const internal = resolveProviderForSensitivity(reg, fallback, 'internal', { requireTools: false });
  assert.ok(internal && internal.name.includes('claude'), 'internal resolves the claude provider');
  // private → NULL: the resolver must NEVER hand back a provider for a forbidden tier, and it must
  // never fall through to the beat-global `fallback` when a registry is present.
  assert.equal(resolveProviderForSensitivity(reg, fallback, 'private', { requireTools: false }), null,
    'a private item must resolve to NOTHING (never the claude fallback) when its tier forbids it');
  // Injected-provider test path (no registry) uses the fallback unchanged — this is the only path
  // where the fallback is returned, and fixtures are default-internal so it can never widen reach.
  assert.equal(resolveProviderForSensitivity(null, fallback, 'private'), fallback,
    'with no registry the caller-supplied provider is used unchanged (test path)');
  assert.equal(fallback.calls, 0, 'resolution alone never invokes the provider');
});

test('sensitivity(planning lane): a private item parks fail-closed, the claude provider is never run', async () => {
  const { repoRoot, ledgerDir, cleanup } = await makeDispatchEnv([]);
  try {
    // Provide a planner prompt so the lane reaches per-item resolution (a missing prompt would park
    // everything earlier for an unrelated reason).
    mkdirSync(join(repoRoot, '.ai', 'loops', 'prompts'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai', 'loops', 'prompts', 'planner.md'), 'plan it', 'utf8');
    const spy = spyClaudeProvider();
    const privItem = fold([
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'secret plan', sensitivity: 'private' }),
      makeEvent('conductor', 'WI-001', 'item.queued', { spec: 'decompose secret', lane: 'planning' } as import('../src/schema.js').ItemQueuedData),
    ]).items.get('WI-001')!;

    const results = await runPlanningLane(
      { repoRoot, ledgerDir, autonomy: 'on', config: makeTestConfig() },
      makeTestConfig(),
      spy,                       // beat-global provider (would leak) — MUST be ignored for a private item
      [privItem],
      join(repoRoot, '.ai', 'runs', 'loopkit'),
      privateForbiddenRegistry(),
    );

    assert.equal(spy.calls, 0, 'the planning lane must NOT run the claude provider on a private item');
    const events = await loadAllEvents(ledgerDir);
    const parked = events.filter(e => e.type === 'item.parked' && e.item === 'WI-001');
    assert.ok(parked.length >= 1, 'the private planning item must park fail-closed');
    assert.match((parked[parked.length - 1]!.data as { reason: string }).reason, /sensitivity\(private\)/);
    assert.equal(results.some(r => r.dispatched), false, 'no dispatch happened');
  } finally {
    cleanup();
  }
});

test('sensitivity(target lane): a private targeted item parks fail-closed, the claude provider is never run', async () => {
  const { repoRoot, ledgerDir, cleanup } = await makeDispatchEnv([]);
  try {
    const { spawnSync } = await import('node:child_process');
    // A registered target repo the item points at.
    const targetRoot = join(repoRoot, '..', 'tgt');
    mkdirSync(targetRoot, { recursive: true });
    writeFileSync(join(targetRoot, 'loopkit.target.json'), JSON.stringify({ name: 'tgt', defaultBranch: 'main' }), 'utf8');
    for (const args of [['init', '-b', 'main'], ['config', 'user.email', 't@t'], ['config', 'user.name', 't'], ['add', '-A'], ['commit', '-m', 'init']]) {
      spawnSync('git', args, { cwd: targetRoot, stdio: 'pipe' });
    }
    const spy = spyClaudeProvider();
    const foldRes = fold([
      makeEvent('cli', 'tgt', 'target.registered', { name: 'tgt', repoPath: targetRoot, manifestHash: 'h', defaultBranch: 'main' }),
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'secret target work', sensitivity: 'private', target: 'tgt' }),
      makeEvent('conductor', 'WI-001', 'item.queued', { spec: 'do it', target: 'tgt' } as import('../src/schema.js').ItemQueuedData),
    ]);
    const item = foldRes.items.get('WI-001')!;

    const results = await runTargetLane(
      { repoRoot, ledgerDir, autonomy: 'on', config: makeTestConfig() },
      makeTestConfig(),
      spy,
      foldRes,
      [item],
      join(repoRoot, '.ai', 'runs', 'loopkit'),
      privateForbiddenRegistry(),
    );

    assert.equal(spy.calls, 0, 'the target lane must NOT run the claude provider on a private item');
    const events = await loadAllEvents(ledgerDir);
    const parked = events.filter(e => e.type === 'item.parked' && e.item === 'WI-001');
    assert.ok(parked.length >= 1, 'the private target item must park fail-closed');
    assert.match((parked[parked.length - 1]!.data as { reason: string }).reason, /sensitivity\(private\)/);
    assert.equal(results.some(r => r.dispatched), false, 'no dispatch happened');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// Deploy off by default — merge with empty deployCommand is a no-op
// ===========================================================================

test('deploy: merge with empty deployCommand appends no deploy events', async () => {
  const { repoRoot, ledgerDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'build' }),
    makeEvent('conductor', 'WI-001', 'item.queued', { spec: 'add file', touches: 'src/' }),
  ]);
  try {
    // Framework default deployCommand is '' — assert that first (the "deploy off by default" claim).
    assert.equal(CONFIG_DEFAULTS.deployCommand, '', 'framework default deployCommand must be empty');
    await runDispatch({
      repoRoot, ledgerDir, autonomy: 'on',
      provider: makeCommitProvider('src/feature.ts'),
      config: makeTestConfig({ deployCommand: '' }),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
      touchesDiffFiles: ['src/feature.ts'],
      pushProbe: () => ({ status: 0 }),
      scoutEnabled: false,
      judgeEnabled: false,
    });
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.type === 'item.merged' && e.item === 'WI-001').length, 1, 'item merges');
    assert.equal(events.filter(e => e.type === 'deploy.succeeded').length, 0, 'no deploy.succeeded');
    assert.equal(events.filter(e => e.type === 'deploy.failed').length, 0, 'no deploy.failed');
    const mergedData = events.find(e => e.type === 'item.merged' && e.item === 'WI-001')!.data as unknown as ItemMergedData;
    assert.equal(mergedData.deployed, false, 'item.merged.deployed must be false with deploy off');
  } finally {
    cleanup();
  }
});

test('deploy: fireDeployOnMerge runs nothing when deployCommand is empty', () => {
  const dir = makeTempDir();
  try {
    const sentinel = join(dir, 'deployed.txt');
    // Empty command → no-op: the sentinel must NOT appear.
    fireDeployOnMerge(dir, '', ['WI-001']);
    assert.equal(existsSync(sentinel), false, 'empty deployCommand runs no command');
    // A real command DOES fire (proves the empty-branch is the reason nothing ran above).
    fireDeployOnMerge(dir, `touch ${sentinel}`, ['WI-001']);
    // The child is detached; give it a brief moment, then assert. Poll to avoid flakiness.
    const deadline = Date.now() + 2000;
    while (!existsSync(sentinel) && Date.now() < deadline) { /* spin briefly */ }
    assert.equal(existsSync(sentinel), true, 'a non-empty deployCommand does run');
  } finally {
    cleanDir(dir);
  }
});
