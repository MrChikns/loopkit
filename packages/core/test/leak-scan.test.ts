/**
 * leak-scan.test.ts — regression coverage for scripts/leak-scan.sh's private
 * decision-id detector, including the concat-aware layer that catches ids
 * assembled at runtime (e.g. `['D', <n>].join('-')`) rather than written as
 * literal tokens the base regex would see.
 *
 * Covers:
 *   - baseline: a clean tree passes (exit 0).
 *   - literal `D-NNN` token still blocks (sanity — the pre-existing behavior).
 *   - array + join blocks.
 *   - plus-concat (quote + '+') and template-literal (backtick + '${') variants block.
 *   - the `leak-scan:allow-decision-id` inline marker suppresses a flagged line,
 *     so a legitimate synthetic example doesn't need a whole-file exclude.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// test compiles to dist-test/test/ -> repo root is four up
const repoRoot = join(here, '..', '..', '..', '..');
const scriptPath = join(repoRoot, 'scripts', 'leak-scan.sh');

function makeFixtureRepo(fileContent: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'leak-scan-fixture-'));
  const g = (args: string[]) => spawnSync('git', args, { cwd: dir, stdio: 'pipe' });
  g(['init', '-q', '-b', 'master']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  writeFileSync(join(dir, 'fixture.ts'), fileContent);
  g(['add', 'fixture.ts']);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function runLeakScan(dir: string): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync('sh', [scriptPath, '--staged'], { cwd: dir, encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

test('leak-scan: clean tree passes', () => {
  const { dir, cleanup } = makeFixtureRepo("export const greeting = 'hello world';\n");
  try {
    const res = runLeakScan(dir);
    assert.equal(res.status, 0, res.stderr);
  } finally {
    cleanup();
  }
});

test('leak-scan: literal D-NNN token still blocks (baseline sanity)', () => {
  const { dir, cleanup } = makeFixtureRepo("// see D-000 for background\n"); // leak-scan:allow-decision-id
  try {
    const res = runLeakScan(dir);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /BLOCKED/);
  } finally {
    cleanup();
  }
});

test('leak-scan: decision id assembled via array + join blocks', () => {
  const { dir, cleanup } = makeFixtureRepo("const decisionId = ['D', '000'].join('-');\n"); // leak-scan:allow-decision-id
  try {
    const res = runLeakScan(dir);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /BLOCKED/);
  } finally {
    cleanup();
  }
});

test('leak-scan: decision id smuggled via plus-concat blocks', () => {
  const { dir, cleanup } = makeFixtureRepo("const decisionId = 'D-' + decisionNum;\n"); // leak-scan:allow-decision-id
  try {
    const res = runLeakScan(dir);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /BLOCKED/);
  } finally {
    cleanup();
  }
});

test('leak-scan: decision id smuggled via template literal blocks', () => {
  const { dir, cleanup } = makeFixtureRepo('const decisionId = `D-${decisionNum}`;\n'); // leak-scan:allow-decision-id
  try {
    const res = runLeakScan(dir);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /BLOCKED/);
  } finally {
    cleanup();
  }
});

test('leak-scan: decision id smuggled via .concat() blocks', () => {
  const { dir, cleanup } = makeFixtureRepo("const decisionId = 'D-'.concat(String(decisionNum));\n"); // leak-scan:allow-decision-id
  try {
    const res = runLeakScan(dir);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /BLOCKED/);
  } finally {
    cleanup();
  }
});

test('leak-scan: an unrelated array-join / plus-concat of other letters does not false-positive', () => {
  const { dir, cleanup } = makeFixtureRepo(
    "const csv = ['A', 'B'].join(',');\nconst msg = 'foo' + bar;\nconst tag = `bar-${baz}`;\n",
  );
  try {
    const res = runLeakScan(dir);
    assert.equal(res.status, 0, res.stderr);
  } finally {
    cleanup();
  }
});

test('leak-scan: leak-scan:allow-decision-id marker suppresses a flagged concat construction', () => {
  const { dir, cleanup } = makeFixtureRepo(
    "const decisionId = ['D', '000'].join('-'); // leak-scan:allow-decision-id\n",
  );
  try {
    const res = runLeakScan(dir);
    assert.equal(res.status, 0, res.stderr);
  } finally {
    cleanup();
  }
});

test('leak-scan: leak-scan:allow-decision-id marker suppresses a flagged literal token', () => {
  const { dir, cleanup } = makeFixtureRepo('// example: D-000 // leak-scan:allow-decision-id\n');
  try {
    const res = runLeakScan(dir);
    assert.equal(res.status, 0, res.stderr);
  } finally {
    cleanup();
  }
});
