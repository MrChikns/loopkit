/**
 * beats/worktree-deps.ts — worktree node_modules setup for the beats.
 *
 * PROBLEM: a beat worktree gets each deps workdir's `node_modules` as ONE symlink to the
 * MAIN tree's `node_modules`. When a dependency is a local `file:` path (e.g.
 * `"@scope/ui-kit": "file:../../packages/ui-kit"`), the entry inside `node_modules` is
 * itself a symlink resolving RELATIVE to the main tree — so a worktree branch that changes
 * BOTH the local package and the app that consumes it compiles the app against the MAIN
 * tree's stale package copy ("no exported member …"). The gate then lies (false green/red).
 *
 * The same failure mode hits npm-workspaces repos (root `package.json` `workspaces: [...]`,
 * consuming packages depending on each other by NAME — e.g. `"@scope/ui-kit": "*"` or
 * `"workspace:*"` — never a `file:` spec). npm materialises those as symlinks into the
 * workspace source too, so they carry the exact same staleness risk; `file:`-only detection
 * simply never saw them.
 *
 * A THIRD shape hits when the deps workdir IS the workspaces root itself (a beat target
 * declaring `depsWorkdirs: ["."]`): a hoisted npm-workspaces root `package.json` typically
 * declares NO `dependencies` at all — the members are hoisted, not depended on by name — so
 * neither of the above ever finds anything and the cheap single-symlink path silently wins.
 * When the workdir IS the workspaces root, every workspace member is an IMPLICIT local dep
 * of the tree (that's the whole point of a workspace) even with zero declared dependencies.
 *
 * FIX (config-derived, no repo literals): when a deps workdir has any `file:` dependency,
 * OR a dependency whose name matches one of the repo's own workspace packages (read from
 * the root `package.json`'s `workspaces` globs), OR the workdir itself is the workspaces
 * root (in which case every workspace member counts, declared dependency or not), build a
 * REAL node_modules directory in the worktree that overlays the main tree's node_modules
 * (symlink every entry through) EXCEPT those local packages, which are symlinked to their
 * source RESOLVED RELATIVE TO THE WORKTREE. Each local package with a `build` script is then
 * built so its dist matches the branch source — root-workspace members build in the
 * `workspaces` array's own order (this repo's manifest is already dependency-ordered:
 * core, ui, opsui, console), never re-sorted.
 *
 * When a workdir has no local dependency of any kind, we keep the cheap single-symlink
 * behaviour.
 */

import { join, resolve, dirname, relative } from 'node:path';
import {
  existsSync, readFileSync, readdirSync, mkdirSync, symlinkSync, lstatSync,
} from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';

/** A local dependency discovered in a workdir's package.json (`file:` spec or workspace). */
interface FileDep {
  /** Bare package name, e.g. `@scope/ui-kit`. */
  name: string;
  /** Path to the package's source, relative to the workdir it was declared in. */
  relPath: string;
}

/**
 * Read a repo root's `package.json` `workspaces` field and return a map of workspace
 * package NAME → path relative to the repo root. Supports both the array form
 * (`"workspaces": ["packages/*"]`) and the object form (`"workspaces": {"packages": [...]}`).
 * Globs are expanded with a plain `readdirSync` (no glob dependency): a trailing `/*`
 * segment lists the parent dir's immediate children; anything else is used as a literal
 * path. Returns an empty map when the repo has no workspaces or the root package.json is
 * absent/unparseable.
 */
export function readWorkspacePackages(repoRootAbs: string): Map<string, string> {
  const map = new Map<string, string>();
  const pkgPath = join(repoRootAbs, 'package.json');
  if (!existsSync(pkgPath)) return map;
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return map;
  }
  const rawWorkspaces = pkg.workspaces;
  let globs: string[] = [];
  if (Array.isArray(rawWorkspaces)) {
    globs = rawWorkspaces.filter((g): g is string => typeof g === 'string');
  } else if (rawWorkspaces && typeof rawWorkspaces === 'object') {
    const packagesField = (rawWorkspaces as Record<string, unknown>).packages;
    if (Array.isArray(packagesField)) {
      globs = packagesField.filter((g): g is string => typeof g === 'string');
    }
  }

  const candidateRelPaths: string[] = [];
  for (const glob of globs) {
    if (glob.endsWith('/*')) {
      const parentRel = glob.slice(0, -2);
      const parentAbs = join(repoRootAbs, parentRel);
      let members: string[] = [];
      try { members = readdirSync(parentAbs); } catch { members = []; }
      for (const member of members) {
        candidateRelPaths.push(join(parentRel, member));
      }
    } else {
      candidateRelPaths.push(glob);
    }
  }

  for (const relPath of candidateRelPaths) {
    const memberPkgPath = join(repoRootAbs, relPath, 'package.json');
    if (!existsSync(memberPkgPath)) continue;
    try {
      const memberPkg = JSON.parse(readFileSync(memberPkgPath, 'utf8')) as Record<string, unknown>;
      if (typeof memberPkg.name === 'string' && memberPkg.name.length > 0) {
        map.set(memberPkg.name, relPath);
      }
    } catch { /* unparseable member — skip */ }
  }
  return map;
}

/**
 * Read a workdir's package.json and return its local dependencies: `file:`-spec deps, and
 * (when `rootAbs` + `workspacePackages` are given) any dep whose name matches a workspace
 * package — regardless of spec (`*`, a semver range, or `workspace:*`). Merges
 * `dependencies`, `devDependencies`, and `optionalDependencies`. Returns [] when the file is
 * absent or unparseable (caller keeps the cheap path).
 *
 * `rootAbs` must be the root of the SAME tree `workdirAbs` lives in (the worktree, at the
 * real call site) — `workspacePackages` values are paths relative to that root, and this
 * function re-expresses them relative to `workdirAbs` so they land in that tree, not the
 * tree the workspaces map happened to be read from.
 */
export function readFileDeps(
  workdirAbs: string,
  rootAbs?: string,
  workspacePackages?: Map<string, string>,
): FileDep[] {
  const pkgPath = join(workdirAbs, 'package.json');
  if (!existsSync(pkgPath)) return [];
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return [];
  }
  const out: FileDep[] = [];
  const seen = new Set<string>();
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const deps = pkg[field];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
      if (seen.has(name) || typeof spec !== 'string') continue;
      if (spec.startsWith('file:')) {
        out.push({ name, relPath: spec.slice('file:'.length) });
        seen.add(name);
        continue;
      }
      const wsRelToRoot = workspacePackages?.get(name);
      if (wsRelToRoot !== undefined && rootAbs) {
        const wsAbs = resolve(rootAbs, wsRelToRoot);
        out.push({ name, relPath: relative(workdirAbs, wsAbs) });
        seen.add(name);
      }
    }
  }
  return out;
}

/**
 * Every workspace member as an implicit local dep, in the SAME order `workspacePackages`
 * iterates (insertion order — the `workspaces` array's own order, never re-sorted). Used
 * when the deps workdir IS the workspaces root: hoisting means the root `package.json`
 * typically declares none of its members as an explicit dependency, yet every member is
 * still a local package the root tree resolves against.
 *
 * `workspacePackages` values are already relative to the workspaces root, and this is only
 * called when the workdir IS that root, so the paths need no re-expressing — they match the
 * `relPath`-relative-to-workdir contract `readFileDeps` returns for the other two cases as-is.
 */
function implicitRootWorkspaceDeps(workspacePackages: Map<string, string>): FileDep[] {
  const out: FileDep[] = [];
  for (const [name, relPath] of workspacePackages) out.push({ name, relPath });
  return out;
}

/**
 * Symlink one entry of the main tree's node_modules into the worktree overlay.
 * For scoped dirs (`@scope`) we recurse one level so individual scoped packages can be
 * overridden by a `file:` dep while their siblings still point at the main tree.
 */
function overlayEntry(
  entryName: string,
  mainNmAbs: string,
  wtNmAbs: string,
  overriddenScopes: Set<string>,
): void {
  const src = join(mainNmAbs, entryName);
  const dest = join(wtNmAbs, entryName);
  // Scoped directory (`@types`, `@scope`, …): if any file: dep overrides a package
  // inside this scope, materialise the scope dir and link its members individually so
  // the override can replace just that one. Otherwise a single symlink is enough.
  if (entryName.startsWith('@') && overriddenScopes.has(entryName)) {
    mkdirSync(dest, { recursive: true });
    let members: string[] = [];
    try { members = readdirSync(src); } catch { members = []; }
    for (const member of members) {
      const memberDest = join(dest, member);
      if (existsSync(memberDest)) continue; // a file: override already placed it
      symlinkSync(join(src, member), memberDest);
    }
    return;
  }
  symlinkSync(src, dest);
}

/**
 * Ensure a worktree deps workdir has a node_modules that resolves local deps (`file:` specs
 * AND same-repo workspace packages) to the WORKTREE's copy while every other entry resolves
 * to the main tree.
 *
 * - No local deps of either kind → single symlink (cheap), matching prior behaviour. Returns [].
 * - Some local deps → real overlay dir. Returns the list of built local packages
 *   (absolute workdir paths) so the caller can log/verify.
 */
export function setupWorkdirDeps(
  repoRoot: string,
  wtPath: string,
  workdirRel: string,
): { overlaid: boolean; fileDeps: FileDep[]; built: string[]; buildFailures: string[] } {
  const mainNmAbs = join(repoRoot, workdirRel, 'node_modules');
  const wtWorkdirAbs = join(wtPath, workdirRel);
  const wtNmAbs = join(wtWorkdirAbs, 'node_modules');

  // The worktree carries its own root package.json (git worktrees are full checkouts), so
  // workspace globs are read from wtPath — the same tree readFileDeps resolves relPath into.
  const workspacePackages = readWorkspacePackages(wtPath);
  const explicitDeps = readFileDeps(wtWorkdirAbs, wtPath, workspacePackages);

  // When the deps workdir IS the workspaces root, every member is an implicit local dep —
  // a hoisted root package.json normally declares NONE of them as an explicit dependency
  // (see module header), so explicit-dependency detection alone never fires here.
  // Union in workspaces-array order (implicit members first, so a dependency-ordered
  // `workspaces` array builds core→ui→opsui→console before any explicit extra), then any
  // explicit deps not already covered — deduped by name either way.
  const isWorkspacesRoot = workspacePackages.size > 0 && resolve(wtWorkdirAbs) === resolve(wtPath);
  let fileDeps = explicitDeps;
  if (isWorkspacesRoot) {
    const seen = new Set<string>();
    fileDeps = [];
    for (const dep of implicitRootWorkspaceDeps(workspacePackages)) {
      if (seen.has(dep.name)) continue;
      fileDeps.push(dep);
      seen.add(dep.name);
    }
    for (const dep of explicitDeps) {
      if (seen.has(dep.name)) continue;
      fileDeps.push(dep);
      seen.add(dep.name);
    }
  }

  if (fileDeps.length === 0) {
    // Cheap path: single symlink to the main tree's node_modules — but only when the main
    // tree actually HAS one. An unconditional link plants a dangling symlink when deps were
    // never installed (fresh fork, repo-root workdir), which both breaks resolution and
    // blocks the worktree from creating its own node_modules (mkdir through a dead link
    // ENOENTs even with recursive:true).
    if (existsSync(mainNmAbs)) {
      spawnSync('ln', ['-sfn', mainNmAbs, wtNmAbs], { stdio: 'pipe' });
    }
    return { overlaid: false, fileDeps: [], built: [], buildFailures: [] };
  }

  // Overlay path. Remove any stale link/dir the git worktree carried in, then build a
  // real directory that overlays the main tree's node_modules.
  spawnSync('rm', ['-rf', wtNmAbs], { stdio: 'pipe' });
  mkdirSync(wtNmAbs, { recursive: true });

  // Scopes that host at least one file: override — their dirs must be materialised.
  const overriddenScopes = new Set<string>();
  for (const dep of fileDeps) {
    if (dep.name.startsWith('@')) overriddenScopes.add(dep.name.split('/')[0]);
  }

  // Link every entry of the main tree's node_modules (incl. `.bin` and scope dirs).
  let mainEntries: string[] = [];
  try { mainEntries = existsSync(mainNmAbs) ? readdirSync(mainNmAbs) : []; } catch { mainEntries = []; }
  for (const entry of mainEntries) {
    try { overlayEntry(entry, mainNmAbs, wtNmAbs, overriddenScopes); } catch { /* ignore */ }
  }

  // Point each file: dep at the WORKTREE's copy of the package (resolved relative to the
  // worktree workdir, NOT the main tree). This is the whole fix.
  const built: string[] = [];
  const buildFailures: string[] = [];
  for (const dep of fileDeps) {
    const wtPkgDir = resolve(wtWorkdirAbs, dep.relPath);
    const dest = join(wtNmAbs, dep.name);
    try {
      mkdirSync(dirname(dest), { recursive: true }); // ensure @scope dir exists
      // Replace any main-tree symlink that overlayEntry may have placed for this member.
      if (existsSync(dest) || isSymlink(dest)) {
        spawnSync('rm', ['-rf', dest], { stdio: 'pipe' });
      }
      symlinkSync(wtPkgDir, dest);
    } catch { /* ignore */ }

    // Build the local package so its dist matches the branch source (skip if no build).
    // The package's OWN node_modules (its tsc etc.) never exists in a fresh worktree and its
    // dist is typically gitignored — without linking those deps first the build fails
    // silently and the consuming app's gate reds with "Cannot find module".
    if (hasBuildScript(wtPkgDir)) {
      const mainPkgDir = resolve(join(repoRoot, workdirRel), dep.relPath);
      const mainPkgNm = join(mainPkgDir, 'node_modules');
      const wtPkgNm = join(wtPkgDir, 'node_modules');
      if (existsSync(mainPkgNm) && !existsSync(wtPkgNm)) {
        spawnSync('ln', ['-sfn', mainPkgNm, wtPkgNm], { stdio: 'pipe' });
      }
      const buildResult = spawnSync('npm', ['run', 'build', '--prefix', wtPkgDir], { stdio: 'pipe' });
      if (buildResult.status !== 0) {
        // Surface BOTH streams so the caller can embed the real cause in a gate.failed
        // reason: tsc (and many build tools) write compile errors to STDOUT, not stderr —
        // a stderr-only tail silently hid the actual error, rendering an empty-looking
        // failure reason.
        const tail = formatFailureTail(buildResult.stdout, buildResult.stderr);
        process.stderr.write(`[worktree-deps] build failed for ${dep.name}: ${tail}\n`);
        buildFailures.push(`${dep.name}: ${tail}`);
      }
      built.push(wtPkgDir);
    }
  }

  return { overlaid: true, fileDeps, built, buildFailures };
}

/** Per-stream cap (chars) on a failure tail — keeps the reason readable, not a log dump. */
const FAILURE_TAIL_CAP = 600;

/**
 * Build a labeled failure tail from a spawn result's stdout+stderr, for embedding in a
 * gate.failed / buildFailures reason.
 *
 * tsc (and many build tools) write compile errors to STDOUT, not stderr — a stderr-only tail
 * silently hid the real cause, rendering an empty-looking failure reason (e.g.
 * `@scope/core: ;`) even on a genuine park. Both streams are captured here, each capped to the
 * TAIL END (not head — the actionable error is usually last) at `FAILURE_TAIL_CAP` chars, and
 * labeled so the reader knows which stream each excerpt came from. An empty stream's label is
 * omitted entirely rather than printed as `stdout: `.
 */
export function formatFailureTail(
  stdout: Buffer | string | null | undefined,
  stderr: Buffer | string | null | undefined,
): string {
  const out = (stdout?.toString() ?? '').trim().slice(-FAILURE_TAIL_CAP);
  const err = (stderr?.toString() ?? '').trim().slice(-FAILURE_TAIL_CAP);
  const parts: string[] = [];
  if (out.length > 0) parts.push(`stdout: ${out}`);
  if (err.length > 0) parts.push(`stderr: ${err}`);
  return parts.join(' ');
}

/** True if `p` is a symlink (even a broken one). */
function isSymlink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** True if the package at `pkgDir` has a `build` script. */
function hasBuildScript(pkgDir: string): boolean {
  const pkgPath = join(pkgDir, 'package.json');
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
    return Boolean(pkg.scripts && typeof pkg.scripts.build === 'string');
  } catch {
    return false;
  }
}

/**
 * Set up node_modules for every deps workdir of a beat worktree.
 * Called by both dispatch.ts and reactor.ts (the logic lives here ONCE).
 *
 * Returns build failures so callers can park items when a file:-dep build exits non-zero
 * instead of continuing the gate against a stale dist.
 */
export function setupWorktreeDeps(
  repoRoot: string,
  wtPath: string,
  depsWorkdirs: string[],
): { buildFailures: string[] } {
  const buildFailures: string[] = [];
  for (const dw of depsWorkdirs) {
    try {
      const result = setupWorkdirDeps(repoRoot, wtPath, dw);
      buildFailures.push(...result.buildFailures);
    } catch { /* ignore — a broken link here surfaces as a gate failure, not a crash */ }
  }
  return { buildFailures };
}

/**
 * Fire the configured deploy command DETACHED after a successful merge.
 * The command must be self-locking; failures surface via the deploy-age SLO probe,
 * never by blocking the beat.
 *
 * wiIds: item ids (WI-NNN format) of the items whose merges triggered this deploy — passed
 * as DEPLOY_WI_IDS (space-separated) so the script can append deploy.succeeded /
 * deploy.failed events on the correct items.
 */
export function fireDeployOnMerge(repoRoot: string, deployCommand: string, wiIds: string[]): void {
  if (!deployCommand) return;
  try {
    const child = spawn('sh', ['-c', deployCommand], {
      cwd: repoRoot,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, DEPLOY_WI_IDS: wiIds.join(' ') },
    });
    child.unref();
  } catch { /* SLO probe catches a stale deploy */ }
}
