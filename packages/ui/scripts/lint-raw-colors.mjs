#!/usr/bin/env node
// Anti-drift gate. Raw colour values may live ONLY in the authored token source.
// Everything else — component TS and CSS — must reference token variables.
//
// Exits non-zero on a violation so CI / the pre-push gate can block it.

import { readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

// The one home for raw colour values: the typed token source.
const ALLOW = new Set(['src/tokens/foundation.ts', 'src/tokens/semantic.ts']);

const COLOR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;

async function walk(dir, exts) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out; // directory absent — skip, don't crash.
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, exts)));
    else if (exts.test(entry.name)) out.push(full);
  }
  return out;
}

const violations = [];

// Scan the typed source for raw colours outside the token source.
const colourFiles = await walk(resolve(root, 'src'), /\.(ts|css)$/);
for (const file of colourFiles) {
  const rel = relative(root, file);
  if (ALLOW.has(rel)) continue;
  const lines = (await readFile(file, 'utf8')).split('\n');
  lines.forEach((line, i) => {
    // Ignore token variable references — they never carry a raw value.
    const stripped = line.replace(/var\([^)]*\)/g, '');
    if (COLOR.test(stripped)) violations.push(`${rel}:${i + 1}: ${line.trim()}`);
  });
}

if (violations.length) {
  console.error('ui anti-drift lint failed:');
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    `\n${violations.length} violation(s). Move raw colours into src/tokens/semantic.ts and reference the variable.`,
  );
  process.exit(1);
}
console.log('ui anti-drift lint: no raw colours found outside the token source.');
