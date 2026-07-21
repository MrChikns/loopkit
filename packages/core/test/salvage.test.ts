/**
 * salvage.test.ts — Tests for worker salvage/resume.
 *
 * Covers:
 *   capture — writes .salvage.patch + .salvage.md, excludes plumbing/dist/log
 *   size cap — over-cap writes .salvage.note only, no .salvage.patch
 *   resume: patch applies — prompt has RESUME NOTE with pre-applied wording + section order pack→resume→repair
 *   resume: apply check fails — clean tree + reference wording in prompt
 *   salvage disabled — no capture
 *   doctor orphan path — salvages + removes worktree; no-worktree orphan is a no-op
 *   msg.out trail — appended on capture
 *   config validation — bad types throw
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { makeEvent, LedgerEvent } from '../src/schema.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { runDispatch, DispatchOptions } from '../src/beats/dispatch.js';
import { runReactor, ReactorOptions } from '../src/beats/reactor.js';
import { LlmProvider, ProviderRequest, ProviderResult } from '../src/providers/types.js';
import { LoopkitConfig, CONFIG_DEFAULTS } from '../src/config.js';
import {
  captureSalvage, findSalvagePatch, applySalvagePatch, buildResumeNote,
} from '../src/salvage.js';
import { loadConfig } from '../src/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testCount = 0;

function makeTempDir(): string {
  const dir = join(tmpdir(), `loopkit-wi226-${process.pid}-${++testCount}-${Date.now()}`);
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
    salvage: { enabled: true, maxPatchKb: 256 },
    ...overrides,
  };
}

/**
 * Create a minimal git repo in `dir` with one initial commit.
 * Creates `dir` if it does not exist.
 * Returns helpers for running git in that repo.
 */
function makeGitRepo(dir: string): { g: (args: string[]) => ReturnType<typeof spawnSync> } {
  mkdirSync(dir, { recursive: true });
  const g = (args: string[]) => spawnSync('git', args, { cwd: dir, stdio: 'pipe' });
  g(['init', '-b', 'master']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  writeFileSync(join(dir, 'base.txt'), 'base', 'utf8');
  g(['add', 'base.txt']);
  g(['commit', '-m', 'init']);
  return { g };
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
  makeGitRepo(repoRoot);
  await appendEvents(ledgerDir, ledgerEvents);
  return { repoRoot, ledgerDir, cleanup: () => cleanDir(base) };
}


// ---------------------------------------------------------------------------
// Unit tests: captureSalvage
// ---------------------------------------------------------------------------

test('captureSalvage: writes .salvage.patch and .salvage.md; excludes node_modules symlink', () => {
  const base = makeTempDir();
  const wtPath = join(base, 'worktree');
  const runDir = join(base, 'runs');
  mkdirSync(runDir, { recursive: true });
  const { g } = makeGitRepo(wtPath);

  try {
    void g; // g available but not strictly needed here

    // Make a tracked change (edit a committed file)
    writeFileSync(join(wtPath, 'base.txt'), 'modified content', 'utf8');

    // Untracked source file (should be captured)
    mkdirSync(join(wtPath, 'src'), { recursive: true });
    writeFileSync(join(wtPath, 'src', 'new-feature.ts'), '// new work', 'utf8');

    // Plumbing: node_modules symlink (should be EXCLUDED)
    const nmTarget = join(base, 'nm-target');
    mkdirSync(nmTarget, { recursive: true });
    writeFileSync(join(nmTarget, 'package.json'), '{}', 'utf8');
    symlinkSync(nmTarget, join(wtPath, 'node_modules'));

    const result = captureSalvage(wtPath, 'WI-001', 1, runDir, 'crash');

    assert.ok(result.ok, 'salvage must succeed');
    assert.ok(result.patchPath, '.salvage.patch must be returned');
    assert.ok(existsSync(result.patchPath!), '.salvage.patch must exist on disk');
    assert.ok(result.mdPath, '.salvage.md must be returned');
    assert.ok(existsSync(result.mdPath!), '.salvage.md must exist on disk');

    const patchContent = readFileSync(result.patchPath!, 'utf8');
    // Should contain tracked change
    assert.ok(patchContent.includes('modified content') || patchContent.includes('base.txt'),
      'patch must include tracked change');
    // Should contain untracked source file
    assert.ok(patchContent.includes('new-feature.ts') || patchContent.includes('new work'),
      'patch must include untracked source file');
    // Must NOT contain node_modules
    assert.ok(!patchContent.includes('node_modules'),
      'patch must not include node_modules (plumbing)');

    const mdContent = readFileSync(result.mdPath!, 'utf8');
    assert.ok(mdContent.includes('WI-001'), 'salvage.md must mention itemId');
    assert.ok(mdContent.includes('crash'), 'salvage.md must mention reason');

    assert.ok(result.trailMessage.includes('salvaged') || result.trailMessage.includes('WI-001'),
      'trailMessage must describe salvage outcome');
  } finally {
    cleanDir(base);
  }
});

test('captureSalvage: excludes dist/ directory', () => {
  const base = makeTempDir();
  const wtPath = join(base, 'worktree');
  const runDir = join(base, 'runs');
  mkdirSync(runDir, { recursive: true });
  makeGitRepo(wtPath);

  try {
    // Untracked dist file (should be EXCLUDED)
    mkdirSync(join(wtPath, 'dist'), { recursive: true });
    writeFileSync(join(wtPath, 'dist', 'index.js'), '// compiled', 'utf8');

    // Untracked source file (should be included)
    mkdirSync(join(wtPath, 'src'), { recursive: true });
    writeFileSync(join(wtPath, 'src', 'work.ts'), '// partial work', 'utf8');

    const result = captureSalvage(wtPath, 'WI-010', 1, runDir, 'timeout');
    assert.ok(result.ok, 'salvage must succeed');

    if (result.patchPath && existsSync(result.patchPath)) {
      const patchContent = readFileSync(result.patchPath, 'utf8');
      assert.ok(!patchContent.includes('dist/index.js'), 'patch must not include dist/ file');
      assert.ok(patchContent.includes('work.ts') || patchContent.includes('partial work'),
        'patch must include source file');
    }
    // .salvage.md must always be written
    assert.ok(result.mdPath && existsSync(result.mdPath), '.salvage.md must exist');
  } finally {
    cleanDir(base);
  }
});

test('captureSalvage: excludes *.log files', () => {
  const base = makeTempDir();
  const wtPath = join(base, 'worktree');
  const runDir = join(base, 'runs');
  mkdirSync(runDir, { recursive: true });
  makeGitRepo(wtPath);

  try {
    writeFileSync(join(wtPath, 'build.log'), 'build output\n', 'utf8');
    writeFileSync(join(wtPath, 'src-real.ts'), '// real work', 'utf8');
    mkdirSync(join(wtPath, 'src'), { recursive: true });
    writeFileSync(join(wtPath, 'src', 'main.ts'), '// main', 'utf8');

    const result = captureSalvage(wtPath, 'WI-011', 1, runDir, 'crash');
    assert.ok(result.ok, 'salvage must succeed');

    if (result.patchPath && existsSync(result.patchPath)) {
      const patchContent = readFileSync(result.patchPath, 'utf8');
      assert.ok(!patchContent.includes('build.log'), 'patch must not include .log files');
    }
  } finally {
    cleanDir(base);
  }
});

test('captureSalvage: size cap → .salvage.note only, no .salvage.patch', () => {
  const base = makeTempDir();
  const wtPath = join(base, 'worktree');
  const runDir = join(base, 'runs');
  mkdirSync(runDir, { recursive: true });
  makeGitRepo(wtPath);

  try {
    // Create a large tracked change (modify base.txt with lots of content)
    // Use a small cap of 1 KB so it's easy to exceed
    writeFileSync(join(wtPath, 'base.txt'), 'x'.repeat(5000), 'utf8');

    const result = captureSalvage(wtPath, 'WI-020', 1, runDir, 'timeout', { enabled: true, maxPatchKb: 1 });
    assert.ok(result.ok, 'salvage must succeed even over cap');
    assert.equal(result.patchPath, undefined, 'no patchPath when over cap');
    assert.ok(result.notePath, '.notePath must be returned when over cap');
    assert.ok(existsSync(result.notePath!), '.salvage.note must exist');
    assert.ok(result.mdPath && existsSync(result.mdPath), '.salvage.md must exist');

    const noteContent = readFileSync(result.notePath!, 'utf8');
    assert.ok(noteContent.includes('too large'), 'note must mention "too large"');
    assert.ok(result.trailMessage.includes('too large'), 'trailMessage must mention over-cap');
  } finally {
    cleanDir(base);
  }
});

test('captureSalvage: disabled → returns without writing anything', () => {
  const base = makeTempDir();
  const wtPath = join(base, 'worktree');
  const runDir = join(base, 'runs');
  mkdirSync(runDir, { recursive: true });
  makeGitRepo(wtPath);

  try {
    writeFileSync(join(wtPath, 'base.txt'), 'modified', 'utf8');
    const result = captureSalvage(wtPath, 'WI-030', 1, runDir, 'crash', { enabled: false });
    assert.ok(result.ok, 'should return ok even when disabled');
    assert.equal(result.patchPath, undefined, 'no patchPath when disabled');
    assert.equal(result.mdPath, undefined, 'no mdPath when disabled');
    assert.ok(result.trailMessage.includes('disabled'), 'trailMessage must say disabled');
  } finally {
    cleanDir(base);
  }
});

test('captureSalvage: no uncommitted changes → md written, no patch', () => {
  const base = makeTempDir();
  const wtPath = join(base, 'worktree');
  const runDir = join(base, 'runs');
  mkdirSync(runDir, { recursive: true });
  makeGitRepo(wtPath);

  try {
    // Clean worktree (nothing uncommitted)
    const result = captureSalvage(wtPath, 'WI-040', 1, runDir, 'orphan');
    assert.ok(result.ok, 'salvage must succeed on clean tree');
    assert.equal(result.patchPath, undefined, 'no patch when tree is clean');
    assert.ok(result.mdPath && existsSync(result.mdPath), '.salvage.md must still be written');
    assert.ok(result.trailMessage.includes('no uncommitted'), 'trailMessage must mention no changes');
  } finally {
    cleanDir(base);
  }
});

// ---------------------------------------------------------------------------
// Unit tests: findSalvagePatch + applySalvagePatch
// ---------------------------------------------------------------------------

test('findSalvagePatch: finds highest prior attempt with patch', () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, 'WI-050-attempt-1.salvage.patch'), 'diff --git a/x\n+x\n', 'utf8');
    writeFileSync(join(dir, 'WI-050-attempt-1.salvage.md'), '# summary\n', 'utf8');
    const found = findSalvagePatch(dir, 'WI-050', 2);
    assert.ok(found, 'must find the patch');
    assert.equal(found!.attempt, 1, 'must return attempt 1');
    assert.ok(found!.patchPath.endsWith('WI-050-attempt-1.salvage.patch'));
  } finally {
    cleanDir(dir);
  }
});

test('findSalvagePatch: returns undefined when no patch exists', () => {
  const dir = makeTempDir();
  try {
    // Only .md exists, no .patch
    writeFileSync(join(dir, 'WI-060-attempt-1.salvage.md'), '# summary\n', 'utf8');
    const found = findSalvagePatch(dir, 'WI-060', 2);
    assert.equal(found, undefined, 'must return undefined when no patch file');
  } finally {
    cleanDir(dir);
  }
});

test('findSalvagePatch: returns undefined for attempt 1 (no prior)', () => {
  const dir = makeTempDir();
  try {
    const found = findSalvagePatch(dir, 'WI-070', 1);
    assert.equal(found, undefined, 'attempt 1 has no prior to look for');
  } finally {
    cleanDir(dir);
  }
});

test('applySalvagePatch: applies a valid patch successfully', () => {
  // Build a valid patch by editing a tracked file, capturing git diff, then reverting
  const base = makeTempDir();
  const wtPath = join(base, 'worktree');
  const patchPath = join(base, 'test.patch');
  const targetDir = join(base, 'target');  // second worktree to apply to
  makeGitRepo(wtPath);
  makeGitRepo(targetDir);

  try {
    // Modify a tracked file in the source tree to generate a diff
    writeFileSync(join(wtPath, 'base.txt'), 'base\nsalvaged line\n', 'utf8');
    const patchResult = spawnSync('git', ['diff', 'HEAD'], { cwd: wtPath, stdio: 'pipe' });
    const patchContent = patchResult.stdout.toString();

    assert.ok(patchContent.length > 0, 'must produce a non-empty patch');
    writeFileSync(patchPath, patchContent, 'utf8');

    // Apply to the target worktree (which has the same base state)
    const applied = applySalvagePatch(targetDir, patchPath);
    assert.ok(applied === true, 'patch must apply successfully to matching base');

    // Verify the change was applied
    const resultContent = readFileSync(join(targetDir, 'base.txt'), 'utf8');
    assert.ok(resultContent.includes('salvaged line'), 'applied patch must contain salvaged content');
  } finally {
    cleanDir(base);
  }
});

test('applySalvagePatch: returns false and leaves tree clean when patch does not apply', () => {
  const base = makeTempDir();
  const wtPath = join(base, 'worktree');
  const patchPath = join(base, 'bad.patch');
  makeGitRepo(wtPath);

  try {
    // Create a patch for a file that won't apply (wrong context)
    const badPatch = `diff --git a/nonexistent-context.ts b/nonexistent-context.ts
index 0000000..1111111 100644
--- a/nonexistent-context.ts
+++ b/nonexistent-context.ts
@@ -1,3 +1,4 @@
 existing line 1
 existing line 2
+new line
 existing line 3
`;
    writeFileSync(patchPath, badPatch, 'utf8');
    const applied = applySalvagePatch(wtPath, patchPath);
    assert.equal(applied, false, 'must return false for non-applicable patch');

    // Tree must still be clean
    const st = spawnSync('git', ['status', '--porcelain'], { cwd: wtPath, stdio: 'pipe' });
    const dirty = st.stdout.toString().trim();
    assert.equal(dirty, '', 'worktree must be clean after failed apply');
  } finally {
    cleanDir(base);
  }
});

// ---------------------------------------------------------------------------
// buildResumeNote unit tests
// ---------------------------------------------------------------------------

test('buildResumeNote: applied=true uses pre-applied wording', () => {
  const note = buildResumeNote(true, '# salvage\nInterrupted-at: 2026-07-11\nReason: crash\n', '/some/path.patch');
  assert.ok(note.includes('RESUME NOTE'), 'must include RESUME NOTE heading');
  assert.ok(note.includes('PRE-APPLIED'), 'must say PRE-APPLIED');
  assert.ok(note.includes('suspect draft'), 'must say suspect draft');
  assert.ok(note.includes('Interrupted-at'), 'must include md content');
});

test('buildResumeNote: applied=false uses reference wording with path', () => {
  const note = buildResumeNote(false, '# salvage\nReason: timeout\n', '/runs/WI-001-attempt-1.salvage.patch');
  assert.ok(note.includes('RESUME NOTE'), 'must include RESUME NOTE heading');
  assert.ok(note.includes('WI-001-attempt-1.salvage.patch'), 'must include patch path');
  assert.ok(note.includes('reference'), 'must say consult as reference');
  assert.ok(!note.includes('PRE-APPLIED'), 'must NOT say PRE-APPLIED when not applied');
});

// ---------------------------------------------------------------------------
// Dispatch integration: resume note in prompt + section order
// ---------------------------------------------------------------------------

test('dispatch: resume note injected in prompt when salvage patch exists (applied)', async () => {
  const { repoRoot, ledgerDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-100', 'item.captured', { source: 'cli', text: 'fix bug' }),
    makeEvent('conductor', 'WI-100', 'item.queued', { spec: 'fix the bug', touches: 'src/' }),
    // Prior attempt
    makeEvent('dispatch', 'WI-100', 'build.dispatched', { attempt: 1, branch: 'wi-100-a1', pid: 999 }),
    makeEvent('dispatch', 'WI-100', 'gate.failed', { reason: 'tests-red: prior' }),
    makeEvent('dispatch', 'WI-100', 'item.parked', { reason: 'tests-red: prior' }),
    makeEvent('operator', 'WI-100', 'item.unparked', {}),
    makeEvent('conductor', 'WI-100', 'item.queued', { spec: 'fix the bug', touches: 'src/' }),
    // Scout brief (for CONTEXT PACK section ordering test)
    makeEvent('dispatch', 'WI-100', 'item.briefed', { brief: 'BRIEF:\nFiles: src/fix.ts — must change', model: 'haiku' }),
  ]);

  const artifactDir = makeTempDir();
  try {
    // Pre-seed a salvage patch for attempt 1
    // The patch must apply cleanly to a fresh worktree (tracked edit of an existing file)
    // Since the worktrees are fresh from master (which has only base.txt), we use base.txt
    const patchContent = `diff --git a/base.txt b/base.txt
index 6b00c47..e4c6e6a 100644
--- a/base.txt
+++ b/base.txt
@@ -1 +1,2 @@
 base
+salvage-partial-work
`;
    writeFileSync(join(artifactDir, 'WI-100-attempt-1.salvage.patch'), patchContent, 'utf8');
    writeFileSync(join(artifactDir, 'WI-100-attempt-1.salvage.md'),
      '# Salvage summary — WI-100 attempt 1\n\nInterrupted-at: 2026-07-11T10:00:00.000Z\nReason: crash\n',
      'utf8');
    // Also pre-seed repair evidence
    writeFileSync(join(artifactDir, 'WI-100-attempt-1.gate.log'), 'FAIL: test red\n', 'utf8');

    let capturedPrompt: string | undefined;

    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        capturedPrompt = req.prompt;
        const { spawnSync: sp } = await import('node:child_process');
        const { mkdirSync: mkdir, writeFileSync: wf } = await import('node:fs');
        mkdir(join(req.cwd!, 'src'), { recursive: true });
        wf(join(req.cwd!, 'src', 'fix.ts'), '// fixed', 'utf8');
        sp('git', ['add', 'src/fix.ts'], { cwd: req.cwd, stdio: 'pipe' });
        sp('git', ['commit', '-m', 'fix(WI-100): fix'], { cwd: req.cwd, stdio: 'pipe' });
        return { ok: true, text: 'done', usage: { in: 100, out: 50, usd: 0.001 } };
      },
    };

    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider,
      config: makeTestConfig(),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
      touchesDiffFiles: ['src/fix.ts'],
      pushProbe: () => ({ status: 0 }),
      artifactRunsDir: artifactDir,
      judgeEnabled: false,
      salvageEnabled: true,
    });

    assert.ok(capturedPrompt, 'build prompt must have been captured');
    assert.ok(capturedPrompt.includes('RESUME NOTE'), 'prompt must include RESUME NOTE section');

    // Section order: CONTEXT PACK → RESUME NOTE → REPAIR EVIDENCE → REQUEST
    const packIdx = capturedPrompt.indexOf('CONTEXT PACK');
    const resumeIdx = capturedPrompt.indexOf('RESUME NOTE');
    const repairIdx = capturedPrompt.indexOf('REPAIR EVIDENCE');
    const requestIdx = capturedPrompt.indexOf('REQUEST:');

    if (packIdx !== -1) {
      assert.ok(packIdx < resumeIdx, 'CONTEXT PACK must come before RESUME NOTE');
    }
    assert.ok(resumeIdx !== -1, 'RESUME NOTE must be present');
    if (repairIdx !== -1) {
      assert.ok(resumeIdx < repairIdx, 'RESUME NOTE must come before REPAIR EVIDENCE');
    }
    assert.ok(resumeIdx < requestIdx, 'RESUME NOTE must come before REQUEST');
  } finally {
    cleanup();
    cleanDir(artifactDir);
  }
});

test('dispatch: resume note uses reference wording when patch does not apply cleanly', async () => {
  const { repoRoot, ledgerDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-101', 'item.captured', { source: 'cli', text: 'fix bug' }),
    makeEvent('conductor', 'WI-101', 'item.queued', { spec: 'fix the bug', touches: 'src/' }),
    // Prior attempt
    makeEvent('dispatch', 'WI-101', 'build.dispatched', { attempt: 1, branch: 'wi-101-a1', pid: 999 }),
    makeEvent('dispatch', 'WI-101', 'gate.failed', { reason: 'tests-red: prior' }),
    makeEvent('dispatch', 'WI-101', 'item.parked', { reason: 'tests-red: prior' }),
    makeEvent('operator', 'WI-101', 'item.unparked', {}),
    makeEvent('conductor', 'WI-101', 'item.queued', { spec: 'fix the bug', touches: 'src/' }),
  ]);

  const artifactDir = makeTempDir();
  try {
    // Pre-seed a patch that will NOT apply cleanly (references a file that won't exist in context)
    const badPatch = `diff --git a/nonexistent-file-xyz.ts b/nonexistent-file-xyz.ts
index 0000000..1111111 100644
--- a/nonexistent-file-xyz.ts
+++ b/nonexistent-file-xyz.ts
@@ -1,3 +1,4 @@
 existing line
+new line
 existing line 2
`;
    writeFileSync(join(artifactDir, 'WI-101-attempt-1.salvage.patch'), badPatch, 'utf8');
    writeFileSync(join(artifactDir, 'WI-101-attempt-1.salvage.md'),
      '# Salvage summary — WI-101 attempt 1\n\nInterrupted-at: 2026-07-11T10:00:00.000Z\nReason: timeout\n',
      'utf8');

    let capturedPrompt: string | undefined;

    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        capturedPrompt = req.prompt;
        const { spawnSync: sp } = await import('node:child_process');
        const { mkdirSync: mkdir, writeFileSync: wf } = await import('node:fs');
        mkdir(join(req.cwd!, 'src'), { recursive: true });
        wf(join(req.cwd!, 'src', 'bug.ts'), '// fixed', 'utf8');
        sp('git', ['add', 'src/bug.ts'], { cwd: req.cwd, stdio: 'pipe' });
        sp('git', ['commit', '-m', 'fix(WI-101): fix'], { cwd: req.cwd, stdio: 'pipe' });
        return { ok: true, text: 'done', usage: { in: 100, out: 50, usd: 0.001 } };
      },
    };

    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider,
      config: makeTestConfig(),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
      touchesDiffFiles: ['src/bug.ts'],
      pushProbe: () => ({ status: 0 }),
      artifactRunsDir: artifactDir,
      judgeEnabled: false,
      salvageEnabled: true,
      scoutEnabled: false,
    });

    assert.ok(capturedPrompt, 'build prompt must have been captured');
    assert.ok(capturedPrompt.includes('RESUME NOTE'), 'prompt must include RESUME NOTE section');
    assert.ok(capturedPrompt.includes('reference'), 'reference wording when patch did not apply');
    assert.ok(!capturedPrompt.includes('PRE-APPLIED'), 'must NOT say PRE-APPLIED');

    // Worktree must be clean (no half-applied patch)
    // We verify via the successful dispatch flow completing (no crash, no park beyond test)
    const events = await loadAllEvents(ledgerDir);
    const merged = events.filter(e => e.type === 'item.merged' && e.item === 'WI-101');
    assert.equal(merged.length, 1, 'item must merge (worktree was clean despite failed apply)');
  } finally {
    cleanup();
    cleanDir(artifactDir);
  }
});

test('dispatch: salvage disabled → no resume note in prompt', async () => {
  const { repoRoot, ledgerDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-102', 'item.captured', { source: 'cli', text: 'build' }),
    makeEvent('conductor', 'WI-102', 'item.queued', { spec: 'build it', touches: 'src/' }),
    makeEvent('dispatch', 'WI-102', 'build.dispatched', { attempt: 1, branch: 'wi-102-a1', pid: 999 }),
    makeEvent('dispatch', 'WI-102', 'gate.failed', { reason: 'tests-red: prior' }),
    makeEvent('dispatch', 'WI-102', 'item.parked', { reason: 'tests-red: prior' }),
    makeEvent('operator', 'WI-102', 'item.unparked', {}),
    makeEvent('conductor', 'WI-102', 'item.queued', { spec: 'build it', touches: 'src/' }),
  ]);

  const artifactDir = makeTempDir();
  try {
    // Pre-seed a patch that WOULD apply
    const patchContent = `diff --git a/base.txt b/base.txt
index 6b00c47..e4c6e6a 100644
--- a/base.txt
+++ b/base.txt
@@ -1 +1,2 @@
 base
+salvage
`;
    writeFileSync(join(artifactDir, 'WI-102-attempt-1.salvage.patch'), patchContent, 'utf8');
    writeFileSync(join(artifactDir, 'WI-102-attempt-1.salvage.md'), '# summary\n', 'utf8');

    let capturedPrompt: string | undefined;

    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        capturedPrompt = req.prompt;
        const { spawnSync: sp } = await import('node:child_process');
        const { mkdirSync: mkdir, writeFileSync: wf } = await import('node:fs');
        mkdir(join(req.cwd!, 'src'), { recursive: true });
        wf(join(req.cwd!, 'src', 'thing.ts'), '// done', 'utf8');
        sp('git', ['add', 'src/thing.ts'], { cwd: req.cwd, stdio: 'pipe' });
        sp('git', ['commit', '-m', 'feat(WI-102): done'], { cwd: req.cwd, stdio: 'pipe' });
        return { ok: true, text: 'done', usage: { in: 100, out: 50, usd: 0.001 } };
      },
    };

    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider,
      config: makeTestConfig({ salvage: { enabled: false } }),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
      touchesDiffFiles: ['src/thing.ts'],
      pushProbe: () => ({ status: 0 }),
      artifactRunsDir: artifactDir,
      judgeEnabled: false,
      salvageEnabled: false,
      scoutEnabled: false,
    });

    assert.ok(capturedPrompt, 'build prompt must have been captured');
    assert.ok(!capturedPrompt.includes('RESUME NOTE'),
      'prompt must NOT include RESUME NOTE when salvage disabled');
  } finally {
    cleanup();
    cleanDir(artifactDir);
  }
});

// ---------------------------------------------------------------------------
// Dispatch integration: auth-crash path salvage + msg.out trail
// ---------------------------------------------------------------------------

test('dispatch: auth-crash path calls salvage + appends msg.out trail', async () => {
  const { repoRoot, ledgerDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-110', 'item.captured', { source: 'cli', text: 'build' }),
    makeEvent('conductor', 'WI-110', 'item.queued', { spec: 'build it', touches: 'src/' }),
  ]);

  const artifactDir = makeTempDir();
  let salvageCalled = false;
  try {
    const capturedSalvage: typeof import('../src/salvage.js').captureSalvage = (
      wtPath, itemId, attempt, runDir, reason, cfg, logPath
    ) => {
      salvageCalled = true;
      assert.equal(itemId, 'WI-110', 'salvage must be called with correct itemId');
      assert.equal(reason, 'crash', 'salvage reason must be crash for auth crash');
      return { trailMessage: `attempt ${attempt} interrupted (${reason}) — salvaged 2 files`, ok: true };
    };

    const provider: LlmProvider = {
      name: 'fake',
      async run(_req: ProviderRequest): Promise<ProviderResult> {
        // Return auth error (the worktree has been set up at this point)
        return { ok: false, error: 'not logged in', code: 'auth' } as ProviderResult;
      },
    };

    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider,
      config: makeTestConfig(),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },  // pre-flight passes; crash happens mid-build
      artifactRunsDir: artifactDir,
      judgeEnabled: false,
      scoutEnabled: false,
      salvageEnabled: true,
      salvageCapture: capturedSalvage,
    });

    assert.ok(salvageCalled, 'salvage must have been called on auth crash');

    // Check that msg.out was appended to the ledger
    const events = await loadAllEvents(ledgerDir);
    const trailEvents = events.filter(e => e.type === 'msg.out' && e.item === 'WI-110');
    assert.ok(trailEvents.length >= 1, 'msg.out trail must be appended');
    const trailText = (trailEvents[0].data as Record<string, unknown>)['text'] as string;
    assert.ok(trailText.includes('interrupted'), 'trail must describe interruption');
  } finally {
    cleanup();
    cleanDir(artifactDir);
  }
});

test('dispatch: provider TIMEOUT (no-commit path) calls salvage with reason timeout', async () => {
  const { repoRoot, ledgerDir, cleanup } = await makeDispatchEnv([
    makeEvent('cli', 'WI-111', 'item.captured', { source: 'cli', text: 'build' }),
    makeEvent('conductor', 'WI-111', 'item.queued', { spec: 'build it', touches: 'src/' }),
  ]);

  const artifactDir = makeTempDir();
  let salvageReason: string | undefined;
  try {
    const capturedSalvage: typeof import('../src/salvage.js').captureSalvage = (
      _wtPath, itemId, _attempt, _runDir, reason, _cfg, _logPath
    ) => {
      salvageReason = reason;
      assert.equal(itemId, 'WI-111');
      return { trailMessage: `attempt 1 interrupted (${reason}) — salvaged 1 file`, ok: true };
    };

    const provider: LlmProvider = {
      name: 'fake',
      async run(_req: ProviderRequest): Promise<ProviderResult> {
        // Timeout mid-build: non-auth failure falls through to the commit check —
        // the worker made no commit, so the no-commit park path must salvage.
        return { ok: false, error: 'build timed out after 40m', code: 'timeout' } as ProviderResult;
      },
    };

    await runDispatch({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider,
      config: makeTestConfig(),
      branchProbe: () => 'master',
      authProbeResult: { ok: true },
      artifactRunsDir: artifactDir,
      judgeEnabled: false,
      scoutEnabled: false,
      salvageEnabled: true,
      salvageCapture: capturedSalvage,
    });

    assert.equal(salvageReason, 'timeout', 'salvage must run with reason=timeout on the no-commit path');
    const events = await loadAllEvents(ledgerDir);
    const parked = events.filter(e => e.type === 'item.parked' && e.item === 'WI-111');
    assert.ok(parked.length >= 1, 'timeout still parks as no-commit (behavior unchanged)');
    const trail = events.filter(e => e.type === 'msg.out' && e.item === 'WI-111');
    assert.ok(trail.length >= 1, 'salvage trail msg.out appended');
  } finally {
    cleanup();
    cleanDir(artifactDir);
  }
});

// ---------------------------------------------------------------------------
// Doctor + reactor integration: orphan path salvage + worktree removal
// ---------------------------------------------------------------------------

test('doctor orphan path: salvages worktree + appends msg.out + removes worktree', async () => {
  const base = makeTempDir();
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  const runDir = join(repoRoot, '.ai', 'runs', 'loopkit');
  mkdirSync(runDir, { recursive: true });
  mkdirSync(ledgerDir, { recursive: true });
  const { g: rg } = makeGitRepo(repoRoot);

  // Create a real git worktree (registered in repoRoot) so `git worktree remove` works.
  const orphanWt = join(base, 'orphan-wt');
  rg(['worktree', 'add', '-b', 'wi-200-a1', orphanWt]);
  // Leave an uncommitted change in the orphan worktree so salvage has something to capture
  writeFileSync(join(orphanWt, 'base.txt'), 'orphan partial work', 'utf8');

  try {
    // Seed: item in 'building' state with a dead pid and recorded worktree path
    const deadPid = 99999999;  // assumed dead
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-200', 'item.captured', { source: 'cli', text: 'orphan test' }),
      makeEvent('conductor', 'WI-200', 'item.queued', { spec: 'build it', touches: 'src/' }),
      makeEvent('dispatch', 'WI-200', 'build.dispatched', {
        attempt: 1,
        branch: 'wi-200-a1',
        pid: deadPid,
        worktree: orphanWt,
      }),
    ]);

    // Run the reactor — other steps are no-ops for items in 'building' state.
    // The doctor step will detect the dead-pid orphan, call captureSalvage (real impl),
    // append the trail msg.out event, and remove the orphan worktree.
    await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      dryRun: false,
      pidProbe: (pid: number) => pid !== deadPid,  // treat deadPid as dead
      provider: null as unknown as import('../src/providers/types.js').LlmProvider,
      config: makeTestConfig({ salvage: { enabled: true, maxPatchKb: 256 } }),
    });

    // Check ledger: build.crashed emitted (from doctor)
    const events = await loadAllEvents(ledgerDir);
    const crashed = events.filter(e => e.type === 'build.crashed' && e.item === 'WI-200');
    assert.ok(crashed.length >= 1, 'build.crashed must be emitted for orphan');

    // Check ledger: msg.out emitted (from salvage trail)
    const trail = events.filter(e => e.type === 'msg.out' && e.item === 'WI-200');
    assert.ok(trail.length >= 1, 'msg.out trail must be appended for orphan salvage');

    // Check worktree removed
    assert.ok(!existsSync(orphanWt), 'orphan worktree must be removed after salvage');
  } finally {
    cleanDir(base);
  }
});

test('doctor orphan: no-worktree orphan is a no-op for salvage (worktree path absent)', async () => {
  const base = makeTempDir();
  const repoRoot = join(base, 'repo');
  const ledgerDir = join(base, 'ledger');
  const runDir = join(repoRoot, '.ai', 'runs', 'loopkit');
  mkdirSync(runDir, { recursive: true });
  mkdirSync(ledgerDir, { recursive: true });
  makeGitRepo(repoRoot);

  try {
    const deadPid = 99999998;
    const nonexistentWt = join(base, 'gone-wt');
    // Note: we do NOT create this directory

    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-201', 'item.captured', { source: 'cli', text: 'gone worktree' }),
      makeEvent('conductor', 'WI-201', 'item.queued', { spec: 'build', touches: 'src/' }),
      makeEvent('dispatch', 'WI-201', 'build.dispatched', {
        attempt: 1,
        branch: 'wi-201-a1',
        pid: deadPid,
        worktree: nonexistentWt,
      }),
    ]);

    await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      dryRun: false,
      pidProbe: (pid: number) => pid !== deadPid,
      provider: null as unknown as import('../src/providers/types.js').LlmProvider,
      config: makeTestConfig({ salvage: { enabled: true } }),
    });

    const events = await loadAllEvents(ledgerDir);
    // build.crashed should still happen (that's the doctor's normal job)
    const crashed = events.filter(e => e.type === 'build.crashed' && e.item === 'WI-201');
    assert.ok(crashed.length >= 1, 'build.crashed must be emitted even when worktree is gone');
    // No crash from salvage (it should skip gracefully)
  } finally {
    cleanDir(base);
  }
});

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

test('config: salvage.enabled must be a boolean', () => {
  const base = makeTempDir();
  try {
    writeFileSync(join(base, 'loopkit.config.json'), JSON.stringify({ salvage: { enabled: 'yes' } }), 'utf8');
    assert.throws(
      () => loadConfig(base),
      /salvage\.enabled must be a boolean/,
      'must throw on non-boolean salvage.enabled',
    );
  } finally {
    cleanDir(base);
  }
});

test('config: salvage.maxPatchKb must be a positive finite number', () => {
  const base = makeTempDir();
  try {
    writeFileSync(join(base, 'loopkit.config.json'), JSON.stringify({ salvage: { maxPatchKb: -1 } }), 'utf8');
    assert.throws(
      () => loadConfig(base),
      /salvage\.maxPatchKb must be a positive finite number/,
      'must throw on negative maxPatchKb',
    );
  } finally {
    cleanDir(base);
  }
});

test('config: valid salvage config loads without error', () => {
  const base = makeTempDir();
  try {
    writeFileSync(join(base, 'loopkit.config.json'), JSON.stringify({ salvage: { enabled: true, maxPatchKb: 512 } }), 'utf8');
    const cfg = loadConfig(base);
    assert.equal(cfg.salvage?.enabled, true);
    assert.equal(cfg.salvage?.maxPatchKb, 512);
  } finally {
    cleanDir(base);
  }
});

test('config: default salvage config is enabled with 256 KB cap', () => {
  assert.equal(CONFIG_DEFAULTS.salvage?.enabled, true, 'default: enabled = true');
  assert.equal(CONFIG_DEFAULTS.salvage?.maxPatchKb, 256, 'default: maxPatchKb = 256');
});
