import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const shellPath = resolve(here, '../../public/console-shell.js');

test('Cmd/Ctrl+K cannot open the dormant palette without a rendered trigger', async () => {
  const js = await readFile(shellPath, 'utf8');
  assert.match(
    js,
    /if \(mod && key === 'k' && paletteTrigger\(\)\) \{\s*event\.preventDefault\(\);\s*openPalette\(\);/,
  );
  assert.match(
    js,
    /function paletteTrigger\(\) \{\s*return document\.querySelector\('\[data-opsui-shell="palette-open"\]'\);\s*\}/,
  );
});
