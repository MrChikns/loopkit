/**
 * worktree-deps.test.ts — package-link overlay for build worktrees.
 *
 * Verifies the fix for a false-red class: a beat worktree that changes both a local `file:`
 * package AND the app must gate against the WORKTREE's package copy, not the stale main
 * tree's. We build a fake repo+worktree layout on disk (tmpdir) and drive the shared helper
 * `setupWorkdirDeps` directly.
 *
 * Cases:
 *   (a) file:-dep present  → real node_modules overlay; file: entry resolves into the
 *       WORKTREE, a plain entry resolves into the MAIN tree, `.bin` and scope siblings
 *       are present, and a require() of the file: dep loads the WORKTREE source.
 *   (b) no file: deps      → single symlink to the main tree's node_modules (cheap path).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, rmSync, writeFileSync, symlinkSync, existsSync, lstatSync, realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { setupWorkdirDeps, readFileDeps } from '../src/beats/worktree-deps.js';

let n = 0;
function mkTmp(): string {
  const d = join(tmpdir(), `wtdeps-${process.pid}-${++n}-${Date.now()}`);
  mkdirSync(d, { recursive: true });
  return d;
}
function clean(d: string): void {
  try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Build a fake main tree at <root>/repo and a fake worktree at <root>/wt.
 * The app workdir is `apps/example`; it depends on `@fake/pkg` at `file:../../packages/pkg`.
 * Layout mirrors a typical scoped-package workspace shape (scoped file: dep two levels up).
 */
function makeLayout(root: string, opts: { fileDep: boolean }): {
  repoRoot: string; wtPath: string; workdir: string;
} {
  const repoRoot = join(root, 'repo');
  const wtPath = join(root, 'wt');
  const workdir = 'apps/example';

  const appDeps: Record<string, string> = { 'left-pad': '^1.0.0' };
  if (opts.fileDep) appDeps['@fake/pkg'] = 'file:../../packages/pkg';

  // ── main tree ──────────────────────────────────────────────────────────────
  const mainApp = join(repoRoot, workdir);
  mkdirSync(mainApp, { recursive: true });
  writeFileSync(join(mainApp, 'package.json'),
    JSON.stringify({ name: 'app', dependencies: appDeps }), 'utf8');

  // main tree node_modules: a plain dep, a scoped @types dir, a .bin dir, and — when the
  // app has the file: dep — a symlink entry pointing back into the main tree's package.
  const mainNm = join(mainApp, 'node_modules');
  mkdirSync(join(mainNm, 'left-pad'), { recursive: true });
  writeFileSync(join(mainNm, 'left-pad', 'index.js'), 'module.exports = "main-leftpad";', 'utf8');
  mkdirSync(join(mainNm, '.bin'), { recursive: true });
  writeFileSync(join(mainNm, '.bin', 'tsc'), '#!/bin/sh\necho tsc', 'utf8');
  mkdirSync(join(mainNm, '@types', 'node'), { recursive: true });
  writeFileSync(join(mainNm, '@types', 'node', 'index.d.ts'), '// types', 'utf8');

  // the local package — MAIN tree version exports STALE. Its build script needs its OWN
  // node_modules (like tsc in the real package) — only the main tree has them installed.
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

  if (opts.fileDep) {
    // main tree node_modules/@fake/pkg → symlink back into main tree (npm's file: shape)
    mkdirSync(join(mainNm, '@fake'), { recursive: true });
    symlinkSync(mainPkg, join(mainNm, '@fake', 'pkg'));
  }

  // ── worktree ────────────────────────────────────────────────────────────────
  const wtApp = join(wtPath, workdir);
  mkdirSync(wtApp, { recursive: true });
  writeFileSync(join(wtApp, 'package.json'),
    JSON.stringify({ name: 'app', dependencies: appDeps }), 'utf8');

  // the local package — WORKTREE (branch) version exports NEW
  const wtPkg = join(wtPath, 'packages', 'pkg');
  mkdirSync(wtPkg, { recursive: true });
  writeFileSync(join(wtPkg, 'package.json'),
    JSON.stringify({ name: '@fake/pkg', main: 'index.js', scripts: { build: pkgBuild } }), 'utf8');
  writeFileSync(join(wtPkg, 'index.js'), 'module.exports = "WT-BRANCH-NEW";', 'utf8');
  // NOTE: no node_modules and no dist in the worktree copy — exactly the fresh-checkout state.

  return { repoRoot, wtPath, workdir };
}

// ─────────────────────────────────────────────────────────────────────────────

test('worktree-deps: readFileDeps extracts only file: specs', () => {
  const root = mkTmp();
  try {
    const dir = join(root, 'app');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { 'left-pad': '^1.0.0', '@fake/pkg': 'file:../../packages/pkg' },
      devDependencies: { 'tap': '^1.0.0', '@fake/dev': 'file:../dev' },
    }), 'utf8');
    const deps = readFileDeps(dir);
    assert.deepEqual(
      deps.sort((a, b) => a.name.localeCompare(b.name)),
      [
        { name: '@fake/dev', relPath: '../dev' },
        { name: '@fake/pkg', relPath: '../../packages/pkg' },
      ],
    );
  } finally { clean(root); }
});

test('worktree-deps (a): file: dep overlay — resolves into worktree, others into main tree', () => {
  const root = mkTmp();
  try {
    const { repoRoot, wtPath, workdir } = makeLayout(root, { fileDep: true });
    const res = setupWorkdirDeps(repoRoot, wtPath, workdir);

    assert.equal(res.overlaid, true, 'overlay path taken when a file: dep is present');
    assert.equal(res.fileDeps.length, 1);
    assert.equal(res.fileDeps[0].name, '@fake/pkg');

    const wtNm = join(wtPath, workdir, 'node_modules');

    // node_modules is a REAL directory, not a symlink
    assert.ok(lstatSync(wtNm).isDirectory(), 'wt node_modules is a real dir');
    assert.ok(!lstatSync(wtNm).isSymbolicLink(), 'wt node_modules is not a symlink');

    // the file: dep entry resolves into the WORKTREE tree (the whole fix)
    const fileDepReal = realpathSync(join(wtNm, '@fake', 'pkg'));
    assert.ok(
      fileDepReal.startsWith(realpathSync(wtPath)),
      `file: dep must resolve into worktree, got ${fileDepReal}`,
    );

    // a plain entry still resolves into the MAIN tree
    const plainReal = realpathSync(join(wtNm, 'left-pad'));
    assert.ok(
      plainReal.startsWith(realpathSync(repoRoot)),
      `plain dep must resolve into main tree, got ${plainReal}`,
    );

    // .bin is present (resolves into main tree)
    assert.ok(existsSync(join(wtNm, '.bin', 'tsc')), '.bin/tsc present via overlay');

    // scope sibling (@types/node) still present alongside the overridden @fake scope
    assert.ok(existsSync(join(wtNm, '@types', 'node', 'index.d.ts')), '@types sibling present');

    // the pkg build ran in the worktree copy — its node_modules were linked from the main
    // tree first (regression class: no pkg deps -> silent build fail -> no dist).
    assert.ok(existsSync(join(wtPath, 'packages', 'pkg', 'dist', 'out.js')),
      'file: dep build must succeed in the worktree (pkg node_modules linked)');
    assert.ok(lstatSync(join(wtPath, 'packages', 'pkg', 'node_modules')).isSymbolicLink(),
      'worktree pkg node_modules is a symlink to the main tree install');

    // real require() through the overlay loads the WORKTREE (branch) source, not the stale one
    const script =
      `console.log(require(${JSON.stringify(join(wtNm, '@fake', 'pkg'))}));`;
    const out = spawnSync('node', ['-e', script], { encoding: 'utf8' });
    assert.equal(out.stdout.trim(), 'WT-BRANCH-NEW',
      `require() through overlay must load worktree source; got: ${out.stdout}${out.stderr}`);
  } finally { clean(root); }
});

test('worktree-deps (b): no file: deps → single symlink (cheap path)', () => {
  const root = mkTmp();
  try {
    const { repoRoot, wtPath, workdir } = makeLayout(root, { fileDep: false });
    const res = setupWorkdirDeps(repoRoot, wtPath, workdir);

    assert.equal(res.overlaid, false, 'cheap path when no file: dep');
    assert.equal(res.fileDeps.length, 0);

    const wtNm = join(wtPath, workdir, 'node_modules');
    // node_modules is a single SYMLINK to the main tree's node_modules
    assert.ok(lstatSync(wtNm).isSymbolicLink(), 'wt node_modules is a symlink (cheap path)');
    assert.equal(
      realpathSync(wtNm),
      realpathSync(join(repoRoot, workdir, 'node_modules')),
      'symlink targets the main tree node_modules',
    );
  } finally { clean(root); }
});
