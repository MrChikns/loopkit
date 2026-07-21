import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

test('the anti-drift lint gate passes on the current tree', () => {
  const res = spawnSync('node', [resolve(root, 'scripts/lint-raw-colors.mjs')], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr || res.stdout);
});

test('component stylesheet contains no raw hex colours', async () => {
  const css = await readFile(resolve(root, 'src/styles/components.css'), 'utf8');
  const withoutVars = css.replace(/var\([^)]*\)/g, '');
  assert.doesNotMatch(withoutVars, /#[0-9a-fA-F]{3,8}\b/);
});
