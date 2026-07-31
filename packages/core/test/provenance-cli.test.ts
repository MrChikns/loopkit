/**
 * provenance-cli.test.ts — WI-232 mechanical governance, the CLI half: `loopctl
 * verify-provenance` and `loopctl provenance break-glass`, spawned against the compiled
 * binary (same convention as cli.test.ts / target-cli.test.ts). provenance.ts itself (pure
 * verifyProvenance/extraction logic) is covered by provenance.test.ts — this file only
 * exercises the CLI seam: argv parsing, target resolution, exit codes, and the ledger writes
 * break-glass makes.
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

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', cwd, ...args], { stdio: 'pipe', encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * Create a real git repo carrying a loopkit.target.json manifest. Two commits land:
 *   1. root commit — a placeholder manifest declares a bogus, never-resolving baseline (a
 *      manifest cannot embed its OWN future sha — self-reference is a fixed-point problem).
 *   2. "pin baseline" commit — rewrites the manifest to declare BASELINE = this commit's own
 *      already-known PARENT (commit 1's sha), which is a real, stable, independently-computed
 *      value. This commit lands ABOVE the declared baseline itself, so it is in-scope and
 *      must carry its own receipt like any other commit a test adds via commitFile().
 * Returns the baseline sha (commit 1) and the pin-commit's own sha, so a test can give the
 * pin commit a receipt when it wants a clean "nothing uncovered below this point" starting
 * state, or omit it deliberately to exercise the uncovered path.
 */
function makeTargetRepo(root: string, manifestOver: Record<string, unknown> = {}): { root: string; baselineSha: string; pinCommitSha: string } {
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 't@t');
  git(root, 'config', 'user.name', 't');
  writeFileSync(join(root, 'README.md'), 'root\n');
  writeFileSync(join(root, TARGET_MANIFEST_FILENAME), JSON.stringify({
    name: 'acme-web',
    defaultBranch: 'main',
    provenanceBaseline: { commit: '0000000000000000000000000000000000000a', reason: 'placeholder', certifiedBy: [] },
    ...manifestOver,
  }, null, 2));
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'root commit + placeholder manifest');
  const baselineSha = git(root, 'rev-parse', 'HEAD');

  writeFileSync(join(root, TARGET_MANIFEST_FILENAME), JSON.stringify({
    name: 'acme-web',
    defaultBranch: 'main',
    provenanceBaseline: { commit: baselineSha, reason: 'pre-plane history', certifiedBy: ['WI-001'] },
    ...manifestOver,
  }, null, 2));
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'pin provenance baseline');
  const pinCommitSha = git(root, 'rev-parse', 'HEAD');
  return { root, baselineSha, pinCommitSha };
}

function commitFile(root: string, name: string, contents: string, message: string): string {
  writeFileSync(join(root, name), contents);
  git(root, 'add', '-A');
  git(root, 'commit', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

/**
 * Commit with an EXPLICIT author/committer date, seconds in the future relative to "now" (an
 * ISO string). grantCoversCommit's window test compares the commit's second-precision git
 * timestamp against the grant's millisecond-precision ledger timestamp — a commit made
 * "immediately after" a grant call can legitimately land in the SAME wall-clock second as the
 * grant event but with an earlier (zeroed) millisecond component, which reads as
 * committedAt < grantedAt and falls OUTSIDE the window even though it happened after in real
 * time. Real operators are not usually racing sub-second like a test does; pinning the date a
 * few seconds later removes that race without touching grantCoversCommit's real semantics.
 */
function commitFileAt(root: string, name: string, contents: string, message: string, afterIso: string, offsetSeconds: number): string {
  const date = new Date(Date.parse(afterIso) + offsetSeconds * 1000).toISOString();
  writeFileSync(join(root, name), contents);
  git(root, 'add', '-A');
  // gatherProvenanceInput reads the COMMITTER date (`%cI`), so both author and committer dates
  // must be pinned — `--date` alone only sets the author date.
  const r = spawnSync('git', ['-C', root, 'commit', '-m', message, '--date', date], {
    stdio: 'pipe',
    encoding: 'utf8',
    env: { ...process.env, GIT_COMMITTER_DATE: date },
  });
  assert.equal(r.status, 0, `git commit --date failed: ${r.stderr}`);
  return git(root, 'rev-parse', 'HEAD');
}

// ---------------------------------------------------------------------------
// verify-provenance
// ---------------------------------------------------------------------------

/** Give the manifest's own baseline-pinning commit a receipt, so tests that want a clean
 *  "nothing uncovered below this point" starting state can layer exactly the commit(s) they
 *  care about on top — the pin commit lands ABOVE the declared baseline (see makeTargetRepo)
 *  and is otherwise in-scope like any other commit. */
async function receiptPinCommit(ledgerDir: string, pinCommitSha: string, item = 'WI-899'): Promise<void> {
  await runLoopctl(ledgerDir, 'append', 'gate.passed', '--item', item, '--data', JSON.stringify({ tests: 'ok' }));
  await runLoopctl(ledgerDir, 'append', 'item.merged', '--item', item, '--data', JSON.stringify({ commit: pinCommitSha }));
}

test('verify-provenance: a matching item.merged receipt with gate evidence → exit 0 verified', async () => {
  const base = mkdtempSync(join(tmpdir(), 'prov-verified-'));
  const ledgerDir = join(base, 'ledger');
  try {
    const { root, pinCommitSha } = makeTargetRepo(join(base, 'repo'));
    await runLoopctl(ledgerDir, 'target', 'add', root);
    await receiptPinCommit(ledgerDir, pinCommitSha);
    const commitSha = commitFile(root, 'a.txt', 'one\n', 'feature commit');

    await runLoopctl(ledgerDir, 'append', 'gate.passed', '--item', 'WI-900', '--data', JSON.stringify({ tests: 'ok' }));
    await runLoopctl(ledgerDir, 'append', 'item.merged', '--item', 'WI-900', '--data', JSON.stringify({ commit: commitSha }));

    const out = await runLoopctl(ledgerDir, 'verify-provenance', root);
    assert.equal(out.code, 0, `expected exit 0, got ${out.code}: ${out.stdout}\n${out.stderr}`);
    assert.match(out.stdout, /VERIFIED/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('verify-provenance: a commit with NO receipt → exit 1 uncovered', async () => {
  const base = mkdtempSync(join(tmpdir(), 'prov-uncovered-'));
  const ledgerDir = join(base, 'ledger');
  try {
    const { root } = makeTargetRepo(join(base, 'repo'));
    await runLoopctl(ledgerDir, 'target', 'add', root);
    commitFile(root, 'a.txt', 'one\n', 'unreceipted commit');

    const out = await runLoopctl(ledgerDir, 'verify-provenance', root);
    assert.equal(out.code, 1, `expected exit 1, got ${out.code}: ${out.stdout}\n${out.stderr}`);
    assert.match(out.stdout, /UNCOVERED/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('verify-provenance: an unregistered target → exit 2 indeterminate', async () => {
  const base = mkdtempSync(join(tmpdir(), 'prov-unregistered-'));
  const ledgerDir = join(base, 'ledger');
  try {
    const { root } = makeTargetRepo(join(base, 'repo'));
    // Initialize the ledger dir (registering an unrelated target) without ever registering
    // `root` — target-not-registered must fire, not ledger-unreadable from a nonexistent dir.
    const other = makeTargetRepo(join(base, 'other-repo'), { name: 'other' });
    await runLoopctl(ledgerDir, 'target', 'add', other.root);
    commitFile(root, 'a.txt', 'one\n', 'some commit');

    const out = await runLoopctl(ledgerDir, 'verify-provenance', root);
    assert.equal(out.code, 2, `expected exit 2, got ${out.code}: ${out.stdout}\n${out.stderr}`);
    assert.match(out.stdout, /INDETERMINATE/);
    assert.match(out.stdout, /target-not-registered/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// WI-242: --target accepts a registered NAME (the convention everywhere else in loopctl),
// aliasing (never replacing) the original path form.
// ---------------------------------------------------------------------------

test('verify-provenance --target <registered-name>: resolves the SAME target as the path form', async () => {
  const base = mkdtempSync(join(tmpdir(), 'prov-target-name-'));
  const ledgerDir = join(base, 'ledger');
  try {
    const { root, pinCommitSha } = makeTargetRepo(join(base, 'repo')); // manifest name: 'acme-web'
    await runLoopctl(ledgerDir, 'target', 'add', root);
    await receiptPinCommit(ledgerDir, pinCommitSha);
    const commitSha = commitFile(root, 'a.txt', 'one\n', 'feature commit');
    await runLoopctl(ledgerDir, 'append', 'gate.passed', '--item', 'WI-900', '--data', JSON.stringify({ tests: 'ok' }));
    await runLoopctl(ledgerDir, 'append', 'item.merged', '--item', 'WI-900', '--data', JSON.stringify({ commit: commitSha }));

    const byName = await runLoopctl(ledgerDir, 'verify-provenance', '--target', 'acme-web');
    assert.equal(byName.code, 0, `expected exit 0, got ${byName.code}: ${byName.stdout}\n${byName.stderr}`);
    assert.match(byName.stdout, /VERIFIED/);

    const byPath = await runLoopctl(ledgerDir, 'verify-provenance', '--target', root);
    assert.equal(byPath.code, byName.code, 'name form and path form must agree on the same target');
    assert.equal(byPath.stdout, byName.stdout, 'name form and path form must produce an identical report');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('provenance break-glass --target <registered-name>: also resolves by name, same as verify-provenance', async () => {
  const base = mkdtempSync(join(tmpdir(), 'prov-bg-target-name-'));
  const ledgerDir = join(base, 'ledger');
  try {
    const { root } = makeTargetRepo(join(base, 'repo')); // manifest name: 'acme-web'
    await runLoopctl(ledgerDir, 'target', 'add', root);

    const out = await runLoopctl(ledgerDir, 'provenance', 'break-glass', '--target', 'acme-web', '--reason', 'operator hand-recovering by name');
    assert.equal(out.code, 0, `expected exit 0, got ${out.code}: ${out.stdout}\n${out.stderr}`);
    assert.match(out.stdout, /Granted break-glass/);

    const events = await loadAllEvents(ledgerDir);
    const grants = events.filter(e => e.type === 'provenance.break-glass');
    assert.equal(grants.length, 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('verify-provenance --target <path> (UNCHANGED alias): a path that happens to not match any registered name still resolves as a path, exactly as before', async () => {
  const base = mkdtempSync(join(tmpdir(), 'prov-target-path-alias-'));
  const ledgerDir = join(base, 'ledger');
  try {
    const { root, pinCommitSha } = makeTargetRepo(join(base, 'repo'));
    await runLoopctl(ledgerDir, 'target', 'add', root);
    await receiptPinCommit(ledgerDir, pinCommitSha);

    const out = await runLoopctl(ledgerDir, 'verify-provenance', '--target', root);
    assert.equal(out.code, 0, `expected exit 0, got ${out.code}: ${out.stdout}\n${out.stderr}`);
    assert.match(out.stdout, /VERIFIED/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('verify-provenance --target <unresolvable-value>: clear error naming BOTH failed resolutions (path AND name)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'prov-target-unresolvable-'));
  const ledgerDir = join(base, 'ledger');
  try {
    const out = await runLoopctl(ledgerDir, 'verify-provenance', '--target', 'no-such-target-anywhere');
    assert.notEqual(out.code, 0);
    assert.match(out.stderr, /Target path not found/);
    assert.match(out.stderr, /not a registered target name/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// WI-265: break-glass on a MULTI-TARGET plane. The retro-certification capture inside
// cmdProvenanceBreakGlass used to call captureIntent without threading the already-resolved
// target through — on a plane with 2+ registered targets, captureIntent's own "N targets
// registered; pass a target to select one" VerbError fired and killed the whole command
// BEFORE the provenance.break-glass event was ever appended, even though --target had been
// given and resolved correctly. Fixed by passing the resolved targetId into captureIntent
// (same field captureIntent already accepts for `loopctl new --target`, resolved via
// byId ?? byName — see verbs.ts).
// ---------------------------------------------------------------------------

test('provenance break-glass on a multi-target plane: --target <name> succeeds, and both the grant and its retro item carry the resolved target', async () => {
  const base = mkdtempSync(join(tmpdir(), 'prov-bg-multitarget-'));
  const ledgerDir = join(base, 'ledger');
  try {
    const { root } = makeTargetRepo(join(base, 'repo'), { name: 'loopkit' });
    const other = makeTargetRepo(join(base, 'other-repo'), { name: 'acme-web' });
    await runLoopctl(ledgerDir, 'target', 'add', other.root);
    await runLoopctl(ledgerDir, 'target', 'add', root);

    const out = await runLoopctl(ledgerDir, 'provenance', 'break-glass', '--target', 'loopkit', '--reason', 'reactor wedged on the loopkit target, hand-recovering');
    assert.equal(out.code, 0, `expected exit 0, got ${out.code}: ${out.stdout}\n${out.stderr}`);
    assert.match(out.stdout, /Granted break-glass/);

    const events = await loadAllEvents(ledgerDir);
    const grants = events.filter(e => e.type === 'provenance.break-glass');
    assert.equal(grants.length, 1, 'the grant event must be appended (not aborted by an unstamped capture)');

    const grantData = grants[0]!.data as { targetId?: string; retroItem?: string };
    assert.ok(grantData.targetId, 'grant must carry the resolved targetId');

    const captures = events.filter(e => e.type === 'item.captured' && e.item === grantData.retroItem);
    assert.equal(captures.length, 1, 'the retro-certification item.captured event must exist');
    const captureData = captures[0]!.data as { targetId?: string; target?: string };
    assert.equal(captureData.targetId, grantData.targetId, 'the retro item must be stamped with the SAME target the grant names');
    assert.equal(captureData.target, 'loopkit');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('provenance break-glass on a SINGLE-target plane: behavior unchanged (regression)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'prov-bg-singletarget-'));
  const ledgerDir = join(base, 'ledger');
  try {
    const { root } = makeTargetRepo(join(base, 'repo')); // manifest name: 'acme-web'
    await runLoopctl(ledgerDir, 'target', 'add', root);

    const out = await runLoopctl(ledgerDir, 'provenance', 'break-glass', '--target', root, '--reason', 'single-target plane, hand-recovering');
    assert.equal(out.code, 0, `expected exit 0, got ${out.code}: ${out.stdout}\n${out.stderr}`);
    assert.match(out.stdout, /Granted break-glass/);

    const events = await loadAllEvents(ledgerDir);
    const grants = events.filter(e => e.type === 'provenance.break-glass');
    assert.equal(grants.length, 1);

    const grantData = grants[0]!.data as { targetId?: string; retroItem?: string };
    const captures = events.filter(e => e.type === 'item.captured' && e.item === grantData.retroItem);
    assert.equal(captures.length, 1);
    const captureData = captures[0]!.data as { targetId?: string; target?: string };
    assert.equal(captureData.targetId, grantData.targetId);
    assert.equal(captureData.target, 'acme-web');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('verify-provenance --ref refs/heads/some-topic-branch: not a promotion boundary, exit 0, and does NOT report verified', async () => {
  const base = mkdtempSync(join(tmpdir(), 'prov-topic-branch-'));
  const ledgerDir = join(base, 'ledger');
  try {
    const { root } = makeTargetRepo(join(base, 'repo'));
    await runLoopctl(ledgerDir, 'target', 'add', root);
    // No receipts at all — if this path incorrectly ran the real check it would be uncovered
    // (exit 1), not verified. The important assertion is the wording AND that 'verified' never
    // appears, so a future refactor cannot silently turn this into a real pass.
    commitFile(root, 'a.txt', 'one\n', 'topic-branch commit');

    const out = await runLoopctl(ledgerDir, 'verify-provenance', root, '--ref', 'refs/heads/some-topic-branch');
    assert.equal(out.code, 0, `expected exit 0, got ${out.code}: ${out.stdout}\n${out.stderr}`);
    assert.match(out.stdout, /not a promotion boundary/);
    assert.doesNotMatch(out.stdout.toLowerCase(), /\bverified\b/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// provenance break-glass
// ---------------------------------------------------------------------------

test('provenance break-glass: refuses a short/missing --reason and writes no event', async () => {
  const base = mkdtempSync(join(tmpdir(), 'prov-bg-short-reason-'));
  const ledgerDir = join(base, 'ledger');
  try {
    const { root } = makeTargetRepo(join(base, 'repo'));
    await runLoopctl(ledgerDir, 'target', 'add', root);

    const missing = await runLoopctl(ledgerDir, 'provenance', 'break-glass', '--target', root);
    assert.notEqual(missing.code, 0);

    const short = await runLoopctl(ledgerDir, 'provenance', 'break-glass', '--target', root, '--reason', 'too short');
    assert.notEqual(short.code, 0);
    assert.match(short.stderr, /at least 12 characters/);

    const events = await loadAllEvents(ledgerDir).catch(() => []);
    assert.equal(events.filter(e => e.type === 'provenance.break-glass').length, 0, 'no grant event must be appended on refusal');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('provenance break-glass: succeeds once; a second call while the first is open is refused, no second event', async () => {
  const base = mkdtempSync(join(tmpdir(), 'prov-bg-once-'));
  const ledgerDir = join(base, 'ledger');
  try {
    const { root } = makeTargetRepo(join(base, 'repo'));
    await runLoopctl(ledgerDir, 'target', 'add', root);

    const first = await runLoopctl(ledgerDir, 'provenance', 'break-glass', '--target', root, '--reason', 'reactor wedged, hand-recovering it');
    assert.equal(first.code, 0, `expected exit 0, got ${first.code}: ${first.stdout}\n${first.stderr}`);
    assert.match(first.stdout, /Granted break-glass/);

    const events1 = await loadAllEvents(ledgerDir);
    assert.equal(events1.filter(e => e.type === 'provenance.break-glass').length, 1);

    const second = await runLoopctl(ledgerDir, 'provenance', 'break-glass', '--target', root, '--reason', 'a second unrelated reason text');
    assert.notEqual(second.code, 0, 'a second concurrent grant must be refused');
    assert.match(second.stderr, /already open/);

    const events2 = await loadAllEvents(ledgerDir);
    assert.equal(events2.filter(e => e.type === 'provenance.break-glass').length, 1, 'no second grant event must be appended');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('provenance break-glass: after a successful grant, a commit made in the window reports break-glass-open (exit 3)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'prov-bg-covers-'));
  const ledgerDir = join(base, 'ledger');
  try {
    const { root, pinCommitSha } = makeTargetRepo(join(base, 'repo'));
    await runLoopctl(ledgerDir, 'target', 'add', root);
    await receiptPinCommit(ledgerDir, pinCommitSha);

    const grantOut = await runLoopctl(ledgerDir, 'provenance', 'break-glass', '--target', root, '--reason', 'operator hand-recovering a wedged reactor');
    assert.equal(grantOut.code, 0, `expected exit 0, got ${grantOut.code}: ${grantOut.stdout}\n${grantOut.stderr}`);

    // Pin the commit a few seconds after the grant call, comfortably inside [grantedAt,
    // expiresAt] — see commitFileAt's doc comment for why "now" alone races the grant's
    // millisecond-precision ledger timestamp against git's second-precision commit timestamp.
    commitFileAt(root, 'a.txt', 'one\n', 'commit under the grant', new Date().toISOString(), 5);

    const verify = await runLoopctl(ledgerDir, 'verify-provenance', root);
    assert.equal(verify.code, 3, `expected exit 3, got ${verify.code}: ${verify.stdout}\n${verify.stderr}`);
    assert.match(verify.stdout, /BREAK-GLASS-OPEN/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
