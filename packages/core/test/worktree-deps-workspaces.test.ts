/**
 * worktree-deps-workspaces.test.ts — npm-workspaces local-dep detection for build worktrees.
 *
 * Extends the worktree-deps.test.ts coverage to the OTHER shape a local dependency takes in
 * this repo (and any npm-workspaces monorepo): packages depend on each other by NAME via the
 * root `package.json`'s `workspaces` globs (e.g. `"@loopkit/core": "*"`), never a `file:`
 * spec. `readFileDeps` previously only recognised `file:` specs, so a workspaces-style
 * cross-package worktree change (core export + console consumer together) kept the cheap
 * single-symlink node_modules and gate-failed against the MAIN tree's stale package copy.
 *
 * Cases:
 *   (a) workspaces-style dep (name matches a workspace package, spec `*`) → same overlay
 *       path as a `file:` dep: real node_modules dir, the dep resolves into the WORKTREE,
 *       a plain entry still resolves into the main tree, and require() loads the worktree
 *       source. Also covers a `workspace:*` spec (pnpm-style, sometimes seen in npm repos too).
 *   (b) a dependency name that is NOT a workspace package → cheap single-symlink path,
 *       even though the repo has workspaces configured (regression pin: this must not
 *       overlay everything unconditionally).
 *   (c) existing `file:` behaviour is unchanged when the repo ALSO has workspaces configured.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, rmSync, writeFileSync, symlinkSync, existsSync, lstatSync, realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { setupWorkdirDeps, readFileDeps, readWorkspacePackages } from '../src/beats/worktree-deps.js';

let n = 0;
function mkTmp(): string {
  const d = join(tmpdir(), `wtdeps-ws-${process.pid}-${++n}-${Date.now()}`);
  mkdirSync(d, { recursive: true });
  return d;
}
function clean(d: string): void {
  try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Build a fake main tree at <root>/repo and a fake worktree at <root>/wt, both npm-workspaces
 * repos (root package.json `workspaces: ["packages/*"]`). The app workdir is `apps/example`;
 * it depends on `@fake/pkg` (a workspace package, `packages/pkg`) by NAME, not `file:`.
 *
 * `spec` controls the dependency spec string (`*`, a semver range, or `workspace:*`).
 * `unmatchedName` (case b) swaps the dep name for one that has NO matching workspace package.
 */
function makeLayout(root: string, opts: { spec: string; unmatchedName?: boolean; alsoFileDep?: boolean }): {
  repoRoot: string; wtPath: string; workdir: string;
} {
  const repoRoot = join(root, 'repo');
  const wtPath = join(root, 'wt');
  const workdir = 'apps/example';

  const depName = opts.unmatchedName ? '@fake/not-a-workspace-member' : '@fake/pkg';
  const appDeps: Record<string, string> = { 'left-pad': '^1.0.0', [depName]: opts.spec };
  if (opts.alsoFileDep) appDeps['@fake/filedep'] = 'file:../../packages/filedep';

  // ── root package.json (workspaces config) — both trees ─────────────────────
  for (const root_ of [repoRoot, wtPath]) {
    mkdirSync(root_, { recursive: true });
    writeFileSync(join(root_, 'package.json'),
      JSON.stringify({ name: 'fake-monorepo', private: true, workspaces: ['packages/*'] }), 'utf8');
  }

  // ── main tree ──────────────────────────────────────────────────────────────
  const mainApp = join(repoRoot, workdir);
  mkdirSync(mainApp, { recursive: true });
  writeFileSync(join(mainApp, 'package.json'),
    JSON.stringify({ name: 'app', dependencies: appDeps }), 'utf8');

  const mainNm = join(mainApp, 'node_modules');
  mkdirSync(join(mainNm, 'left-pad'), { recursive: true });
  writeFileSync(join(mainNm, 'left-pad', 'index.js'), 'module.exports = "main-leftpad";', 'utf8');
  mkdirSync(join(mainNm, '.bin'), { recursive: true });
  writeFileSync(join(mainNm, '.bin', 'tsc'), '#!/bin/sh\necho tsc', 'utf8');
  mkdirSync(join(mainNm, '@types', 'node'), { recursive: true });
  writeFileSync(join(mainNm, '@types', 'node', 'index.d.ts'), '// types', 'utf8');

  // the workspace package — MAIN tree version exports STALE
  const pkgBuild = 'node ./node_modules/fake-tool/tool.js';
  const mainPkg = join(repoRoot, 'packages', 'pkg');
  mkdirSync(mainPkg, { recursive: true });
  writeFileSync(join(mainPkg, 'package.json'),
    JSON.stringify({ name: '@fake/pkg', main: 'index.js', scripts: { build: pkgBuild } }), 'utf8');
  writeFileSync(join(mainPkg, 'index.js'), 'module.exports = "MAIN-STALE";', 'utf8');
  mkdirSync(join(mainPkg, 'node_modules', 'fake-tool'), { recursive: true });
  writeFileSync(join(mainPkg, 'node_modules', 'fake-tool', 'tool.js'),
    'require("node:fs").mkdirSync("dist",{recursive:true});require("node:fs").writeFileSync("dist/out.js","built");',
    'utf8');

  // npm's own shape for a workspace dep: node_modules/@fake/pkg symlinks into packages/pkg.
  if (!opts.unmatchedName) {
    mkdirSync(join(mainNm, '@fake'), { recursive: true });
    symlinkSync(mainPkg, join(mainNm, '@fake', 'pkg'));
  }

  if (opts.alsoFileDep) {
    const mainFileDepPkg = join(repoRoot, 'packages', 'filedep');
    mkdirSync(mainFileDepPkg, { recursive: true });
    writeFileSync(join(mainFileDepPkg, 'package.json'),
      JSON.stringify({ name: '@fake/filedep', main: 'index.js' }), 'utf8');
    writeFileSync(join(mainFileDepPkg, 'index.js'), 'module.exports = "MAIN-STALE-FILEDEP";', 'utf8');
    mkdirSync(join(mainNm, '@fake'), { recursive: true });
    symlinkSync(mainFileDepPkg, join(mainNm, '@fake', 'filedep'));
  }

  // ── worktree ────────────────────────────────────────────────────────────────
  const wtApp = join(wtPath, workdir);
  mkdirSync(wtApp, { recursive: true });
  writeFileSync(join(wtApp, 'package.json'),
    JSON.stringify({ name: 'app', dependencies: appDeps }), 'utf8');

  // the workspace package's WORKTREE (branch) copy — needed for workspace resolution and,
  // when unmatchedName is set, absent (so the map genuinely has no entry for this dep).
  if (!opts.unmatchedName) {
    const wtPkg = join(wtPath, 'packages', 'pkg');
    mkdirSync(wtPkg, { recursive: true });
    writeFileSync(join(wtPkg, 'package.json'),
      JSON.stringify({ name: '@fake/pkg', main: 'index.js', scripts: { build: pkgBuild } }), 'utf8');
    writeFileSync(join(wtPkg, 'index.js'), 'module.exports = "WT-BRANCH-NEW";', 'utf8');
    // NOTE: no node_modules and no dist in the worktree copy — the fresh-checkout state.
  }

  if (opts.alsoFileDep) {
    const wtFileDepPkg = join(wtPath, 'packages', 'filedep');
    mkdirSync(wtFileDepPkg, { recursive: true });
    writeFileSync(join(wtFileDepPkg, 'package.json'),
      JSON.stringify({ name: '@fake/filedep', main: 'index.js' }), 'utf8');
    writeFileSync(join(wtFileDepPkg, 'index.js'), 'module.exports = "WT-BRANCH-NEW-FILEDEP";', 'utf8');
  }

  return { repoRoot, wtPath, workdir };
}

// ─────────────────────────────────────────────────────────────────────────────

test('worktree-deps-workspaces: readWorkspacePackages expands packages/* to name→path', () => {
  const root = mkTmp();
  try {
    writeFileSync(join(root, 'package.json'),
      JSON.stringify({ workspaces: ['packages/*'] }), 'utf8');
    mkdirSync(join(root, 'packages', 'core'), { recursive: true });
    writeFileSync(join(root, 'packages', 'core', 'package.json'),
      JSON.stringify({ name: '@loopkit/core' }), 'utf8');
    mkdirSync(join(root, 'packages', 'ui'), { recursive: true });
    writeFileSync(join(root, 'packages', 'ui', 'package.json'),
      JSON.stringify({ name: '@loopkit/ui' }), 'utf8');

    const map = readWorkspacePackages(root);
    assert.equal(map.get('@loopkit/core'), join('packages', 'core'));
    assert.equal(map.get('@loopkit/ui'), join('packages', 'ui'));
    assert.equal(map.size, 2);
  } finally { clean(root); }
});

test('worktree-deps-workspaces: readWorkspacePackages supports the object {packages:[...]} form', () => {
  const root = mkTmp();
  try {
    writeFileSync(join(root, 'package.json'),
      JSON.stringify({ workspaces: { packages: ['packages/*'] } }), 'utf8');
    mkdirSync(join(root, 'packages', 'core'), { recursive: true });
    writeFileSync(join(root, 'packages', 'core', 'package.json'),
      JSON.stringify({ name: '@loopkit/core' }), 'utf8');

    const map = readWorkspacePackages(root);
    assert.equal(map.get('@loopkit/core'), join('packages', 'core'));
  } finally { clean(root); }
});

test('worktree-deps-workspaces: readFileDeps recognises a workspace-name dep alongside file: specs', () => {
  const root = mkTmp();
  try {
    writeFileSync(join(root, 'package.json'),
      JSON.stringify({ workspaces: ['packages/*'] }), 'utf8');
    mkdirSync(join(root, 'packages', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'packages', 'pkg', 'package.json'),
      JSON.stringify({ name: '@fake/pkg' }), 'utf8');

    const dir = join(root, 'apps', 'example');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: {
        'left-pad': '^1.0.0',
        '@fake/pkg': '*',
        '@fake/filedep': 'file:../../packages/filedep',
      },
    }), 'utf8');

    const workspacePackages = readWorkspacePackages(root);
    const deps = readFileDeps(dir, root, workspacePackages);
    assert.deepEqual(
      deps.sort((a, b) => a.name.localeCompare(b.name)),
      [
        { name: '@fake/filedep', relPath: '../../packages/filedep' },
        { name: '@fake/pkg', relPath: join('..', '..', 'packages', 'pkg') },
      ],
    );
  } finally { clean(root); }
});

for (const spec of ['*', '^1.0.0', 'workspace:*']) {
  test(`worktree-deps-workspaces (a): workspace dep (spec "${spec}") overlay resolves into worktree`, () => {
    const root = mkTmp();
    try {
      const { repoRoot, wtPath, workdir } = makeLayout(root, { spec });
      const res = setupWorkdirDeps(repoRoot, wtPath, workdir);

      assert.equal(res.overlaid, true, 'overlay path taken for a workspace-name dep');
      assert.equal(res.fileDeps.length, 1);
      assert.equal(res.fileDeps[0].name, '@fake/pkg');

      const wtNm = join(wtPath, workdir, 'node_modules');

      assert.ok(lstatSync(wtNm).isDirectory(), 'wt node_modules is a real dir');
      assert.ok(!lstatSync(wtNm).isSymbolicLink(), 'wt node_modules is not a symlink');

      // the workspace dep entry resolves into the WORKTREE tree (the whole fix)
      const depReal = realpathSync(join(wtNm, '@fake', 'pkg'));
      assert.ok(
        depReal.startsWith(realpathSync(wtPath)),
        `workspace dep must resolve into worktree, got ${depReal}`,
      );

      // a plain entry still resolves into the MAIN tree
      const plainReal = realpathSync(join(wtNm, 'left-pad'));
      assert.ok(
        plainReal.startsWith(realpathSync(repoRoot)),
        `plain dep must resolve into main tree, got ${plainReal}`,
      );

      assert.ok(existsSync(join(wtNm, '.bin', 'tsc')), '.bin/tsc present via overlay');
      assert.ok(existsSync(join(wtNm, '@types', 'node', 'index.d.ts')), '@types sibling present');

      // the pkg build ran in the worktree copy
      assert.ok(existsSync(join(wtPath, 'packages', 'pkg', 'dist', 'out.js')),
        'workspace dep build must succeed in the worktree');

      // real require() through the overlay loads the WORKTREE (branch) source, not the stale one
      const script =
        `console.log(require(${JSON.stringify(join(wtNm, '@fake', 'pkg'))}));`;
      const out = spawnSync('node', ['-e', script], { encoding: 'utf8' });
      assert.equal(out.stdout.trim(), 'WT-BRANCH-NEW',
        `require() through overlay must load worktree source; got: ${out.stdout}${out.stderr}`);
    } finally { clean(root); }
  });
}

test('worktree-deps-workspaces (b): dep name not in workspaces map → cheap single-symlink path', () => {
  const root = mkTmp();
  try {
    const { repoRoot, wtPath, workdir } = makeLayout(root, { spec: '^2.0.0', unmatchedName: true });
    const res = setupWorkdirDeps(repoRoot, wtPath, workdir);

    assert.equal(res.overlaid, false, 'cheap path when the dep name matches no workspace package');
    assert.equal(res.fileDeps.length, 0);

    const wtNm = join(wtPath, workdir, 'node_modules');
    assert.ok(lstatSync(wtNm).isSymbolicLink(), 'wt node_modules is a symlink (cheap path)');
    assert.equal(
      realpathSync(wtNm),
      realpathSync(join(repoRoot, workdir, 'node_modules')),
      'symlink targets the main tree node_modules',
    );
  } finally { clean(root); }
});

test('worktree-deps-workspaces (c): file: dep behaviour unchanged when the repo also has workspaces', () => {
  const root = mkTmp();
  try {
    const { repoRoot, wtPath, workdir } = makeLayout(root, { spec: '*', alsoFileDep: true });
    const res = setupWorkdirDeps(repoRoot, wtPath, workdir);

    assert.equal(res.overlaid, true);
    const names = res.fileDeps.map((d) => d.name).sort();
    assert.deepEqual(names, ['@fake/filedep', '@fake/pkg']);

    const wtNm = join(wtPath, workdir, 'node_modules');

    const fileDepReal = realpathSync(join(wtNm, '@fake', 'filedep'));
    assert.ok(fileDepReal.startsWith(realpathSync(wtPath)), 'file: dep still resolves into worktree');

    const wsDepReal = realpathSync(join(wtNm, '@fake', 'pkg'));
    assert.ok(wsDepReal.startsWith(realpathSync(wtPath)), 'workspace dep resolves into worktree');

    const script =
      `console.log(require(${JSON.stringify(join(wtNm, '@fake', 'filedep'))}));`;
    const out = spawnSync('node', ['-e', script], { encoding: 'utf8' });
    assert.equal(out.stdout.trim(), 'WT-BRANCH-NEW-FILEDEP',
      `file: dep require() must load worktree source; got: ${out.stdout}${out.stderr}`);
  } finally { clean(root); }
});
