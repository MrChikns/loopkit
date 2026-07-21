/**
 * package.test.ts — standalone-package boundary guarantees.
 *
 * Guards the properties that let this package be consumed (or moved to its own repo)
 * unchanged:
 *  1. The public barrel (src/index.ts) re-exports the framework API — one import point.
 *  2. `Sensitivity` resolves through the barrel despite the schema/registry name clash.
 *  3. package.json declares a library shape (main/types/exports/bin) pointing at built files.
 *  4. The project-specific worktree prefix is config-injected, not a source literal.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as loopkit from '../src/index.js';
import type { Sensitivity } from '../src/index.js';
import { CONFIG_DEFAULTS } from '../src/config.js';

const here = dirname(fileURLToPath(import.meta.url));
// test compiles to dist-test/test/ → repo root is two up
const pkgRoot = join(here, '..', '..');

test('barrel re-exports the public framework API', () => {
  // Kernel
  assert.equal(typeof loopkit.fold, 'function');
  assert.equal(typeof loopkit.appendEvents, 'function');
  assert.equal(typeof loopkit.loadAllEvents, 'function');
  assert.equal(typeof loopkit.makeEvent, 'function');
  assert.equal(typeof loopkit.validateEvent, 'function');
  // Projections
  assert.equal(typeof loopkit.renderBoard, 'function');
  assert.equal(typeof loopkit.runDoctor, 'function');
  assert.equal(typeof loopkit.evaluateSloBoard, 'function');
  assert.equal(typeof loopkit.foldCosts, 'function');
  // Config + beats + providers
  assert.equal(typeof loopkit.loadConfig, 'function');
  assert.equal(typeof loopkit.runReactor, 'function');
  assert.equal(typeof loopkit.runDispatch, 'function');
  assert.equal(typeof loopkit.makeRegistry, 'function');
});

test('cli is NOT re-exported through the barrel (side-effecting bin)', () => {
  // The executable is reachable via the loopkit/cli subpath, never the library root.
  assert.equal((loopkit as Record<string, unknown>)['main'], undefined);
});

test('Sensitivity resolves through the barrel despite the schema/registry clash', () => {
  const s: Sensitivity = 'private';
  assert.equal(s, 'private');
});

test('worktree + app-dep paths are config-injected, not hardcoded project names', () => {
  assert.equal(CONFIG_DEFAULTS.worktreePrefix, 'loop-');
  // Framework defaults are repo-root generic; a target names its own app dir
  // (appWorkdir) and gate dir (gateWorkdir) in loopkit.config.json.
  assert.equal(CONFIG_DEFAULTS.appWorkdir, '.');
  assert.equal(CONFIG_DEFAULTS.gateWorkdir, '.');
});

test('package.json declares a library shape pointing at built artifacts', () => {
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@loopkit/core');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, './dist/index.js');
  assert.equal(pkg.types, './dist/index.d.ts');
  assert.equal(pkg.exports['.'].default, './dist/index.js');
  assert.equal(pkg.exports['./cli'], './dist/cli.js');
  assert.equal(pkg.bin.loopctl, './dist/cli.js');
});
