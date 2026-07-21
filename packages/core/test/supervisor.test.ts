/**
 * supervisor.test.ts — the per-build survivability supervisor (ADR-008 Phase B prep 1).
 *
 * The load-bearing property (the reason this primitive exists): a build survives its PARENT beat
 * crashing mid-build. The `supervisor: survives a killed parent` test proves exactly that — it
 * spawns the standalone supervisor DETACHED from a throwaway parent, SIGKILLs the parent before the
 * worker finishes, and asserts a valid exit file still lands. The others pin the exit-code encoding
 * (clean / non-zero / signalled), the usage-JSON tee the collector re-parses, and the argv wire form.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import {
  superviseBuild, parseSupervisorArgv, formatSupervisorArgs,
} from '../src/supervisor.js';
import { readExitFile, usageJsonPath } from '../src/exitfile.js';

let n = 0;
function freshDir(): string {
  const dir = join(tmpdir(), `loopkit-supervisor-${process.pid}-${++n}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function cleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

// The compiled standalone entry, resolved beside this test's own compiled location
// (dist-test/test/… → dist-test/src/build-supervisor.js).
const SUPERVISOR_ENTRY = fileURLToPath(new URL('../src/build-supervisor.js', import.meta.url));

test('supervisor: a clean worker (exit 0) lands exitCode 0 and tees stdout to the usage JSON', async () => {
  const dir = freshDir();
  try {
    const code = await superviseBuild({
      runDir: dir, itemId: 'WI-1', attempt: 1,
      command: 'sh', args: ['-c', 'printf %s \'{"result":"hi"}\'; exit 0'],
    });
    assert.equal(code, 0);
    const rec = readExitFile(dir, 'WI-1', 1);
    assert.ok(rec, 'a completed worker must leave a readable exit file');
    assert.equal(rec!.exitCode, 0);
    // The usage sidecar is what the collector re-parses (one parser) — it carries the raw stdout.
    assert.equal(rec!.usageJsonPath, usageJsonPath(dir, 'WI-1', 1));
    assert.equal(readFileSync(usageJsonPath(dir, 'WI-1', 1), 'utf8'), '{"result":"hi"}');
  } finally { cleanup(dir); }
});

test('supervisor: a non-zero worker exit is recorded faithfully as the exitCode', async () => {
  const dir = freshDir();
  try {
    const code = await superviseBuild({
      runDir: dir, itemId: 'WI-2', attempt: 3,
      command: 'sh', args: ['-c', 'exit 5'],
    });
    assert.equal(code, 5);
    const rec = readExitFile(dir, 'WI-2', 3);
    assert.ok(rec);
    assert.equal(rec!.exitCode, 5);
  } finally { cleanup(dir); }
});

test('supervisor: a signalled worker lands exitCode null (the ExitRecord signalled shape)', async () => {
  const dir = freshDir();
  try {
    // The worker signals itself — close reports code null, signal SIGTERM.
    const code = await superviseBuild({
      runDir: dir, itemId: 'WI-3', attempt: 1,
      command: 'sh', args: ['-c', 'kill -TERM $$'],
    });
    assert.equal(code, null);
    const rec = readExitFile(dir, 'WI-3', 1);
    assert.ok(rec, 'a signalled worker still leaves an exit file, not nothing');
    assert.equal(rec!.exitCode, null);
  } finally { cleanup(dir); }
});

test('supervisor: an unspawnable command still lands an exit file (never strands the build)', async () => {
  const dir = freshDir();
  try {
    const code = await superviseBuild({
      runDir: dir, itemId: 'WI-4', attempt: 1,
      command: '/nonexistent/definitely-not-a-real-binary-xyz', args: [],
    });
    assert.equal(code, null);
    const rec = readExitFile(dir, 'WI-4', 1);
    assert.ok(rec, 'even a failed spawn must leave an exit file so the collector crashes it honestly');
    assert.equal(rec!.exitCode, null);
  } finally { cleanup(dir); }
});

test('supervisor: writes the optional stderr diagnostic when an errFile is given', async () => {
  const dir = freshDir();
  const errFile = join(dir, 'WI-5-agent.err');
  try {
    await superviseBuild({
      runDir: dir, itemId: 'WI-5', attempt: 1,
      command: 'sh', args: ['-c', 'printf boom 1>&2; exit 1'],
      errFile,
    });
    assert.ok(existsSync(errFile));
    assert.equal(readFileSync(errFile, 'utf8'), 'boom');
  } finally { cleanup(dir); }
});

test('supervisor: argv round-trips through format/parse (one wire form)', () => {
  const opts = {
    runDir: '/runs', itemId: 'WI-9', attempt: 2, cwd: '/wt', errFile: '/runs/WI-9.err',
    command: 'claude', args: ['-p', 'do the thing', '--output-format', 'json'],
  };
  const parsed = parseSupervisorArgv(formatSupervisorArgs(opts));
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.ok && parsed.opts, opts);
});

test('supervisor: a worker flag after -- is never misread as a supervisor flag', () => {
  const parsed = parseSupervisorArgv([
    '--run-dir', '/r', '--item', 'WI-1', '--attempt', '1',
    '--', 'claude', '--run-dir', 'not-ours', '-p', 'x',
  ]);
  assert.ok(parsed.ok);
  assert.equal(parsed.ok && parsed.opts.command, 'claude');
  assert.deepEqual(parsed.ok && parsed.opts.args, ['--run-dir', 'not-ours', '-p', 'x']);
});

test('supervisor: missing required args fail closed with a usage error', () => {
  const parsed = parseSupervisorArgv(['--item', 'WI-1', '--', 'claude']); // no --run-dir/--attempt
  assert.equal(parsed.ok, false);
});

// ── THE survivability proof ────────────────────────────────────────────────
// A detached supervisor must outlive the process that spawned it and still land the exit file.
// This is the exact scenario ADR-008 §4 calls a KNOWN LIMITATION for the in-process path (a beat
// death mid-build strands the build with no exit file → honest-but-wasteful orphan reap). The
// supervisor closes it: the parent is SIGKILLed while the worker still sleeps, yet the exit file
// appears with the worker's real exit code.
test('supervisor: survives a killed parent — exit file still lands', async () => {
  const dir = freshDir();
  try {
    // A throwaway parent that spawns the supervisor DETACHED (its own session) then idles. Written
    // as CommonJS via --input-type so it runs regardless of the package's ESM default. The worker
    // sleeps before exiting so the parent is provably dead BEFORE the worker (and thus the exit
    // file) completes.
    const parentSrc =
      "const { spawn } = require('node:child_process');" +
      'const sup = spawn(process.execPath, [' +
      JSON.stringify(SUPERVISOR_ENTRY) +
      ", '--run-dir', " + JSON.stringify(dir) +
      ", '--item', 'WI-1', '--attempt', '1', '--', 'sh', '-c', 'sleep 0.7; exit 4']," +
      " { detached: true, stdio: 'ignore' });" +
      'sup.unref();' +
      "process.stdout.write('spawned ' + sup.pid + String.fromCharCode(10));" +
      'setInterval(function () {}, 1000);';

    const parent = spawn(process.execPath, ['--input-type=commonjs', '-e', parentSrc], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Wait until the parent reports it has launched the supervisor, then kill the parent HARD.
    await new Promise<void>((res, rej) => {
      let out = '';
      const to = setTimeout(() => rej(new Error('parent never reported the supervisor spawn')), 5000);
      parent.stdout!.on('data', d => {
        out += d.toString();
        if (out.includes('spawned')) { clearTimeout(to); res(); }
      });
      parent.on('error', rej);
      parent.on('exit', () => { clearTimeout(to); rej(new Error('parent exited before spawning')); });
    });
    parent.kill('SIGKILL');

    // The parent is now dead. Poll for the exit file the ORPHANED supervisor must still write.
    let rec = readExitFile(dir, 'WI-1', 1);
    for (let i = 0; i < 120 && !rec; i++) { await sleep(50); rec = readExitFile(dir, 'WI-1', 1); }

    assert.ok(rec, 'the supervisor must land an exit file even though its parent was killed mid-build');
    assert.equal(rec!.exitCode, 4, 'the exit file must carry the worker\'s real exit code, written after the parent died');
  } finally { cleanup(dir); }
});
