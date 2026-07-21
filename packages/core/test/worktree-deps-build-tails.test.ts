/**
 * worktree-deps-build-tails.test.ts — build-failure tail must capture BOTH stdout and stderr.
 *
 * Bug (WI-082): a `file:`-dep build failure tail captured ONLY stderr, but many build tools
 * (tsc chief among them) write compile errors to STDOUT — so a real park rendered as
 * `@scope/core: ;` with an empty tail, hiding the cause entirely. Fixed by `formatFailureTail`:
 * both streams captured, each capped to its tail end (not head), labeled `stdout: …` /
 * `stderr: …`, and an empty stream's label omitted rather than printed blank.
 *
 * Cases:
 *   (unit) formatFailureTail: stdout-only, stderr-only, both-labeled, per-stream cap.
 *   (integration) setupWorkdirDeps: a package whose `build` script fails writing ONLY to
 *     stdout (the tsc-shaped failure) produces a buildFailures entry containing that text —
 *     the exact regression this fix closes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { setupWorkdirDeps, formatFailureTail } from '../src/beats/worktree-deps.js';

let n = 0;
function mkTmp(): string {
  const d = join(tmpdir(), `wtdeps-tails-${process.pid}-${++n}-${Date.now()}`);
  mkdirSync(d, { recursive: true });
  return d;
}
function clean(d: string): void {
  try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── unit: formatFailureTail ──────────────────────────────────────────────────

test('formatFailureTail: stdout-only produces a tail containing the stdout text', () => {
  const tail = formatFailureTail('error TS2305: no exported member Foo', '');
  assert.match(tail, /stdout: .*error TS2305: no exported member Foo/);
  assert.doesNotMatch(tail, /stderr:/);
});

test('formatFailureTail: stderr-only is unchanged (labeled, no stdout label)', () => {
  const tail = formatFailureTail('', 'spawn npm ENOENT');
  assert.match(tail, /stderr: .*spawn npm ENOENT/);
  assert.doesNotMatch(tail, /stdout:/);
});

test('formatFailureTail: both streams present are both labeled', () => {
  const tail = formatFailureTail('compiling...\nerror TS2305: no exported member Foo', 'warning: deprecated flag');
  assert.match(tail, /stdout: [\s\S]*error TS2305: no exported member Foo/);
  assert.match(tail, /stderr: [\s\S]*warning: deprecated flag/);
});

test('formatFailureTail: neither stream present yields an empty string', () => {
  assert.equal(formatFailureTail('', ''), '');
  assert.equal(formatFailureTail(null, undefined), '');
});

test('formatFailureTail: each stream is capped to ~600 chars, kept from the TAIL end', () => {
  // 1000 'H' chars (well over the 600 cap) followed by a distinct tail marker. Only the
  // marker plus whatever fits within the last 600 chars should survive per stream.
  const head = 'H'.repeat(1000);
  const tailMarker = 'TAIL-MARKER-KEPT';
  const longStdout = head + tailMarker;
  const longStderr = head + tailMarker + '-ERR';

  const tail = formatFailureTail(longStdout, longStderr);

  assert.ok(tail.includes(tailMarker), 'tail-end content must survive the cap');

  // Extract each labeled segment and check it individually respects the cap AND that the
  // head was truncated (not just the marker appended after an uncapped head).
  const stdoutMatch = tail.match(/stdout: (.*?)(?: stderr: |$)/s);
  const stderrMatch = tail.match(/stderr: (.*)$/s);
  assert.ok(stdoutMatch, 'stdout segment present');
  assert.ok(stderrMatch, 'stderr segment present');
  assert.ok(stdoutMatch![1].length <= 600, `stdout segment must be capped, got ${stdoutMatch![1].length}`);
  assert.ok(stderrMatch![1].length <= 600, `stderr segment must be capped, got ${stderrMatch![1].length}`);
  assert.ok(stdoutMatch![1].length < longStdout.length, 'stdout segment must be shorter than the uncapped input');
  assert.ok(stderrMatch![1].length < longStderr.length, 'stderr segment must be shorter than the uncapped input');
});

// ── integration: setupWorkdirDeps surfaces a stdout-only build failure ──────

test('setupWorkdirDeps: a build script failing with STDOUT-only output surfaces that text (tsc-shaped regression)', () => {
  const root = mkTmp();
  try {
    const repoRoot = join(root, 'repo');
    const wtPath = join(root, 'wt');
    const workdir = 'apps/example';

    const appDeps = { '@fake/pkg': 'file:../../packages/pkg' };

    // main tree: app + the local package + main node_modules (so overlay path is taken and
    // the pkg's own node_modules link succeeds without erroring first).
    const mainApp = join(repoRoot, workdir);
    mkdirSync(mainApp, { recursive: true });
    writeFileSync(join(mainApp, 'package.json'), JSON.stringify({ name: 'app', dependencies: appDeps }), 'utf8');
    mkdirSync(join(mainApp, 'node_modules'), { recursive: true });

    // A build script that writes ONLY to stdout (like tsc's compile-error report) and exits
    // non-zero — the exact shape that previously produced an empty tail. A standalone script
    // file (rather than an inline `-e` string) sidesteps npm/sh quoting entirely and keeps
    // stderr genuinely empty.
    const buildScriptSrc =
      'process.stdout.write("error TS2305: Module has no exported member \'Foo\'.\\n");\nprocess.exit(1);\n';

    const mainPkg = join(repoRoot, 'packages', 'pkg');
    mkdirSync(mainPkg, { recursive: true });
    writeFileSync(join(mainPkg, 'build.js'), buildScriptSrc, 'utf8');
    writeFileSync(join(mainPkg, 'package.json'), JSON.stringify({
      name: '@fake/pkg', main: 'index.js', scripts: { build: 'node build.js' },
    }), 'utf8');
    writeFileSync(join(mainPkg, 'index.js'), 'module.exports = "MAIN";', 'utf8');

    // worktree: mirrors app + pkg (fresh checkout — no node_modules, no dist).
    const wtApp = join(wtPath, workdir);
    mkdirSync(wtApp, { recursive: true });
    writeFileSync(join(wtApp, 'package.json'), JSON.stringify({ name: 'app', dependencies: appDeps }), 'utf8');

    const wtPkg = join(wtPath, 'packages', 'pkg');
    mkdirSync(wtPkg, { recursive: true });
    writeFileSync(join(wtPkg, 'build.js'), buildScriptSrc, 'utf8');
    writeFileSync(join(wtPkg, 'package.json'), JSON.stringify({
      name: '@fake/pkg', main: 'index.js', scripts: { build: 'node build.js' },
    }), 'utf8');
    writeFileSync(join(wtPkg, 'index.js'), 'module.exports = "WT";', 'utf8');

    const res = setupWorkdirDeps(repoRoot, wtPath, workdir);

    assert.equal(res.buildFailures.length, 1, 'the failing build must be recorded');
    assert.match(
      res.buildFailures[0],
      /no exported member 'Foo'/,
      `stdout-only compile error must survive into the failure reason; got: ${res.buildFailures[0]}`,
    );
    assert.doesNotMatch(res.buildFailures[0], /stderr:/, 'a genuinely empty stderr must carry no stderr label');
    assert.match(res.buildFailures[0], /stdout:/, 'the tail must be labeled stdout');
  } finally { clean(root); }
});
