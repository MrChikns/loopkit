/**
 * ci-reenable.test.ts — the ci-reenable heal runbook.
 *
 * Verifies: runbook shape (auto-heal, day1Exempt), enables only disabled_manually
 * workflows via `gh workflow enable`, clears config.ci.reenableOn afterward (idempotent
 * config-driven heal), and is a no-op-but-still-clears when nothing is disabled.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getRunbook, RunbookContext } from '../src/runbooks.js';

function cleanDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

test('runbooks: ci-reenable is auto-heal, day1Exempt', () => {
  const rb = getRunbook('ci-reenable');
  assert.ok(rb, 'ci-reenable runbook must exist');
  assert.equal(rb.tier, 'auto-heal');
  assert.equal(rb.day1Exempt, true);
});

test('runbooks: ci-reenable enables disabled_manually workflows and clears config.ci.reenableOn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-reenable-'));
  try {
    writeFileSync(join(dir, 'loopkit.config.json'), JSON.stringify({ ci: { reenableOn: '2026-08-01' } }));
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const ctx: RunbookContext = {
      repoRoot: dir,
      key: 'ci-reenable',
      spawn: (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === 'gh' && args[0] === 'workflow' && args[1] === 'list') {
          return {
            ok: true,
            output: JSON.stringify([
              { name: 'CI', path: '.github/workflows/ci.yml', state: 'disabled_manually' },
              { name: 'Nightly CVE tripwire', path: '.github/workflows/nightly.yml', state: 'disabled_manually' },
            ]),
          };
        }
        if (cmd === 'gh' && args[0] === 'workflow' && args[1] === 'enable') {
          return { ok: true, output: '' };
        }
        return { ok: true, output: '' };
      },
    };

    const evidence = await getRunbook('ci-reenable')!.execute!(ctx);

    const enableCalls = calls.filter(c => c.cmd === 'gh' && c.args[1] === 'enable');
    assert.equal(enableCalls.length, 2, 'both disabled_manually workflows must be enabled');
    assert.ok(evidence.includes('ci.yml') && evidence.includes('nightly.yml'));

    const config = JSON.parse(readFileSync(join(dir, 'loopkit.config.json'), 'utf8'));
    assert.equal(config.ci, undefined, 'ci.reenableOn must be cleared (and the now-empty ci block dropped)');
  } finally {
    cleanDir(dir);
  }
});

test('runbooks: ci-reenable is idempotent when workflows are already enabled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-reenable-noop-'));
  try {
    writeFileSync(join(dir, 'loopkit.config.json'), JSON.stringify({ ci: { reenableOn: '2026-08-01' } }));
    const ctx: RunbookContext = {
      repoRoot: dir,
      key: 'ci-reenable',
      spawn: (cmd, args) => {
        if (cmd === 'gh' && args[0] === 'workflow' && args[1] === 'list') {
          return {
            ok: true,
            output: JSON.stringify([
              { name: 'CI', path: '.github/workflows/ci.yml', state: 'active' },
            ]),
          };
        }
        return { ok: true, output: '' };
      },
    };

    const evidence = await getRunbook('ci-reenable')!.execute!(ctx);
    assert.ok(evidence.includes('cleared ci.reenableOn'));

    const config = JSON.parse(readFileSync(join(dir, 'loopkit.config.json'), 'utf8'));
    assert.equal(config.ci, undefined, 'ci.reenableOn must still be cleared so the SLO row never re-fires');
  } finally {
    cleanDir(dir);
  }
});
