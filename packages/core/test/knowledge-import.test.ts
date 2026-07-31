/**
 * knowledge-import.test.ts — ADR-015 Slice 4 (optional): `loopctl knowledge import`, the
 * one-time operator-run migration of a hand-curated playbook into the ledger. Spawned against
 * the compiled binary (same convention as provenance-cli.test.ts / target-cli.test.ts) since
 * this is a CLI seam: argv/target resolution, file reads, and the ledger writes it makes.
 *
 * Pins:
 *   - a fresh (non-generated) playbook file with N non-comment lesson lines imports N
 *     `knowledge.ratified` events, hashed via the SAME `hashPlaybookContent` helper Slice 1/3
 *     use (imported here only to compute the expected hash for assertions, never reimplemented
 *     for the import path itself);
 *   - re-running the exact same import appends ZERO new knowledge.ratified events (idempotent);
 *   - comment ('#'-prefixed) and blank lines are skipped, never counted as lessons;
 *   - a playbook file already carrying PLAYBOOK_GENERATED_BANNER is refused outright, no events
 *     appended at all;
 *   - the ratified set the import produces reproduces byte-for-byte (modulo ordering) what a
 *     post-import stepPlaybookMaterialize beat would render — i.e. every imported lesson
 *     resurfaces in the materialized playbook.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { loadAllEvents } from '../src/ledger.js';
import { TARGET_MANIFEST_FILENAME } from '../src/target.js';
import { hashPlaybookContent, PLAYBOOK_GENERATED_BANNER } from '../src/render-playbook.js';
import { runReactor } from '../src/beats/reactor.js';
import { CONFIG_DEFAULTS, LoopkitConfig } from '../src/config.js';

const execFileAsync = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

async function runLoopctl(ledgerDir: string, ...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      env: { ...process.env, LOOPKIT_LEDGER: ledgerDir },
    });
    return { stdout: stdout.trim(), stderr: stderr.trim(), code: 0 };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return { stdout: (err.stdout ?? '').trim(), stderr: (err.stderr ?? '').trim(), code: err.code ?? 1 };
  }
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', cwd, ...args], { stdio: 'pipe', encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A registered target repo, optionally seeded with a playbook file at .ai/loops/playbook.md. */
function makeTargetRepo(root: string, playbookContent?: string): string {
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 't@t');
  git(root, 'config', 'user.name', 't');
  writeFileSync(join(root, 'README.md'), 'root\n');
  writeFileSync(join(root, TARGET_MANIFEST_FILENAME), JSON.stringify({
    name: 'acme-web',
    defaultBranch: 'main',
  }, null, 2));
  if (playbookContent !== undefined) {
    mkdirSync(join(root, '.ai', 'loops'), { recursive: true });
    writeFileSync(join(root, '.ai', 'loops', 'playbook.md'), playbookContent);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'root commit + manifest + playbook');
  return root;
}

const FIXTURE_PLAYBOOK = `# Repo playbook — recurring lessons for build workers
# One ratified lesson per non-comment line.

Commit by explicit file path, never git add -A.
Declare DIRECTORY-level Touches prefixes ending with /.
Breaker: 3 consecutive gate failures park the item autonomously.
`;

function makeEnv(prefix: string): { base: string; ledgerDir: string } {
  const base = mkdtempSync(join(tmpdir(), prefix));
  const ledgerDir = join(base, 'ledger');
  return { base, ledgerDir };
}

test('knowledge import: a fresh playbook imports one knowledge.ratified per non-comment line, hashed via hashPlaybookContent', async () => {
  const { base, ledgerDir } = makeEnv('know-import-fresh-');
  try {
    const root = makeTargetRepo(join(base, 'repo'), FIXTURE_PLAYBOOK);
    await runLoopctl(ledgerDir, 'target', 'add', root);

    const out = await runLoopctl(ledgerDir, 'knowledge', 'import', '--target', root);
    assert.equal(out.code, 0, `expected exit 0, got ${out.code}: ${out.stdout}\n${out.stderr}`);
    assert.match(out.stdout, /Imported 3, skipped 0/);

    const events = await loadAllEvents(ledgerDir);
    const ratified = events.filter(e => e.type === 'knowledge.ratified');
    assert.equal(ratified.length, 3);

    const expectedHash = hashPlaybookContent('commit by explicit file path, never git add -a.');
    const first = ratified.find(e => (e.data as { contentHash: string }).contentHash === expectedHash);
    assert.ok(first, 'the first fixture line was ratified with the hashPlaybookContent-computed hash');
    const data = first!.data as { lesson: string; ratifiedBy: string; sourceWi: string };
    assert.equal(data.lesson, 'Commit by explicit file path, never git add -A.');
    assert.equal(data.ratifiedBy, 'operator-import');

    // Every ratified event lands on the SAME one import work item (one operator act, not N).
    const wiIds = new Set(ratified.map(e => e.item));
    assert.equal(wiIds.size, 1, 'all imported lessons are recorded on a single import work item');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('knowledge import: comment and blank lines are skipped, never counted as lessons', async () => {
  const { base, ledgerDir } = makeEnv('know-import-comments-');
  try {
    const root = makeTargetRepo(join(base, 'repo'), FIXTURE_PLAYBOOK);
    await runLoopctl(ledgerDir, 'target', 'add', root);

    await runLoopctl(ledgerDir, 'knowledge', 'import', '--target', root);
    const events = await loadAllEvents(ledgerDir);
    const ratified = events.filter(e => e.type === 'knowledge.ratified');
    // FIXTURE_PLAYBOOK has 2 comment lines, 2 blank-ish lines, and exactly 3 lesson lines.
    assert.equal(ratified.length, 3);
    for (const ev of ratified) {
      const lesson = (ev.data as { lesson: string }).lesson;
      assert.ok(!lesson.startsWith('#'), `lesson must not be a comment line: ${lesson}`);
      assert.ok(lesson.trim().length > 0, 'lesson must not be blank');
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('knowledge import: re-running the same import is idempotent — zero new knowledge.ratified events', async () => {
  const { base, ledgerDir } = makeEnv('know-import-idempotent-');
  try {
    const root = makeTargetRepo(join(base, 'repo'), FIXTURE_PLAYBOOK);
    await runLoopctl(ledgerDir, 'target', 'add', root);

    const first = await runLoopctl(ledgerDir, 'knowledge', 'import', '--target', root);
    assert.equal(first.code, 0);
    const afterFirst = (await loadAllEvents(ledgerDir)).filter(e => e.type === 'knowledge.ratified');
    assert.equal(afterFirst.length, 3);

    const second = await runLoopctl(ledgerDir, 'knowledge', 'import', '--target', root);
    assert.equal(second.code, 0, `expected exit 0 on a nothing-to-do re-run, got ${second.code}: ${second.stdout}\n${second.stderr}`);
    assert.match(second.stdout, /Imported 0, skipped 3/);

    const afterSecond = (await loadAllEvents(ledgerDir)).filter(e => e.type === 'knowledge.ratified');
    assert.equal(afterSecond.length, 3, 'a re-run must append no new ratified events');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('knowledge import: a GENERATED-banner playbook is refused outright, no events appended', async () => {
  const { base, ledgerDir } = makeEnv('know-import-generated-');
  try {
    const generatedContent = `${PLAYBOOK_GENERATED_BANNER}\n\n- Some previously ratified lesson.\n`;
    const root = makeTargetRepo(join(base, 'repo'), generatedContent);
    await runLoopctl(ledgerDir, 'target', 'add', root);

    const out = await runLoopctl(ledgerDir, 'knowledge', 'import', '--target', root);
    assert.notEqual(out.code, 0, 'importing a generated file must be refused, not silently accepted');
    assert.match(out.stderr, /GENERATED banner/);
    assert.match(out.stderr, /projection/);

    const events = await loadAllEvents(ledgerDir).catch(() => []);
    assert.equal(events.filter(e => e.type === 'knowledge.ratified').length, 0, 'a refused import must append nothing');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('knowledge import: no playbook file at all — nothing-to-do, exit 0, no events', async () => {
  const { base, ledgerDir } = makeEnv('know-import-missing-');
  try {
    const root = makeTargetRepo(join(base, 'repo')); // no playbook seeded
    await runLoopctl(ledgerDir, 'target', 'add', root);

    const out = await runLoopctl(ledgerDir, 'knowledge', 'import', '--target', root);
    assert.equal(out.code, 0);
    assert.match(out.stdout, /Nothing to import/);

    const events = await loadAllEvents(ledgerDir).catch(() => []);
    assert.equal(events.filter(e => e.type === 'knowledge.ratified').length, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('knowledge import: post-import stepPlaybookMaterialize reproduces the curated set (every imported lesson resurfaces)', async () => {
  const { base, ledgerDir } = makeEnv('know-import-materialize-');
  try {
    const root = makeTargetRepo(join(base, 'repo'), FIXTURE_PLAYBOOK);
    await runLoopctl(ledgerDir, 'target', 'add', root);

    const importOut = await runLoopctl(ledgerDir, 'knowledge', 'import', '--target', root);
    assert.equal(importOut.code, 0);

    // Now run stepPlaybookMaterialize (via runReactor) with knowledgePromotion enabled, pointed
    // at the SAME repo root the lessons were imported from, and confirm the rendered file
    // contains every imported lesson line — the projection reproduces the operator's curated set.
    const cfg: LoopkitConfig = {
      ...CONFIG_DEFAULTS,
      gateCommand: 'exit 0',
      gateWorkdir: '.',
      breakerN: 3,
      promptsDir: '.ai/loops/prompts',
      notifyHook: '.ai/notify-phone.sh',
      knowledgePromotion: { enabled: true, ttlDays: 60 },
    };
    mkdirSync(join(root, '.ai', 'runs', 'loopkit'), { recursive: true });
    await runReactor({ repoRoot: root, ledgerDir, autonomy: 'on', provider: null, config: cfg });

    const rendered = readFileSync(join(root, '.ai', 'loops', 'playbook.md'), 'utf8');
    assert.match(rendered, /GENERATED/);
    assert.match(rendered, /Commit by explicit file path, never git add -A\./);
    assert.match(rendered, /Declare DIRECTORY-level Touches prefixes ending with \/\./);
    assert.match(rendered, /Breaker: 3 consecutive gate failures park the item autonomously\./);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
