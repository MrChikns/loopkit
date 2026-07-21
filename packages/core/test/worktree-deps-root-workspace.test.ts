/**
 * worktree-deps-root-workspace.test.ts — implicit local deps when the deps workdir IS the
 * workspaces root (`depsWorkdirs: ["."]`).
 *
 * Follow-up to worktree-deps-workspaces.test.ts (WI-077), which taught readFileDeps to
 * recognise a workspace-name DEPENDENCY declared in a workdir's package.json. WI-078 closes
 * the remaining gap: a hoisted npm-workspaces root `package.json` normally declares NO
 * `dependencies` at all (members are hoisted, not depended on by name), so when the deps
 * workdir IS the workspaces root itself, neither the file: nor the workspace-name-dependency
 * detection ever finds anything — the cheap single-symlink path silently wins and a
 * cross-package worktree change (e.g. core export + console consumer) gates against the MAIN
 * tree's stale package copy even though the branch's own worktree has the fix.
 *
 * Cases:
 *   (a) root workdir ('.'), hoisted repo, ZERO root dependencies → every workspace member is
 *       treated as an implicit local dep: real overlay, each member resolves into the
 *       WORKTREE, members build in the workspaces-ARRAY order (not sorted), and a downstream
 *       member's build sees an upstream member's WORKTREE dist (the actual cross-package bug).
 *   (b) non-root workdir behaviour is unchanged (regression pin: still driven by explicit
 *       file:/workspace-name dependencies only, no implicit blanket overlay).
 *   (c) a repo with no `workspaces` field at all (plain file:-only repo) keeps the exact
 *       prior root-workdir behaviour — cheap path when the root package.json has no local
 *       file: deps (regression pin: isWorkspacesRoot must require an actual workspaces map).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, rmSync, writeFileSync, existsSync, lstatSync, realpathSync, readFileSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { setupWorkdirDeps } from '../src/beats/worktree-deps.js';

let n = 0;
function mkTmp(): string {
  const d = join(tmpdir(), `wtdeps-rootws-${process.pid}-${++n}-${Date.now()}`);
  mkdirSync(d, { recursive: true });
  return d;
}
function clean(d: string): void {
  try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Build a fake hoisted npm-workspaces repo at <root>/repo (main tree) and <root>/wt
 * (worktree). Root `package.json` declares `workspaces: ["packages/*"]` and — matching a
 * REAL hoisted repo — NO `dependencies` field at all. Three members in `workspaces`-array
 * order matching this repo's own dependency order: `@fake/core` (no local deps, has a build
 * script), `@fake/ui` (depends on `@fake/core` by name — the cross-package case), and
 * `@fake/console` (depends on both). Each member's MAIN-tree copy exports STALE; the
 * WORKTREE copy exports NEW so a require() through the overlay proves which tree resolved.
 */
function makeRootLayout(root: string): { repoRoot: string; wtPath: string } {
  const repoRoot = join(root, 'repo');
  const wtPath = join(root, 'wt');

  const members = ['core', 'ui', 'console'] as const;

  for (const treeRoot of [repoRoot, wtPath]) {
    mkdirSync(treeRoot, { recursive: true });
    // NO dependencies field — the hoisted-repo shape the bug report describes. Explicit
    // per-package paths (not a `packages/*` glob) matching this repo's own root manifest
    // shape — the array's declaration order is what must survive into the build order.
    writeFileSync(join(treeRoot, 'package.json'),
      JSON.stringify({
        name: 'fake-monorepo',
        private: true,
        workspaces: members.map((m) => `packages/${m}`),
      }), 'utf8');
  }

  // root node_modules (hoisted): a plain third-party dep + each member symlinked by npm.
  const mainNm = join(repoRoot, 'node_modules');
  mkdirSync(join(mainNm, 'left-pad'), { recursive: true });
  writeFileSync(join(mainNm, 'left-pad', 'index.js'), 'module.exports = "main-leftpad";', 'utf8');
  mkdirSync(join(mainNm, '.bin'), { recursive: true });
  writeFileSync(join(mainNm, '.bin', 'tsc'), '#!/bin/sh\necho tsc', 'utf8');

  for (const name of members) {
    const isCore = name === 'core';
    const isUi = name === 'ui';
    const pkgName = `@fake/${name}`;
    // ui/console build by running a build.js file (in their own package dir) that READS
    // the (already-built) @fake/core dist, so we can prove which core copy — main-tree
    // stale or worktree new — a downstream member's build resolved against. A real .js
    // file avoids fragile inline `node -e` quoting.
    // Every member builds via its own build.js — core's just stamps a marker (proving it
    // ran against ITS OWN tree's source, since index.js differs main-vs-worktree); ui's and
    // console's READ the already-built @fake/core dist so we can prove which core copy — a
    // downstream member's build resolved against. Real .js files avoid fragile `node -e`
    // quoting.
    const pkgBuild = 'node ./build.js';
    const deps: Record<string, string> = {};
    if (isUi) deps['@fake/core'] = '*';
    if (name === 'console') { deps['@fake/core'] = '*'; deps['@fake/ui'] = '*'; }

    const coreBuildJs =
      "const fs = require('node:fs');\n" +
      "const self = require('./index.js');\n" +
      "fs.mkdirSync('dist', { recursive: true });\n" +
      "fs.writeFileSync('dist/out.js', 'module.exports = \"built:' + self + '\";');\n";
    const downstreamBuildJs =
      "const fs = require('node:fs');\n" +
      "const core = require('@fake/core');\n" +
      "fs.mkdirSync('dist', { recursive: true });\n" +
      "fs.writeFileSync('dist/out.js', 'module.exports = \"built-with:' + core + '\";');\n";

    // main tree member — exports/reads STALE
    const mainPkg = join(repoRoot, 'packages', name);
    mkdirSync(mainPkg, { recursive: true });
    writeFileSync(join(mainPkg, 'package.json'),
      JSON.stringify({ name: pkgName, main: 'index.js', dependencies: deps, scripts: { build: pkgBuild } }),
      'utf8');
    writeFileSync(join(mainPkg, 'index.js'), `module.exports = "MAIN-STALE-${name.toUpperCase()}";`, 'utf8');
    writeFileSync(join(mainPkg, 'build.js'), isCore ? coreBuildJs : downstreamBuildJs, 'utf8');
    // npm's hoisted shape: root node_modules/@fake/<name> symlinks into packages/<name>.
    mkdirSync(join(mainNm, '@fake'), { recursive: true });
    symlinkSync(mainPkg, join(mainNm, '@fake', name));

    // worktree member — exports/reads NEW (the branch under test). No node_modules/dist:
    // fresh-checkout state.
    const wtPkg = join(wtPath, 'packages', name);
    mkdirSync(wtPkg, { recursive: true });
    writeFileSync(join(wtPkg, 'package.json'),
      JSON.stringify({ name: pkgName, main: 'index.js', dependencies: deps, scripts: { build: pkgBuild } }),
      'utf8');
    writeFileSync(join(wtPkg, 'index.js'), `module.exports = "WT-BRANCH-NEW-${name.toUpperCase()}";`, 'utf8');
    writeFileSync(join(wtPkg, 'build.js'), isCore ? coreBuildJs : downstreamBuildJs, 'utf8');
  }

  return { repoRoot, wtPath };
}

// ─────────────────────────────────────────────────────────────────────────────

test('worktree-deps-root-workspace (a): root workdir with zero declared deps overlays every member', () => {
  const root = mkTmp();
  try {
    const { repoRoot, wtPath } = makeRootLayout(root);
    const res = setupWorkdirDeps(repoRoot, wtPath, '.');

    assert.equal(res.overlaid, true, 'root workdir must overlay even with zero declared dependencies');
    const names = res.fileDeps.map((d) => d.name);
    assert.deepEqual(names, ['@fake/core', '@fake/ui', '@fake/console'],
      'implicit deps must appear in workspaces-ARRAY order, not sorted');

    const wtNm = join(wtPath, 'node_modules');
    assert.ok(lstatSync(wtNm).isDirectory(), 'root wt node_modules is a real dir');
    assert.ok(!lstatSync(wtNm).isSymbolicLink());

    for (const name of ['core', 'ui', 'console']) {
      const memberReal = realpathSync(join(wtNm, '@fake', name));
      assert.ok(memberReal.startsWith(realpathSync(wtPath)),
        `${name} must resolve into the worktree, got ${memberReal}`);
    }

    // plain hoisted dep still resolves into the main tree
    const plainReal = realpathSync(join(wtNm, 'left-pad'));
    assert.ok(plainReal.startsWith(realpathSync(repoRoot)), 'plain dep must resolve into main tree');
    assert.ok(existsSync(join(wtNm, '.bin', 'tsc')), '.bin/tsc present via overlay');

    // build order proof: core built BEFORE ui/console (workspaces-array order), and each
    // downstream member's build read the WORKTREE core dist, not the main tree's stale one —
    // this is the actual cross-package regression the live target hit.
    assert.equal(res.buildFailures.length, 0, `no build failures expected: ${res.buildFailures.join('; ')}`);
    const coreDist = readFileSync(join(wtPath, 'packages', 'core', 'dist', 'out.js'), 'utf8');
    assert.match(coreDist, /WT-BRANCH-NEW-CORE/, 'core built its own worktree dist');

    const uiOut = readFileSync(join(wtPath, 'packages', 'ui', 'dist', 'out.js'), 'utf8');
    assert.match(uiOut, /WT-BRANCH-NEW-CORE/,
      `ui's build must have resolved @fake/core to the WORKTREE (branch-new) copy, got: ${uiOut}`);

    const consoleOut = readFileSync(join(wtPath, 'packages', 'console', 'dist', 'out.js'), 'utf8');
    assert.match(consoleOut, /WT-BRANCH-NEW-CORE/,
      `console's build must have resolved @fake/core to the WORKTREE copy, got: ${consoleOut}`);
  } finally { clean(root); }
});

test('worktree-deps-root-workspace (b): non-root workdir keeps explicit-dependency-only behaviour', () => {
  const root = mkTmp();
  try {
    const { repoRoot, wtPath } = makeRootLayout(root);

    // A non-root deps workdir with NO package.json of its own (e.g. a bare apps/ dir some
    // configs might list) must still take the cheap path — implicit-root treatment must not
    // leak to an arbitrary subdirectory just because the repo has workspaces configured.
    mkdirSync(join(repoRoot, 'apps', 'bare'), { recursive: true });
    mkdirSync(join(wtPath, 'apps', 'bare'), { recursive: true });

    const res = setupWorkdirDeps(repoRoot, wtPath, 'apps/bare');
    assert.equal(res.overlaid, false, 'a non-root workdir with no local deps keeps the cheap path');
    assert.equal(res.fileDeps.length, 0);

    const wtNm = join(wtPath, 'apps', 'bare', 'node_modules');
    // no main-tree node_modules exists at apps/bare, so no symlink is planted either —
    // just confirm no overlay directory was created.
    assert.ok(!existsSync(wtNm) || lstatSync(wtNm).isSymbolicLink(),
      'no real overlay directory for an unrelated non-root workdir');
  } finally { clean(root); }
});

test('worktree-deps-root-workspace (c): a plain (non-workspaces) repo root keeps prior cheap-path behaviour', () => {
  const root = mkTmp();
  try {
    const repoRoot = join(root, 'repo');
    const wtPath = join(root, 'wt');

    // Root package.json with NO workspaces field at all.
    for (const treeRoot of [repoRoot, wtPath]) {
      mkdirSync(treeRoot, { recursive: true });
      writeFileSync(join(treeRoot, 'package.json'), JSON.stringify({ name: 'plain-repo' }), 'utf8');
    }
    const mainNm = join(repoRoot, 'node_modules');
    mkdirSync(join(mainNm, 'left-pad'), { recursive: true });
    writeFileSync(join(mainNm, 'left-pad', 'index.js'), 'module.exports = "main-leftpad";', 'utf8');

    const res = setupWorkdirDeps(repoRoot, wtPath, '.');
    assert.equal(res.overlaid, false, 'no workspaces field → root workdir still takes the cheap path');
    assert.equal(res.fileDeps.length, 0);

    const wtNm = join(wtPath, 'node_modules');
    assert.ok(lstatSync(wtNm).isSymbolicLink(), 'root wt node_modules is a symlink (cheap path)');
    assert.equal(realpathSync(wtNm), realpathSync(mainNm));
  } finally { clean(root); }
});
