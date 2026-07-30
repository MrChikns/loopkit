/**
 * commit-msg-hook.test.ts — regression coverage for
 * scripts/git-hooks/commit-msg (WI-244), the LOCAL, commit-time counterpart
 * to leak-scan's AGENTSESSION pass (see packages/core/test/leak-scan.test.ts,
 * which covers the same residue class at push time via `--range`).
 *
 * Covers:
 *   - a commit whose message carries a `Claude-Session: <url>` trailer is
 *     rejected by `git commit` (hook wired via core.hooksPath, exit 1).
 *   - a bare claude.ai/code/session URL without a trailer prefix is
 *     rejected too.
 *   - an ordinary commit message passes.
 *   - prose that merely NAMES the trailer/class (no URL, no trailer shape)
 *     is NOT blocked — chosen deliberately (see the hook's own header
 *     comment) because distinguishing "line looks like a trailer with a URL
 *     value" from "sentence that mentions the words" is cheap with the
 *     existing patterns, so there is no reason to pay the false-positive
 *     cost of blocking all prose mentions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// test compiles to dist-test/test/ -> repo root is four up
const repoRoot = join(here, '..', '..', '..', '..');
const hooksDir = join(repoRoot, 'scripts', 'git-hooks');

// The trailer this hook exists for, assembled as a literal so the test
// exercises the real shape. leak-scan's own AGENTSESSION pass has a per-line
// escape hatch (`leak-scan:allow-agent-session`) for lines like this one in
// its own test file; this file carries the same marker for the same reason —
// the literal trailer text below would otherwise trip leak-scan's tree scan.
const SESSION_TRAILER =
  'Claude-Session: https://claude.ai/code/session_EXAMPLEONLYnotarealsession'; // leak-scan:allow-agent-session

function makeFixtureRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'commit-msg-hook-fixture-'));
  const g = (args: string[]) => spawnSync('git', args, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  g(['config', 'commit.gpgsign', 'false']);
  // Point this fixture repo's hooksPath at the real, tracked hooks directory —
  // the same mechanism scripts/install-hooks.sh sets up for a real clone.
  g(['config', 'core.hooksPath', hooksDir]);
  chmodSync(join(hooksDir, 'commit-msg'), 0o755);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function commit(dir: string, message: string, fileContent = 'harmless content\n') {
  const g = (args: string[]) => spawnSync('git', args, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
  const file = join(dir, `f-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  spawnSync('sh', ['-c', `printf '%s' "$1" > "$2"`, 'sh', fileContent, file]);
  g(['add', '.']);
  return spawnSync('git', ['commit', '-q', '-m', message], { cwd: dir, encoding: 'utf8' });
}

test('commit-msg hook: a Claude-Session trailer blocks the commit', () => {
  const { dir, cleanup } = makeFixtureRepo();
  try {
    const res = commit(dir, `feat: something\n\n${SESSION_TRAILER}\n`);
    assert.notEqual(res.status, 0, res.stderr);
    assert.match(res.stderr + res.stdout, /commit-msg BLOCKED/);
    const log = spawnSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf8' }).stdout;
    assert.equal(log.trim(), '', 'no commit should have been created');
  } finally {
    cleanup();
  }
});

test('commit-msg hook: a bare claude.ai/code/session URL (no trailer prefix) also blocks', () => {
  const { dir, cleanup } = makeFixtureRepo();
  try {
    const res = commit(
      dir,
      'fix: bug\n\nSee https://claude.ai/code/session_EXAMPLEONLYnotarealsession for context.\n', // leak-scan:allow-agent-session
    );
    assert.notEqual(res.status, 0, res.stderr);
    assert.match(res.stderr + res.stdout, /commit-msg BLOCKED/);
  } finally {
    cleanup();
  }
});

test('commit-msg hook: an ordinary commit message passes', () => {
  const { dir, cleanup } = makeFixtureRepo();
  try {
    const res = commit(dir, 'feat: add a thing\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n');
    assert.equal(res.status, 0, res.stderr);
    const log = spawnSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf8' }).stdout;
    assert.equal(log.trim().split('\n').length, 1);
  } finally {
    cleanup();
  }
});

test('commit-msg hook: prose merely naming the trailer class (no URL) is not blocked', () => {
  const { dir, cleanup } = makeFixtureRepo();
  try {
    const res = commit(
      dir,
      'docs(hooks): add the commit-msg guard\n\n' +
        'Rejects a commit whose message contains a Claude-Session trailer or a\n' +
        'claude-ai-code-session-shaped reference, without matching this sentence.\n',
    );
    assert.equal(res.status, 0, res.stderr);
  } finally {
    cleanup();
  }
});
