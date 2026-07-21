/**
 * cli-new-parsing.test.ts — WI-062: `loopctl new` argv parsing must be order-independent.
 *
 * Bug: `loopctl new --target X "some text"` stored the literal string "--target" as the
 * captured item's text — cmdNew read `rest[0]` for the positional, which is wrong whenever
 * a flag precedes the text. `loopctl new "some text" --target X` (flags AFTER the text)
 * worked by accident of argument order, not by design.
 *
 * Fix: cli.ts's cmdNew now extracts the text via a shared `positionals()` helper that strips
 * known value-flags (and their values) wherever they sit in argv, so the remaining
 * positional is the text regardless of order — and rejects (no ledger write) a resulting
 * text that is empty or itself flag-shaped (starts with '-').
 *
 * Spawns the compiled CLI binary (same pattern as cli.test.ts / target-cli.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { loadAllEvents } from '../src/ledger.js';
import { TARGET_MANIFEST_FILENAME } from '../src/target.js';

const execFileAsync = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

async function runLoopctl(
  ledgerDir: string,
  ...args: string[]
): Promise<{ stdout: string; stderr: string; code: number }> {
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

/** Create a real git repo carrying a loopkit.target.json manifest (same fixture as target-cli.test.ts). */
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

test('loopctl new "<text>" --target X (text-first): stores the full text and the right target', async () => {
  const base = mkdtempSync(join(tmpdir(), 'new-parse-text-first-'));
  const ledgerDir = join(base, 'ledger');
  const repo = makeTargetRepo(join(base, 'repo'), { name: 'acme-web' });
  try {
    await runLoopctl(ledgerDir, 'target', 'add', repo);

    const out = await runLoopctl(ledgerDir, 'new', 'fix the login flow', '--target', 'acme-web');
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /target: acme-web/);

    const events = await loadAllEvents(ledgerDir);
    const cap = events.find(e => e.type === 'item.captured');
    assert.ok(cap, 'item.captured must be in ledger');
    assert.equal((cap!.data as { text: string }).text, 'fix the login flow');
    assert.equal((cap!.data as { target?: string }).target, 'acme-web');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('loopctl new --target X "<text>" (flags-first): stores the full text and the right target (regression for the argv-order bug)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'new-parse-flags-first-'));
  const ledgerDir = join(base, 'ledger');
  const repo = makeTargetRepo(join(base, 'repo'), { name: 'acme-web' });
  try {
    await runLoopctl(ledgerDir, 'target', 'add', repo);

    const out = await runLoopctl(ledgerDir, 'new', '--target', 'acme-web', 'fix the login flow');
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /target: acme-web/);

    const events = await loadAllEvents(ledgerDir);
    const cap = events.find(e => e.type === 'item.captured');
    assert.ok(cap, 'item.captured must be in ledger');
    assert.equal(
      (cap!.data as { text: string }).text,
      'fix the login flow',
      'the captured text must NOT be the literal string "--target"',
    );
    assert.equal((cap!.data as { target?: string }).target, 'acme-web');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('loopctl new --source flags-first, then text: --source and --target can both precede the text', async () => {
  const base = mkdtempSync(join(tmpdir(), 'new-parse-both-flags-first-'));
  const ledgerDir = join(base, 'ledger');
  const repo = makeTargetRepo(join(base, 'repo'), { name: 'acme-web' });
  try {
    await runLoopctl(ledgerDir, 'target', 'add', repo);

    const out = await runLoopctl(
      ledgerDir, 'new', '--source', 'ext:EXT-999', '--target', 'acme-web', 'the delivery is late',
    );
    assert.equal(out.code, 0, out.stderr);

    const events = await loadAllEvents(ledgerDir);
    const cap = events.find(e => e.type === 'item.captured');
    assert.ok(cap, 'item.captured must be in ledger');
    assert.equal((cap!.data as { text: string }).text, 'the delivery is late');
    assert.equal((cap!.data as { source: string }).source, 'ext:EXT-999');
    assert.equal((cap!.data as { target?: string }).target, 'acme-web');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('loopctl new --target X (no text at all): rejects with non-zero exit, appends nothing', async () => {
  const base = mkdtempSync(join(tmpdir(), 'new-parse-empty-'));
  const ledgerDir = join(base, 'ledger');
  const repo = makeTargetRepo(join(base, 'repo'), { name: 'acme-web' });
  try {
    await runLoopctl(ledgerDir, 'target', 'add', repo);

    const out = await runLoopctl(ledgerDir, 'new', '--target', 'acme-web');
    assert.notEqual(out.code, 0, 'a capture with no text must exit non-zero');
    assert.match(out.stderr, /Usage: loopctl new/);

    const events = await loadAllEvents(ledgerDir).catch(() => []);
    assert.equal(
      events.filter(e => e.type === 'item.captured').length, 0,
      'no item.captured may be appended for an empty capture',
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('loopctl new "--target" (flag-like text, dangling flag with no value): rejects with non-zero exit, appends nothing', async () => {
  const base = mkdtempSync(join(tmpdir(), 'new-parse-flaglike-'));
  const ledgerDir = join(base, 'ledger');
  try {
    // A bare "--target" with nothing after it: positionals() consumes it as a flag (and
    // would try to consume a next value that doesn't exist), leaving no text at all —
    // this must be refused exactly like the empty-text case, never captured as literal text.
    const out = await runLoopctl(ledgerDir, 'new', '--target');
    assert.notEqual(out.code, 0, 'a dangling flag with no positional text must exit non-zero');
    assert.match(out.stderr, /Usage: loopctl new/);

    const events = await loadAllEvents(ledgerDir).catch(() => []);
    assert.equal(
      events.filter(e => e.type === 'item.captured').length, 0,
      'no item.captured may be appended when the resulting text is empty',
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('loopctl new -- --looks-like-a-flag (text that itself starts with a dash): rejects with non-zero exit, appends nothing', async () => {
  const base = mkdtempSync(join(tmpdir(), 'new-parse-dash-text-'));
  const ledgerDir = join(base, 'ledger');
  try {
    // No known flags here at all — the sole positional itself starts with '-'. This is the
    // "starts with '-'" guard firing on its own, independent of the flag-stripping logic.
    const out = await runLoopctl(ledgerDir, 'new', '-oops');
    assert.notEqual(out.code, 0, 'flag-like text must be rejected, not silently captured');
    assert.match(out.stderr, /Usage: loopctl new/);

    const events = await loadAllEvents(ledgerDir).catch(() => []);
    assert.equal(
      events.filter(e => e.type === 'item.captured').length, 0,
      'no item.captured may be appended for flag-like text',
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
