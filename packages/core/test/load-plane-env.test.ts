/**
 * Regression coverage for scripts/load-plane-env.sh.
 *
 * A sourced shell assignment is not inherited by child processes unless it is exported. The
 * console and beats are separate Node processes, so a launcher that merely sourced
 * `LOOPKIT_AUTONOMY=on` made both surfaces fail safe to OFF even though the parent shell could
 * print `on`. The versioned launcher helper must make assignment-only and explicit-export files
 * equivalent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// test compiles to packages/core/dist-test/test/ -> repo root is four up
const repoRoot = join(here, '..', '..', '..', '..');
const helperPath = join(repoRoot, 'scripts', 'load-plane-env.sh');

function withEnvFile(contents: string, run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'loopkit-plane-env-'));
  const path = join(dir, 'autonomy.env');
  writeFileSync(path, contents);
  try {
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sourceThenRead(envFile: string) {
  return spawnSync(
    '/bin/bash',
    [
      '-c',
      'LOOPKIT_ENV_FILE="$1"; source "$2"; exec "$3" -e \'process.stdout.write(`${process.env.LOOPKIT_AUTONOMY}|${process.env.LOOPKIT_PLANE_MODE}`)\'',
      'load-plane-env-test',
      envFile,
      helperPath,
      process.execPath,
    ],
    { encoding: 'utf8' },
  );
}

test('load-plane-env: plain assignments are exported to the launched process', () => {
  withEnvFile('LOOPKIT_AUTONOMY=on\nLOOPKIT_PLANE_MODE=live\n', (envFile) => {
    const result = sourceThenRead(envFile);
    assert.equal(result.status, 0, String(result.stderr));
    assert.equal(result.stdout, 'on|live');
  });
});

test('load-plane-env: already-exported assignments remain supported', () => {
  withEnvFile('export LOOPKIT_AUTONOMY=off\nexport LOOPKIT_PLANE_MODE=attended\n', (envFile) => {
    const result = sourceThenRead(envFile);
    assert.equal(result.status, 0, String(result.stderr));
    assert.equal(result.stdout, 'off|attended');
  });
});

test('load-plane-env: a standalone plane-home discovers config/autonomy.env', () => {
  const planeHome = mkdtempSync(join(tmpdir(), 'loopkit-plane-home-'));
  const configDir = join(planeHome, 'config');
  mkdirSync(configDir);
  writeFileSync(join(configDir, 'autonomy.env'), 'LOOPKIT_AUTONOMY=on\n');
  try {
    const result = spawnSync(
      '/bin/bash',
      [
        '-c',
        'LOOPKIT_HOME="$1"; source "$2"; exec "$3" -e \'process.stdout.write(process.env.LOOPKIT_AUTONOMY ?? "unset")\'',
        'load-plane-env-test',
        planeHome,
        helperPath,
        process.execPath,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, String(result.stderr));
    assert.equal(result.stdout, 'on');
  } finally {
    rmSync(planeHome, { recursive: true, force: true });
  }
});

test('load-plane-env: restores the caller allexport setting', () => {
  withEnvFile('LOOPKIT_AUTONOMY=on\n', (envFile) => {
    const result = spawnSync(
      '/bin/bash',
      [
        '-c',
        'set +a; LOOPKIT_ENV_FILE="$1"; source "$2"; [[ "$-" != *a* ]]',
        'load-plane-env-test',
        envFile,
        helperPath,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
  });
});

test('load-plane-env: a missing explicit file fails loudly', () => {
  const result = spawnSync(
    '/bin/bash',
    [
      '-c',
      'LOOPKIT_ENV_FILE="$1"; source "$2"',
      'load-plane-env-test',
      '/definitely/missing/loopkit.env',
      helperPath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /plane environment is not readable/);
});
