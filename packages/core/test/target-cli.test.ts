/**
 * target-cli.test.ts — TARGET EXTERNALIZATION: drive `loopctl target add/list` and
 * `loopctl new --target` through the CLI seam (spawns the compiled cli.js, like cli.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { spawnSync } from 'node:child_process';

import { loadAllEvents } from '../src/ledger.js';
import { fold } from '../src/fold.js';
import { TARGET_MANIFEST_FILENAME } from '../src/target.js';

const execFileAsync = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

async function runLoopctl(ledgerDir: string, ...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      env: { ...process.env, LOOPKIT_LEDGER: ledgerDir },
    });
    return { stdout: stdout.trim(), stderr: stderr.trim(), code: 0 };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return { stdout: (err.stdout ?? '').trim(), stderr: (err.stderr ?? '').trim(), code: err.code ?? 1 };
  }
}

/** Create a real git repo carrying a loopkit.target.json manifest. */
function makeTargetRepo(root: string, manifest: Record<string, unknown>): string {
  mkdirSync(root, { recursive: true });
  const g = (args: string[]) => spawnSync('git', args, { cwd: root, stdio: 'pipe' });
  g(['init', '-b', 'main']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  writeFileSync(join(root, TARGET_MANIFEST_FILENAME), JSON.stringify(manifest, null, 2));
  g(['add', '-A']);
  g(['commit', '-m', 'init']);
  return root;
}

test('loopctl target add: validates + prints manifest commands + registers', async () => {
  const base = mkdtempSync(join(tmpdir(), 'tgt-add-'));
  const ledgerDir = join(base, 'ledger');
  const repo = makeTargetRepo(join(base, 'repo'), { name: 'notes', gateCommand: 'npm test', defaultBranch: 'main' });
  try {
    const out = await runLoopctl(ledgerDir, 'target', 'add', repo);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /Target 'notes'/);
    assert.match(out.stdout, /gateCommand:\s+npm test/);
    assert.match(out.stdout, /Registered target 'notes'/);

    const events = await loadAllEvents(ledgerDir);
    const reg = events.find(e => e.type === 'target.registered');
    assert.ok(reg, 'target.registered must be appended');
    assert.equal((reg!.data as { name: string }).name, 'notes');
    assert.equal((reg!.data as { defaultBranch: string }).defaultBranch, 'main');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('loopctl target add: a non-git path fails and appends nothing', async () => {
  const base = mkdtempSync(join(tmpdir(), 'tgt-nongit-'));
  const ledgerDir = join(base, 'ledger');
  const notRepo = join(base, 'plain');
  mkdirSync(notRepo, { recursive: true });
  writeFileSync(join(notRepo, TARGET_MANIFEST_FILENAME), JSON.stringify({ name: 'x' }));
  try {
    const out = await runLoopctl(ledgerDir, 'target', 'add', notRepo);
    assert.notEqual(out.code, 0);
    assert.match(out.stderr, /Not a git repository/);
    const events = await loadAllEvents(ledgerDir).catch(() => []);
    assert.equal(events.filter(e => e.type === 'target.registered').length, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('loopctl target add: a repo with no manifest fails clearly', async () => {
  const base = mkdtempSync(join(tmpdir(), 'tgt-nomanifest-'));
  const ledgerDir = join(base, 'ledger');
  const repo = join(base, 'repo');
  mkdirSync(repo, { recursive: true });
  spawnSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'pipe' });
  try {
    const out = await runLoopctl(ledgerDir, 'target', 'add', repo);
    assert.notEqual(out.code, 0);
    assert.match(out.stderr, new RegExp(`No ${TARGET_MANIFEST_FILENAME}`));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('loopctl target list: shows registered targets', async () => {
  const base = mkdtempSync(join(tmpdir(), 'tgt-list-'));
  const ledgerDir = join(base, 'ledger');
  const repo = makeTargetRepo(join(base, 'repo'), { name: 'notes' });
  try {
    await runLoopctl(ledgerDir, 'target', 'add', repo);
    const out = await runLoopctl(ledgerDir, 'target', 'list', '--json');
    assert.equal(out.code, 0, out.stderr);
    const rows = JSON.parse(out.stdout);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'notes');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('loopctl target add: re-adding a changed manifest appends target.manifest-updated', async () => {
  const base = mkdtempSync(join(tmpdir(), 'tgt-reupdate-'));
  const ledgerDir = join(base, 'ledger');
  const repo = makeTargetRepo(join(base, 'repo'), { name: 'notes', gateCommand: 'npm test' });
  try {
    await runLoopctl(ledgerDir, 'target', 'add', repo);
    // Change the manifest, re-add.
    writeFileSync(join(repo, TARGET_MANIFEST_FILENAME), JSON.stringify({ name: 'notes', gateCommand: 'make test' }));
    const out = await runLoopctl(ledgerDir, 'target', 'add', repo);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /Updated manifest/);

    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.type === 'target.registered').length, 1);
    assert.equal(events.filter(e => e.type === 'target.manifest-updated').length, 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('loopctl new: stamps the sole registered target on item.captured', async () => {
  const base = mkdtempSync(join(tmpdir(), 'tgt-new-stamp-'));
  const ledgerDir = join(base, 'ledger');
  const repo = makeTargetRepo(join(base, 'repo'), { name: 'notes' });
  try {
    await runLoopctl(ledgerDir, 'target', 'add', repo);
    const out = await runLoopctl(ledgerDir, 'new', 'add a helper');
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /target: notes/);

    const events = await loadAllEvents(ledgerDir);
    const cap = events.find(e => e.type === 'item.captured');
    assert.equal((cap!.data as { target?: string }).target, 'notes');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('loopctl new: with NO target registered, item.captured has no target (legacy)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'tgt-new-legacy-'));
  const ledgerDir = join(base, 'ledger');
  try {
    const out = await runLoopctl(ledgerDir, 'new', 'legacy build');
    assert.equal(out.code, 0, out.stderr);
    assert.doesNotMatch(out.stdout, /target:/);
    const events = await loadAllEvents(ledgerDir);
    const cap = events.find(e => e.type === 'item.captured');
    assert.equal((cap!.data as { target?: string }).target, undefined);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('loopctl new --target <unknown>: fails without appending', async () => {
  const base = mkdtempSync(join(tmpdir(), 'tgt-new-unknown-'));
  const ledgerDir = join(base, 'ledger');
  const repo = makeTargetRepo(join(base, 'repo'), { name: 'notes' });
  try {
    await runLoopctl(ledgerDir, 'target', 'add', repo);
    const out = await runLoopctl(ledgerDir, 'new', 'x', '--target', 'ghost');
    assert.notEqual(out.code, 0);
    assert.match(out.stderr, /Unknown target 'ghost'/);
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter(e => e.type === 'item.captured').length, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
