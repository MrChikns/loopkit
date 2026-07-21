/**
 * plane-home.test.ts — resolvePlaneHome precedence, ensurePlaneHome enforce-or-init,
 * and the plane-home commit-on-append path in commitLedgerResidue.
 *
 * The resolver is the ONE source of truth for where the plane's state lives
 * (docs/event-model.md §"The two repos"): LOOPKIT_HOME → explicit plane-home;
 * deprecated LOOPKIT_LEDGER → legacy ledger override; else ~/.loopkit if present;
 * else an existing in-repo .ai/ledger (embedded); else the ~/.loopkit default.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { resolvePlaneHome, ensurePlaneHome, PlaneHomePaths, loadConfig } from '../src/config.js';
import { commitLedgerResidue, findEnclosingGitRoot } from '../src/ledgerCommit.js';

const execFileAsync = promisify(execFile);
// Compiled test lives at dist-test/test/; the CLI compiles to dist-test/src/cli.js (NOT dist/).
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const WORK_DIR = join(tmpdir(), `loopkit-plane-home-test-${process.pid}`);

function makeTemp(label: string): string {
  const dir = join(WORK_DIR, label);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A warn sink that records every message (the resolver's deprecation channel). */
function warnSink(): { warn: (m: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (m: string) => { messages.push(m); }, messages };
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', cwd, ...args], { stdio: 'pipe', encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

// ---------------------------------------------------------------------------
// resolvePlaneHome precedence
// ---------------------------------------------------------------------------

test('resolvePlaneHome: LOOPKIT_HOME set → plane-home mode with the pinned derived layout', () => {
  const base = makeTemp('resolve-env-home');
  try {
    const root = join(base, 'plane');
    const { warn, messages } = warnSink();
    const home = resolvePlaneHome({
      repoRoot: join(base, 'repo'),
      env: { LOOPKIT_HOME: root },
      homeDir: join(base, 'fakehome'),
      warn,
    });
    assert.equal(home.mode, 'plane-home');
    assert.equal(home.root, root);
    assert.equal(home.ledgerDir, join(root, 'ledger'));
    assert.equal(home.configPath, join(root, 'config', 'loopkit.json'));
    assert.equal(home.targetsDir, join(root, 'targets'));
    assert.equal(home.runsDir, join(root, 'runs'));
    assert.equal(home.ledgerOverridden, false);
    assert.equal(messages.length, 0, 'no deprecation warning without LOOPKIT_LEDGER');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('resolvePlaneHome: LOOPKIT_LEDGER beside LOOPKIT_HOME wins for the ledger dir ONLY, with a deprecation warning', () => {
  const base = makeTemp('resolve-both-envs');
  try {
    const root = join(base, 'plane');
    const legacyLedger = join(base, 'legacy-ledger');
    const { warn, messages } = warnSink();
    const home = resolvePlaneHome({
      repoRoot: join(base, 'repo'),
      env: { LOOPKIT_HOME: root, LOOPKIT_LEDGER: legacyLedger },
      homeDir: join(base, 'fakehome'),
      warn,
    });
    assert.equal(home.mode, 'plane-home');
    assert.equal(home.ledgerDir, legacyLedger, 'explicit LOOPKIT_LEDGER wins for the ledger dir');
    assert.equal(home.targetsDir, join(root, 'targets'), 'the rest of the layout stays under LOOPKIT_HOME');
    assert.equal(home.configPath, join(root, 'config', 'loopkit.json'));
    assert.equal(home.ledgerOverridden, true);
    assert.equal(messages.length, 1, 'exactly one deprecation line');
    assert.match(messages[0]!, /LOOPKIT_LEDGER is deprecated/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('resolvePlaneHome: LOOPKIT_LEDGER alone pins legacy embedded behavior entirely, with a deprecation warning', () => {
  const base = makeTemp('resolve-legacy-ledger');
  try {
    const repoRoot = join(base, 'repo');
    const legacyLedger = join(base, 'ledger');
    mkdirSync(repoRoot, { recursive: true });
    const { warn, messages } = warnSink();
    const home = resolvePlaneHome({
      repoRoot,
      env: { LOOPKIT_LEDGER: legacyLedger },
      homeDir: join(base, 'fakehome'),
      warn,
    });
    assert.equal(home.mode, 'embedded', 'the legacy override must never activate plane-home side effects');
    assert.equal(home.root, repoRoot);
    assert.equal(home.ledgerDir, legacyLedger);
    assert.equal(home.configPath, join(repoRoot, 'loopkit.config.json'));
    assert.equal(home.ledgerOverridden, true);
    assert.equal(messages.length, 1);
    assert.match(messages[0]!, /LOOPKIT_LEDGER is deprecated/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('resolvePlaneHome: no env vars + ~/.loopkit exists → plane-home there, even when the repo has an in-repo ledger', () => {
  const base = makeTemp('resolve-home-exists');
  try {
    const fakeHome = join(base, 'fakehome');
    mkdirSync(join(fakeHome, '.loopkit'), { recursive: true });
    // An in-repo ledger with events too — the adopted plane-home still wins.
    const repoRoot = join(base, 'repo');
    mkdirSync(join(repoRoot, '.ai', 'ledger'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai', 'ledger', 'work-2026-07.jsonl'), '{"id":"x"}\n');

    const { warn, messages } = warnSink();
    const home = resolvePlaneHome({ repoRoot, env: {}, homeDir: fakeHome, warn });
    assert.equal(home.mode, 'plane-home');
    assert.equal(home.root, join(fakeHome, '.loopkit'));
    assert.equal(home.ledgerDir, join(fakeHome, '.loopkit', 'ledger'));
    assert.equal(messages.length, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('resolvePlaneHome: no env vars, no ~/.loopkit, in-repo .ai/ledger has events → embedded (never strand an existing setup)', () => {
  const base = makeTemp('resolve-embedded');
  try {
    const repoRoot = join(base, 'repo');
    const inRepo = join(repoRoot, '.ai', 'ledger');
    mkdirSync(inRepo, { recursive: true });
    writeFileSync(join(inRepo, 'work-2026-07.jsonl'), '{"id":"x"}\n');

    const { warn, messages } = warnSink();
    const home = resolvePlaneHome({ repoRoot, env: {}, homeDir: join(base, 'fakehome'), warn });
    assert.equal(home.mode, 'embedded');
    assert.equal(home.root, repoRoot);
    assert.equal(home.ledgerDir, inRepo);
    assert.equal(home.configPath, join(repoRoot, 'loopkit.config.json'));
    assert.equal(home.targetsDir, join(repoRoot, '.ai', 'targets'));
    assert.equal(home.runsDir, join(repoRoot, '.ai', 'runs'));
    assert.equal(home.ledgerOverridden, false);
    assert.equal(messages.length, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('resolvePlaneHome: an EMPTY in-repo .ai/ledger does not count as an existing setup → fresh ~/.loopkit default', () => {
  const base = makeTemp('resolve-empty-inrepo');
  try {
    const repoRoot = join(base, 'repo');
    mkdirSync(join(repoRoot, '.ai', 'ledger'), { recursive: true });
    // Present but no non-empty segment files.
    writeFileSync(join(repoRoot, '.ai', 'ledger', 'work-2026-07.jsonl'), '');

    const fakeHome = join(base, 'fakehome');
    const home = resolvePlaneHome({ repoRoot, env: {}, homeDir: fakeHome, warn: () => {} });
    assert.equal(home.mode, 'plane-home');
    assert.equal(home.root, join(fakeHome, '.loopkit'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('resolvePlaneHome: fresh machine (nothing anywhere) → plane-home at the ~/.loopkit default', () => {
  const base = makeTemp('resolve-fresh');
  try {
    const repoRoot = join(base, 'repo');
    mkdirSync(repoRoot, { recursive: true });
    const fakeHome = join(base, 'fakehome');
    const home = resolvePlaneHome({ repoRoot, env: {}, homeDir: fakeHome, warn: () => {} });
    assert.equal(home.mode, 'plane-home');
    assert.equal(home.root, join(fakeHome, '.loopkit'));
    assert.equal(home.ledgerDir, join(fakeHome, '.loopkit', 'ledger'));
    assert.equal(home.ledgerOverridden, false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ensurePlaneHome — enforce-or-init
// ---------------------------------------------------------------------------

test('ensurePlaneHome: a fresh plane-home is git-inited with layout dirs, .gitignore, union-merge .gitattributes, and an initial commit', () => {
  const base = makeTemp('ensure-fresh');
  try {
    const root = join(base, 'plane');
    const home = resolvePlaneHome({ repoRoot: join(base, 'repo'), env: { LOOPKIT_HOME: root }, homeDir: base, warn: () => {} });
    ensurePlaneHome(home);

    assert.ok(existsSync(join(root, '.git')), 'plane-home must be a git repo');
    assert.ok(existsSync(join(root, 'ledger')), 'ledger/ must exist');
    assert.ok(existsSync(join(root, 'targets')), 'targets/ must exist');
    assert.ok(existsSync(join(root, 'runs')), 'runs/ must exist');
    assert.ok(existsSync(join(root, 'config')), 'config/ must exist');
    assert.ok(existsSync(join(root, '.gitignore')), '.gitignore must be written');

    const attrs = readFileSync(join(root, '.gitattributes'), 'utf8');
    assert.match(attrs, /ledger\/\*\.jsonl merge=union/, 'the union-merge rule must cover the ledger segments');

    const log = git(root, 'log', '--oneline');
    assert.equal(log.split('\n').length, 1, 'exactly one initial commit');
    assert.match(log, /initialize plane-home/);

    // Idempotent: re-running changes nothing.
    ensurePlaneHome(home);
    assert.equal(git(root, 'log', '--oneline').split('\n').length, 1, 're-run must not add commits');
    assert.equal(git(root, 'status', '--porcelain', '--', '.gitignore', '.gitattributes'), '', 'init files stay committed');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('ensurePlaneHome: embedded mode is a no-op (never git-inits the driven repo path)', () => {
  const base = makeTemp('ensure-embedded-noop');
  try {
    const repoRoot = join(base, 'repo');
    mkdirSync(repoRoot, { recursive: true });
    const home: PlaneHomePaths = {
      mode: 'embedded',
      root: repoRoot,
      ledgerDir: join(repoRoot, '.ai', 'ledger'),
      configPath: join(repoRoot, 'loopkit.config.json'),
      targetsDir: join(repoRoot, '.ai', 'targets'),
      runsDir: join(repoRoot, '.ai', 'runs'),
      ledgerOverridden: false,
    };
    ensurePlaneHome(home);
    assert.ok(!existsSync(join(repoRoot, '.git')), 'embedded mode must not git init');
    assert.ok(!existsSync(join(repoRoot, '.gitattributes')), 'embedded mode must not write files');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('ensurePlaneHome: a failed git init throws LOUDLY — durability must never degrade silently', () => {
  const base = makeTemp('ensure-init-fails');
  try {
    const root = join(base, 'plane');
    const home = resolvePlaneHome({ repoRoot: join(base, 'repo'), env: { LOOPKIT_HOME: root }, homeDir: base, warn: () => {} });
    assert.throws(
      () => ensurePlaneHome(home, () => ({ status: 1, stderr: 'simulated git failure' })),
      /git init FAILED.*simulated git failure/s,
    );
    assert.ok(!existsSync(join(root, '.git')), 'no repo must be left behind by the failed init');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// commitLedgerResidue — plane-home commit-on-append
// ---------------------------------------------------------------------------

test('commitLedgerResidue: a plane-home ledger OUTSIDE the driven repo commits into the plane-home repo (never a silent no-op)', () => {
  const base = makeTemp('residue-plane-home');
  try {
    const root = join(base, 'plane');
    const drivenRepo = join(base, 'driven-repo');   // deliberately NOT a git repo
    mkdirSync(drivenRepo, { recursive: true });
    const home = resolvePlaneHome({ repoRoot: drivenRepo, env: { LOOPKIT_HOME: root }, homeDir: base, warn: () => {} });
    ensurePlaneHome(home);

    writeFileSync(join(home.ledgerDir, 'work-2026-07.jsonl'), '{"item":"WI-042","type":"item.captured"}\n');

    const result = commitLedgerResidue(drivenRepo, home.ledgerDir, 'reactor');
    assert.equal(result.committed, true, `expected a commit, got: ${result.detail}`);
    assert.match(result.detail, /reactor residue/);
    assert.match(result.detail, /WI-042/);

    const log = git(root, 'log', '--oneline');
    assert.equal(log.split('\n').length, 2, 'initial commit + residue commit');
    assert.equal(git(root, 'status', '--porcelain', '--', 'ledger'), '', 'ledger residue must be fully committed');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('commitLedgerResidue: an outside-repo ledger with NO enclosing git repo reports the gap instead of committing', () => {
  const base = makeTemp('residue-no-repo');
  try {
    const drivenRepo = join(base, 'driven-repo');
    const strayLedger = join(base, 'stray', 'ledger');
    mkdirSync(drivenRepo, { recursive: true });
    mkdirSync(strayLedger, { recursive: true });
    assert.equal(findEnclosingGitRoot(strayLedger), undefined, 'precondition: nothing above the stray ledger is a repo');

    writeFileSync(join(strayLedger, 'work-2026-07.jsonl'), '{"item":"WI-001"}\n');
    const result = commitLedgerResidue(drivenRepo, strayLedger, 'dispatch');
    assert.equal(result.committed, false);
    assert.match(result.detail, /not inside any git repo/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('findEnclosingGitRoot: resolves the nearest ancestor repo for a nested dir', () => {
  const base = makeTemp('enclosing-root');
  try {
    const root = join(base, 'repo');
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    git(dirname(root), 'init', '--quiet', root);
    assert.equal(findEnclosingGitRoot(join(root, 'a', 'b')), root);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI seam — the resolver + enforce-or-init wired end to end
// ---------------------------------------------------------------------------

test('loopctl new with LOOPKIT_HOME: initializes the plane-home repo and appends the capture under <home>/ledger', async () => {
  const base = makeTemp('cli-plane-home');
  try {
    const root = join(base, 'plane');
    const { stdout } = await execFileAsync(process.execPath, [CLI, 'new', 'plane-home smoke item'], {
      // Blank LOOPKIT_LEDGER so an inherited legacy override can never leak into this test.
      env: { ...process.env, LOOPKIT_HOME: root, LOOPKIT_LEDGER: '' },
    });
    assert.match(stdout, /Created WI-\d+/);

    assert.ok(existsSync(join(root, '.git')), 'the CLI must enforce-or-init the plane-home before appending');
    const attrs = readFileSync(join(root, '.gitattributes'), 'utf8');
    assert.match(attrs, /ledger\/\*\.jsonl merge=union/);
    const segments = readdirSync(join(root, 'ledger')).filter(f => /^work-\d{4}-\d{2}\.jsonl$/.test(f));
    assert.equal(segments.length, 1, 'the capture must land in a ledger segment under the plane-home');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('loopctl with legacy LOOPKIT_LEDGER: still works, and prints the one-line deprecation warning to stderr', async () => {
  const dir = makeTemp('cli-legacy-warning');
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, 'new', 'legacy override item'], {
      env: { ...process.env, LOOPKIT_LEDGER: dir, LOOPKIT_HOME: '' },
    });
    assert.match(stdout, /Created WI-\d+/);
    const deprecations = (stderr ?? '').split('\n').filter(l => l.includes('LOOPKIT_LEDGER is deprecated'));
    assert.equal(deprecations.length, 1, `expected exactly one deprecation line, got stderr:\n${stderr}`);
    assert.ok(!existsSync(join(dir, '.git')), 'the legacy override must never git-init anything');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig: explicit LOOPKIT_HOME reads the plane-home config; without it the repo-root file wins (no ambient switching)', () => {
  const home = mkdtempSync(join(tmpdir(), 'lk-home-'));
  const repo = mkdtempSync(join(tmpdir(), 'lk-repo-'));
  const saved = process.env['LOOPKIT_HOME'];
  try {
    mkdirSync(join(home, 'config'), { recursive: true });
    writeFileSync(join(home, 'config', 'loopkit.json'), JSON.stringify({ breakerN: 7 }), 'utf8');
    writeFileSync(join(repo, 'loopkit.config.json'), JSON.stringify({ breakerN: 4 }), 'utf8');

    process.env['LOOPKIT_HOME'] = home;
    assert.equal(loadConfig(repo).breakerN, 7, 'explicit LOOPKIT_HOME → plane-home config wins');

    delete process.env['LOOPKIT_HOME'];
    assert.equal(loadConfig(repo).breakerN, 4, 'no env → repo-root config, regardless of any ~/.loopkit on the machine');
  } finally {
    if (saved === undefined) delete process.env['LOOPKIT_HOME']; else process.env['LOOPKIT_HOME'] = saved;
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// WI-054 — knowledge config: bare strings (today's globs) AND source objects
// ({ path, label?, kind? }) both parse; bad shapes throw so misconfig is caught early.
// ---------------------------------------------------------------------------

/** Load a repo-root loopkit.config.json without any ambient plane-home interfering. */
function loadKnowledgeConfig(configJson: unknown): ReturnType<typeof loadConfig>['knowledge'] {
  const repo = mkdtempSync(join(tmpdir(), 'lk-know-'));
  const saved = process.env['LOOPKIT_HOME'];
  delete process.env['LOOPKIT_HOME'];
  try {
    writeFileSync(join(repo, 'loopkit.config.json'), JSON.stringify(configJson), 'utf8');
    return loadConfig(repo).knowledge;
  } finally {
    if (saved === undefined) delete process.env['LOOPKIT_HOME']; else process.env['LOOPKIT_HOME'] = saved;
    rmSync(repo, { recursive: true, force: true });
  }
}

test('knowledge config: bare-string paths keep today\'s glob semantics (back-compat)', () => {
  const k = loadKnowledgeConfig({ knowledge: { paths: ['docs/*.md', 'notes/decisions.md'] } });
  assert.deepEqual(k?.paths, ['docs/*.md', 'notes/decisions.md']);
});

test('knowledge config: source objects parse with label + kind, mixed with bare strings', () => {
  const k = loadKnowledgeConfig({
    knowledge: {
      paths: ['docs/*.md', { path: 'docs/log.md', kind: 'decision-log', label: 'Decisions' }],
      targets: { 'acme-web': [{ path: 'docs/vision.md', label: 'Vision' }, 'docs/plans/*.md'] },
    },
  });
  assert.deepEqual(k?.paths?.[0], 'docs/*.md');
  assert.deepEqual(k?.paths?.[1], { path: 'docs/log.md', kind: 'decision-log', label: 'Decisions' });
  assert.deepEqual(k?.targets?.['acme-web']?.[0], { path: 'docs/vision.md', label: 'Vision' });
  assert.equal(k?.targets?.['acme-web']?.[1], 'docs/plans/*.md');
});

test('knowledge config: a source object without a path throws', () => {
  assert.throws(
    () => loadKnowledgeConfig({ knowledge: { paths: [{ label: 'No path' }] } }),
    /knowledge\.paths\[0\]\.path must be a non-empty string/,
  );
});

test('knowledge config: an unknown kind throws', () => {
  assert.throws(
    () => loadKnowledgeConfig({ knowledge: { paths: [{ path: 'docs/x.md', kind: 'pdf' }] } }),
    /kind must be 'markdown' or 'decision-log'/,
  );
});
