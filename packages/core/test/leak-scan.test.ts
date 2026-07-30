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
 *
 * Plus the commit-MESSAGE channel (`--range`), which tree scans structurally
 * cannot see:
 *   - an agent session trailer in a message (clean diff) blocks, naming the commit.
 *   - the PCRE-backed classes really run in range mode (they silently matched
 *     nothing while the range corpus went through BSD `grep -P`).
 *   - a clean range exits 0; an empty range exits 3; a bogus range exits 2.
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

function runLeakScanRange(dir: string, range: string): { status: number | null; stderr: string } {
  const res = spawnSync('sh', [scriptPath, '--range', ...range.split(' ')], {
    cwd: dir,
    encoding: 'utf8',
  });
  return { status: res.status, stderr: res.stderr };
}

/**
 * A fixture repo whose COMMIT MESSAGES carry the payload while every diff stays
 * innocuous — the exact shape a tree scan cannot see. Returns the shas in commit
 * order so a test can assert the hit names the right one.
 */
function makeCommitFixtureRepo(messages: string[]): {
  dir: string;
  shas: string[];
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'leak-scan-log-fixture-'));
  const g = (args: string[]) => spawnSync('git', args, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  g(['config', 'commit.gpgsign', 'false']);
  const shas: string[] = [];
  messages.forEach((msg, i) => {
    writeFileSync(join(dir, `f${i}.txt`), `harmless content ${i}\n`);
    g(['add', `f${i}.txt`]);
    g(['commit', '-q', '--no-verify', '-m', msg]);
    shas.push(g(['rev-parse', 'HEAD']).stdout.trim());
  });
  return { dir, shas, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// The trailer this whole class exists for, assembled as a literal so the test
// exercises the real shape. The inline marker keeps THIS file scannable.
const SESSION_TRAILER =
  'Claude-Session: https://claude.ai/code/session_EXAMPLEONLYnotarealsession'; // leak-scan:allow-agent-session

// A real-shaped (but synthetic) personal email for the author/committer
// metadata tests below. The EMAIL class has no per-line escape-hatch marker
// (unlike agent-session/decision-id), so the literal is assembled from parts
// instead of written as one token — otherwise this file's OWN source would
// trip the same detector it exists to test.
const SYNTHETIC_PERSONAL_EMAIL = ['nobody', 'fakemailhost.dev'].join('@');

/**
 * A fixture repo with a clean message+diff on every commit, but ONE commit
 * whose author and/or committer identity (name/email) is overridden via the
 * standard `GIT_AUTHOR_*`/`GIT_COMMITTER_*` env vars — the exact shape a
 * misconfigured machine produces (real personal email, or a hostname-derived
 * name) even when the message and tree are spotless.
 */
function makeIdentityFixtureRepo(overrides: {
  authorName?: string;
  authorEmail?: string;
  committerName?: string;
  committerEmail?: string;
}): { dir: string; shas: string[]; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'leak-scan-identity-fixture-'));
  const g = (args: string[], env?: NodeJS.ProcessEnv) =>
    spawnSync('git', args, { cwd: dir, stdio: 'pipe', encoding: 'utf8', env: { ...process.env, ...env } });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  g(['config', 'commit.gpgsign', 'false']);
  const shas: string[] = [];
  writeFileSync(join(dir, 'f0.txt'), 'harmless content 0\n');
  g(['add', 'f0.txt']);
  g(['commit', '-q', '--no-verify', '-m', 'feat: base']);
  shas.push(g(['rev-parse', 'HEAD']).stdout.trim());

  writeFileSync(join(dir, 'f1.txt'), 'harmless content 1\n');
  g(['add', 'f1.txt']);
  g(
    ['commit', '-q', '--no-verify', '-m', 'feat: an entirely clean subject and body'],
    {
      GIT_AUTHOR_NAME: overrides.authorName ?? 't',
      GIT_AUTHOR_EMAIL: overrides.authorEmail ?? 't@t',
      GIT_COMMITTER_NAME: overrides.committerName ?? 't',
      GIT_COMMITTER_EMAIL: overrides.committerEmail ?? 't@t',
    },
  );
  shas.push(g(['rev-parse', 'HEAD']).stdout.trim());
  return { dir, shas, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('leak-scan --range: a real personal email in AUTHOR metadata blocks, even with a clean message', () => {
  const { dir, shas, cleanup } = makeIdentityFixtureRepo({ authorEmail: SYNTHETIC_PERSONAL_EMAIL });
  try {
    assert.equal(
      spawnSync('sh', [scriptPath, '--head'], { cwd: dir, encoding: 'utf8' }).status,
      0,
      'tree scan should be clean: the residue is metadata-only',
    );
    const res = runLeakScanRange(dir, 'HEAD~1..HEAD');
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /BLOCKED/);
    assert.match(res.stderr, new RegExp(shas[1]), 'the hit must name the offending commit');
  } finally {
    cleanup();
  }
});

test('leak-scan --range: a real personal email in COMMITTER metadata blocks too', () => {
  const { dir, shas, cleanup } = makeIdentityFixtureRepo({ committerEmail: SYNTHETIC_PERSONAL_EMAIL });
  try {
    const res = runLeakScanRange(dir, 'HEAD~1..HEAD');
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /BLOCKED/);
    assert.match(res.stderr, new RegExp(shas[1]), 'the hit must name the offending commit');
  } finally {
    cleanup();
  }
});

test('leak-scan --range: a denylisted operator name in AUTHOR metadata blocks via .leakpatterns.local', () => {
  const { dir, shas, cleanup } = makeIdentityFixtureRepo({ authorName: 'Jane Doe' });
  try {
    writeFileSync(join(dir, '.leakpatterns.local'), 'Jane Doe\n');
    const res = runLeakScanRange(dir, 'HEAD~1..HEAD');
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /BLOCKED/);
    assert.match(res.stderr, new RegExp(shas[1]), 'the hit must name the offending commit');
  } finally {
    cleanup();
  }
});

test('leak-scan --range: ordinary fixture identity (name/email "t") does not false-positive', () => {
  const { dir, cleanup } = makeIdentityFixtureRepo({});
  try {
    const res = runLeakScanRange(dir, 'HEAD~1..HEAD');
    assert.equal(res.status, 0, res.stderr);
  } finally {
    cleanup();
  }
});

test('leak-scan --range: the standard AI co-author identity (noreply email) is not a leak', () => {
  const { dir, cleanup } = makeIdentityFixtureRepo({
    authorName: 'Claude',
    authorEmail: 'noreply@anthropic.com',
    committerName: 'Claude',
    committerEmail: 'noreply@anthropic.com',
  });
  try {
    const res = runLeakScanRange(dir, 'HEAD~1..HEAD');
    assert.equal(res.status, 0, res.stderr);
  } finally {
    cleanup();
  }
});

// GitHub's own commit-identity placeholder — assembled from parts for the same
// reason SYNTHETIC_PERSONAL_EMAIL is: it must appear as a literal in the actual
// git identity under test, but a literal in THIS file's source would trip the
// very detector these tests exercise.
const GITHUB_NOREPLY_EMAIL = ['12345+SomeUser', 'users.noreply.github.com'].join('@');

test('leak-scan --range: a GitHub noreply-placeholder author/committer email is not a leak', () => {
  const { dir, cleanup } = makeIdentityFixtureRepo({
    authorName: 'Some User',
    authorEmail: GITHUB_NOREPLY_EMAIL,
    committerName: 'Some User',
    committerEmail: GITHUB_NOREPLY_EMAIL,
  });
  try {
    const res = runLeakScanRange(dir, 'HEAD~1..HEAD');
    assert.equal(res.status, 0, res.stderr);
  } finally {
    cleanup();
  }
});

test('leak-scan --range: a personal-shaped gmail author email still blocks (regression guard on the GitHub exemption)', () => {
  const { dir, shas, cleanup } = makeIdentityFixtureRepo({ authorEmail: SYNTHETIC_PERSONAL_EMAIL });
  try {
    const res = runLeakScanRange(dir, 'HEAD~1..HEAD');
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /BLOCKED/);
    assert.match(res.stderr, new RegExp(shas[1]), 'the hit must name the offending commit');
  } finally {
    cleanup();
  }
});

test('leak-scan --range: the noreply-domain-as-PREFIX-of-a-longer-domain case still blocks (anchored exemption)', () => {
  const evilEmail = ['foo', 'users.noreply.github.com.evil.com'].join('@');
  const { dir, shas, cleanup } = makeIdentityFixtureRepo({
    authorEmail: evilEmail,
    committerEmail: evilEmail,
  });
  try {
    const res = runLeakScanRange(dir, 'HEAD~1..HEAD');
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /BLOCKED/);
    assert.match(res.stderr, new RegExp(shas[1]), 'the hit must name the offending commit');
  } finally {
    cleanup();
  }
});

test('leak-scan --range: an agent session trailer in a commit MESSAGE blocks, and names the commit', () => {
  const { dir, shas, cleanup } = makeCommitFixtureRepo([
    'feat: first clean commit',
    `fix: an innocent subject\n\nbody text\n\n${SESSION_TRAILER}`,
    'chore: another clean commit',
  ]);
  try {
    // the tree itself is spotless — this is the whole point
    assert.equal(
      spawnSync('sh', [scriptPath, '--head'], { cwd: dir, encoding: 'utf8' }).status,
      0,
      'tree scan should be clean: the residue is message-only',
    );
    const res = runLeakScanRange(dir, 'HEAD~2..HEAD');
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /BLOCKED/);
    assert.match(res.stderr, new RegExp(shas[1]), 'the hit must name the offending commit');
  } finally {
    cleanup();
  }
});

test('leak-scan --range: PCRE-backed classes really run over commit messages', () => {
  // Regression guard: the range corpus used to be piped through the system
  // `grep -P`, which BSD/macOS grep does not support — so every PCRE class
  // (email, decision id) matched nothing at all, silently.
  const { dir, cleanup } = makeCommitFixtureRepo([
    'feat: base',
    'fix: revert per D-000 as agreed', // leak-scan:allow-decision-id
  ]);
  try {
    const res = runLeakScanRange(dir, 'HEAD~1..HEAD');
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /BLOCKED/);
  } finally {
    cleanup();
  }
});

test('leak-scan --range: a clean range exits 0', () => {
  const { dir, cleanup } = makeCommitFixtureRepo([
    'feat: base',
    'feat: add the thing',
    'test: cover the thing',
  ]);
  try {
    const res = runLeakScanRange(dir, 'HEAD~2..HEAD');
    assert.equal(res.status, 0, res.stderr);
  } finally {
    cleanup();
  }
});

test('leak-scan --range: an empty range is loud (exit 3), never a silent green', () => {
  const { dir, cleanup } = makeCommitFixtureRepo(['feat: base', 'feat: more']);
  try {
    const res = runLeakScanRange(dir, 'HEAD..HEAD');
    assert.equal(res.status, 3, res.stderr);
    assert.match(res.stderr, /NOTHING SCANNED/);
    assert.match(res.stderr, /0 commits/);
  } finally {
    cleanup();
  }
});

test('leak-scan --range: an unresolvable rev-range fails as a usage error (exit 2)', () => {
  const { dir, cleanup } = makeCommitFixtureRepo(['feat: base']);
  try {
    const res = runLeakScanRange(dir, 'no-such-ref..HEAD');
    assert.equal(res.status, 2, res.stderr);
    assert.match(res.stderr, /not a valid rev-range/);
  } finally {
    cleanup();
  }
});

test('leak-scan --range: a missing rev-range argument is a usage error, not a no-op', () => {
  const { dir, cleanup } = makeCommitFixtureRepo(['feat: base']);
  try {
    const res = spawnSync('sh', [scriptPath, '--range'], { cwd: dir, encoding: 'utf8' });
    assert.equal(res.status, 2, res.stderr);
  } finally {
    cleanup();
  }
});

test('leak-scan --range: the standard AI co-author trailer is not a leak', () => {
  // A no-reply address identifies nobody and rides on every agent commit; if it
  // blocked, the tripwire would be overridden as a matter of routine.
  const { dir, cleanup } = makeCommitFixtureRepo([
    'feat: base',
    'feat: something\n\nCo-Authored-By: Claude <noreply@anthropic.com>',
  ]);
  try {
    const res = runLeakScanRange(dir, 'HEAD~1..HEAD');
    assert.equal(res.status, 0, res.stderr);
  } finally {
    cleanup();
  }
});

test('leak-scan: an agent session id in FILE content blocks too', () => {
  const { dir, cleanup } = makeFixtureRepo(
    'const url = "https://claude.ai/code/session_EXAMPLEONLYnotarealsession";\n', // leak-scan:allow-agent-session
  );
  try {
    const res = runLeakScan(dir);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /BLOCKED/);
  } finally {
    cleanup();
  }
});

test('leak-scan: leak-scan:allow-agent-session marker suppresses a flagged line', () => {
  const { dir, cleanup } = makeFixtureRepo(
    'const example = "session_EXAMPLEONLYnotarealsession"; // leak-scan:allow-agent-session\n',
  );
  try {
    const res = runLeakScan(dir);
    assert.equal(res.status, 0, res.stderr);
  } finally {
    cleanup();
  }
});

test('leak-scan: ordinary session-shaped identifiers do not false-positive', () => {
  const { dir, cleanup } = makeFixtureRepo(
    [
      'const SESSION_SECRET_KEY = process.env.SESSION_SECRET_KEY;',
      'const session_storage_prefix = "session_storage_key";',
      'const docs = "https://claude.ai/download";',
      'function newSession(sessionId: string) { return { sessionId }; }',
    ].join('\n') + '\n',
  );
  try {
    const res = runLeakScan(dir);
    assert.equal(res.status, 0, res.stderr);
  } finally {
    cleanup();
  }
});

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
