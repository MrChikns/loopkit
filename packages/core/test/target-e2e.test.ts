/**
 * target-e2e.test.ts — TARGET EXTERNALIZATION end-to-end proof (test level):
 *
 * A work item captured against a REGISTERED EXTERNAL target is built in a worktree OF THE
 * TARGET REPO, gated with the manifest's real `node --test` command, and merged into the
 * target's own `main` — proving the plane can drive a repo that is NOT its own home. The
 * decisive assertion is that the merge commit lands in the TARGET repo's main branch (not
 * the plane repo). Plus a legacy-mode regression: an untargeted item still builds against
 * the plane's own repoRoot exactly as before.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { makeEvent } from '../src/schema.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { fold } from '../src/fold.js';
import { runDispatch } from '../src/beats/dispatch.js';
import { manifestHash, readTargetManifest } from '../src/target.js';
import { LlmProvider, ProviderRequest, ProviderResult } from '../src/providers/types.js';
import { LoopkitConfig, CONFIG_DEFAULTS } from '../src/config.js';
import { makeNonCommittingWorker } from './fakeWorker.js';

// Compiled test lives at packages/core/dist-test/test/; the examples dir is at the worktree
// root. Walk up from the compiled test's dir to the first ancestor that has an examples/ dir so
// the path is robust to src-vs-dist-test layout.
function findExamplesDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'examples', 'notes-target');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error('could not locate examples/notes-target');
}
const NOTES_TEMPLATE = findExamplesDir();

function git(cwd: string, args: string[]) {
  return spawnSync('git', args, { cwd, stdio: 'pipe' });
}

/** Build the notes template into a real git repo on `main` and return its root. */
function makeNotesTargetRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  cpSync(NOTES_TEMPLATE, root, { recursive: true });
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 't@t']);
  git(root, ['config', 'user.name', 't']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'init notes target']);
}

/** A plane repo just needs to be a git repo (dispatch runs `git pull` on it after the lane). */
function makePlaneRepo(root: string): void {
  mkdirSync(join(root, '.ai', 'runs', 'loopkit'), { recursive: true });
  git(root, ['init', '-b', 'master']);
  git(root, ['config', 'user.email', 't@t']);
  git(root, ['config', 'user.name', 't']);
  writeFileSync(join(root, 'plane.txt'), 'plane', 'utf8');
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'init plane']);
}

function testConfig(overrides: Partial<LoopkitConfig> = {}): LoopkitConfig {
  return { ...CONFIG_DEFAULTS, promptsDir: '.ai/loops/prompts', notifyHook: '.ai/notify-phone.sh', ...overrides };
}

test('E2E: a targeted item builds in a worktree of the target repo and merges into the target main', async () => {
  const base = mkdtempSync(join(tmpdir(), 'tgt-e2e-'));
  try {
    const planeRoot = join(base, 'plane');
    const targetRoot = join(base, 'notes');
    const ledgerDir = join(base, 'ledger');
    makePlaneRepo(planeRoot);
    makeNotesTargetRepo(targetRoot);

    const manifest = readTargetManifest(targetRoot);
    const hash = manifestHash(manifest);

    // Register the target + capture+queue a targeted item.
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'notes', 'target.registered', {
        name: 'notes', repoPath: targetRoot, manifestHash: hash, defaultBranch: 'main',
      }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'add deleteNote', target: 'notes' }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-001', 'item.queued', { spec: 'add a deleteNote helper', touches: 'src/' }, '2026-01-01T00:02:00Z'),
    ]);

    // Fake provider: writes a real, TEST-GREEN change into the TARGET worktree (req.cwd is the
    // target repo's worktree) but NEVER commits — the real headless worker under
    // DISPATCH_BUILDER_TOOLS holds no git-commit tool at all (WI-166), so a fake that committed
    // here would assert a property the test harness supplied, not the system (ADR-010 point 5).
    // The commit that lands on target main is dispatch's OWN scoped commit, proven below by
    // decisive assertions against the target repo's real git log.
    const provider = makeNonCommittingWorker({
      name: 'fake',
      assertRequest: (req) => {
        const cwd = req.cwd!;
        // Sanity: the worker's cwd must be a worktree of the TARGET repo (carries notes.js).
        assert.ok(existsSync(join(cwd, 'src', 'notes.js')), 'worker cwd must be a worktree of the target repo');
        // The target lane MUST pass the builder allowed-tools list — a headless spawn without
        // it gets permission-prompted on every write (no approver) and parks with "no commit".
        // WI-166: the target lane migrated to DISPATCH_BUILDER_TOOLS (dispatch commits the
        // worker's output itself now) — the worker holds no git-commit tool at all.
        assert.ok(req.tools?.includes('Edit') && req.tools?.includes('Write'),
          `target-lane build request must carry builder tools (got: ${JSON.stringify(req.tools)})`);
        assert.ok(!req.tools?.includes('Bash(git commit:*)'),
          'WI-166: the target lane must NOT grant a commit tool — dispatch commits on the worker\'s behalf');
      },
      files: [
        { path: 'src/extra.js', contents: 'export const marker = 42;\n' },
        {
          path: 'test/extra.test.js',
          contents: "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { marker } from '../src/extra.js';\ntest('marker', () => { assert.equal(marker, 42); });\n",
        },
      ],
      manifest: {
        wi: 'WI-001',
        filesTouched: ['src/extra.js', 'test/extra.test.js'],
        testsAdded: ['test/extra.test.js'],
        confidence: 0.9,
        notes: 'added marker',
        subject: 'feat(WI-001): add extra marker',
      },
    });

    const result = await runDispatch({
      repoRoot: planeRoot,
      ledgerDir,
      autonomy: 'on',
      provider,
      config: testConfig(),
      authProbeResult: { ok: true },
    });

    // The targeted item merged.
    const events = await loadAllEvents(ledgerDir);
    const folded = fold(events);
    assert.equal(folded.items.get('WI-001')?.state, 'merged', `WI-001 must be merged; result: ${JSON.stringify(result.dispatched)}`);
    const merged = events.filter(e => e.type === 'item.merged' && e.item === 'WI-001');
    assert.equal(merged.length, 1, 'exactly one item.merged for the targeted item');
    const mergeCommit = (merged[0].data as { commit: string }).commit;

    // DECISIVE: the merge commit lives in the TARGET repo's main branch, NOT the plane repo.
    const targetLog = spawnSync('git', ['log', '--oneline', 'main'], { cwd: targetRoot, stdio: 'pipe' }).stdout.toString();
    assert.match(targetLog, /add extra marker/, 'the worker commit must be on the target repo main');
    assert.match(targetLog, /WI-001 \(target notes\)/, 'the merge commit must be on the target repo main');

    const commitInTarget = spawnSync('git', ['cat-file', '-t', mergeCommit], { cwd: targetRoot, stdio: 'pipe' });
    assert.equal(commitInTarget.stdout.toString().trim(), 'commit', 'merge commit must exist in the target repo');
    const commitInPlane = spawnSync('git', ['cat-file', '-t', mergeCommit], { cwd: planeRoot, stdio: 'pipe' });
    assert.notEqual(commitInPlane.stdout.toString().trim(), 'commit', 'merge commit must NOT exist in the plane repo');

    // The manifest gate (node --test) actually ran green — proven by the extra passing test surviving.
    const gate = spawnSync('sh', ['-c', 'npm test'], { cwd: targetRoot, stdio: 'pipe' });
    assert.equal(gate.status, 0, 'the merged target repo main must be gate-green');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('WI-166: target lane merges via dispatch\'s own scoped commit when the worker never commits', async () => {
  const base = mkdtempSync(join(tmpdir(), 'tgt-e2e-scoped-'));
  try {
    const planeRoot = join(base, 'plane');
    const targetRoot = join(base, 'notes');
    const ledgerDir = join(base, 'ledger');
    makePlaneRepo(planeRoot);
    makeNotesTargetRepo(targetRoot);

    const manifest = readTargetManifest(targetRoot);
    const hash = manifestHash(manifest);

    await appendEvents(ledgerDir, [
      makeEvent('cli', 'notes', 'target.registered', {
        name: 'notes', repoPath: targetRoot, manifestHash: hash, defaultBranch: 'main',
      }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'add deleteNote', target: 'notes' }, '2026-01-01T00:01:00Z'),
      makeEvent('cli', 'WI-001', 'item.queued', { spec: 'add a deleteNote helper', touches: 'src/' }, '2026-01-01T00:02:00Z'),
    ]);

    // Fake provider: writes a real, TEST-GREEN change but does NOT commit and does NOT hold a
    // commit tool (mirrors the real headless worker under DISPATCH_BUILDER_TOOLS post-WI-166).
    // Also writes a manifest with a "subject" — proving dispatch's scoped commit picks it up,
    // exactly as the batch lane's WI-161 fallback does.
    const provider: LlmProvider = {
      name: 'fake',
      async run(req: ProviderRequest): Promise<ProviderResult> {
        const cwd = req.cwd!;
        assert.ok(!req.tools?.includes('Bash(git commit:*)'),
          'worker must not be able to self-commit in this scenario');
        writeFileSync(join(cwd, 'src', 'extra.js'), 'export const marker = 43;\n', 'utf8');
        writeFileSync(join(cwd, 'test', 'extra.test.js'),
          "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { marker } from '../src/extra.js';\ntest('marker', () => { assert.equal(marker, 43); });\n",
          'utf8');
        writeFileSync(join(cwd, 'MANIFEST-WI-001.json'), JSON.stringify({
          wi: 'WI-001', filesTouched: ['src/extra.js', 'test/extra.test.js'], testsAdded: ['test/extra.test.js'],
          confidence: 0.9, notes: 'added marker', subject: 'feat(WI-001): dispatch-committed marker',
        }), 'utf8');
        // Deliberately NO git add/commit — dispatch's scoped-commit attempt must do it.
        return { ok: true, text: 'done, left uncommitted for dispatch' };
      },
    };

    const result = await runDispatch({
      repoRoot: planeRoot,
      ledgerDir,
      autonomy: 'on',
      provider,
      config: testConfig(),
      authProbeResult: { ok: true },
    });

    const events = await loadAllEvents(ledgerDir);
    const folded = fold(events);
    assert.equal(folded.items.get('WI-001')?.state, 'merged', `WI-001 must be merged via dispatch's scoped commit; result: ${JSON.stringify(result.dispatched)}`);
    const merged = events.filter(e => e.type === 'item.merged' && e.item === 'WI-001');
    assert.equal(merged.length, 1, 'exactly one item.merged for the targeted item');

    // The worker's manifest "subject" reached the actual commit message.
    const targetLog = spawnSync('git', ['log', '--oneline', 'main'], { cwd: targetRoot, stdio: 'pipe' }).stdout.toString();
    assert.match(targetLog, /dispatch-committed marker/, 'dispatch used the worker manifest\'s subject for the commit');

    const gate = spawnSync('sh', ['-c', 'npm test'], { cwd: targetRoot, stdio: 'pipe' });
    assert.equal(gate.status, 0, 'the merged target repo main must be gate-green');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('E2E legacy regression: an untargeted item still builds against the plane repoRoot', async () => {
  const base = mkdtempSync(join(tmpdir(), 'tgt-e2e-legacy-'));
  try {
    const planeRoot = join(base, 'plane');
    const ledgerDir = join(base, 'ledger');
    // Plane repo with an origin (dispatch's legacy engineering path pushes/merges on master).
    mkdirSync(join(planeRoot, '.ai', 'runs', 'loopkit'), { recursive: true });
    git(planeRoot, ['init', '-b', 'master']);
    git(planeRoot, ['config', 'user.email', 't@t']);
    git(planeRoot, ['config', 'user.name', 't']);
    writeFileSync(join(planeRoot, 'base.txt'), 'base', 'utf8');
    git(planeRoot, ['add', '-A']);
    git(planeRoot, ['commit', '-m', 'init']);

    // NO target registered → legacy capture, builds against the plane's own repo.
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-010', 'item.captured', { source: 'cli', text: 'legacy build' }, '2026-01-01T00:00:00Z'),
      makeEvent('cli', 'WI-010', 'item.queued', { spec: 'do X', touches: 'src/' }, '2026-01-01T00:01:00Z'),
    ]);

    // Fake writes files only, never commits — the legacy engineering path is also
    // commitMode: 'dispatch' (WI-161), so the merge commit below must be dispatch's own
    // scoped commit, not one the fake supplied (ADR-010 point 5). No manifest subject is
    // given, so dispatch falls back to its generated "feat(<id>): worker output, committed
    // by dispatch" message — which still carries the item id, so the assertion below is
    // unchanged.
    const provider = makeNonCommittingWorker({
      files: [{ path: 'src/x.ts', contents: '// x' }],
    });

    await runDispatch({
      repoRoot: planeRoot,
      ledgerDir,
      autonomy: 'on',
      provider,
      gateResult: { passed: true, reason: 'green' },
      branchProbe: () => 'master',
      pushProbe: () => ({ status: 0 }),
      config: testConfig(),
      authProbeResult: { ok: true },
    });

    const events = await loadAllEvents(ledgerDir);
    assert.equal(fold(events).items.get('WI-010')?.state, 'merged', 'legacy item still merges via the engineering path');
    // The legacy merge lands on the PLANE repo master (unchanged behavior).
    const planeLog = spawnSync('git', ['log', '--oneline', 'master'], { cwd: planeRoot, stdio: 'pipe' }).stdout.toString();
    assert.match(planeLog, /WI-010/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
