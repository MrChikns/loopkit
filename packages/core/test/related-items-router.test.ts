/**
 * related-items-router.test.ts — WI-235: the router routes each item aware of its siblings.
 *
 * Before this, stepRoute's per-item prompt carried only the candidate's own captured text — no
 * sibling awareness, so the router could send a new item straight into an in-flight collision
 * (overlapping Touches) or duplicate scope already covered by a dependency. These pin that
 * buildRelatedItemsProjection (a pure, deterministic, no-LLM projection over the fold) surfaces
 * an overlapping/dependent in-flight sibling, cleanly omits the section when nothing overlaps,
 * enforces its line/char caps with a visible truncation marker, and that the assembled section
 * actually reaches the router's per-item prompt via stepRoute/runReactor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { makeEvent } from '../src/schema.js';
import { fold, ItemRecord } from '../src/fold.js';
import { appendEvents } from '../src/ledger.js';
import { buildRelatedItemsProjection, runReactor } from '../src/beats/reactor.js';
import { CONFIG_DEFAULTS } from '../src/config.js';
import { LlmProvider, ProviderRequest, ProviderResult } from '../src/providers/types.js';

let n = 0;
function makeTempDir(): string {
  const dir = join(tmpdir(), `loopkit-wi235-${process.pid}-${++n}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function cleanDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** Minimal ItemRecord fixture — only the fields buildRelatedItemsProjection reads. */
function makeItem(overrides: Partial<ItemRecord> & { id: string; state: ItemRecord['state'] }): ItemRecord {
  return {
    sourceText: 'stub',
    builds: [],
    ...overrides,
  } as ItemRecord;
}

// ---------------------------------------------------------------------------
// buildRelatedItemsProjection — pure unit tests
// ---------------------------------------------------------------------------

test('buildRelatedItemsProjection: an in-flight sibling with overlapping Touches appears', () => {
  const candidate = makeItem({ id: 'WI-100', state: 'captured', touches: 'src/foo/' });
  const sibling = makeItem({ id: 'WI-050', state: 'queued', touches: 'src/foo/bar.ts', title: 'Fix foo bar' });
  const unrelated = makeItem({ id: 'WI-060', state: 'queued', touches: 'src/other/' });

  const body = buildRelatedItemsProjection(candidate, [candidate, sibling, unrelated]);
  assert.match(body, /WI-050 \(queued\): Fix foo bar/, 'overlapping sibling must appear with id, state, title');
  assert.doesNotMatch(body, /WI-060/, 'a non-overlapping item must not appear');
});

test('buildRelatedItemsProjection: a dependency edge surfaces the sibling even with disjoint Touches', () => {
  const candidate = makeItem({
    id: 'WI-100', state: 'captured', touches: 'src/foo/',
    dependencies: [{ item: 'WI-050', condition: 'merged-or-accepted', addedAt: '2026-01-01T00:00:00Z' }],
  });
  const sibling = makeItem({ id: 'WI-050', state: 'gated', touches: 'src/completely/unrelated/' });

  const body = buildRelatedItemsProjection(candidate, [candidate, sibling]);
  assert.match(body, /WI-050 \(gated\)/, 'a dependency edge must surface the sibling regardless of Touches overlap');
});

test('buildRelatedItemsProjection: the reverse dependency edge (sibling depends on candidate) also surfaces', () => {
  const candidate = makeItem({ id: 'WI-100', state: 'captured', touches: 'src/foo/' });
  const sibling = makeItem({
    id: 'WI-050', state: 'parked', touches: 'src/unrelated/',
    dependencies: [{ item: 'WI-100', condition: 'merged-or-accepted', addedAt: '2026-01-01T00:00:00Z' }],
  });

  const body = buildRelatedItemsProjection(candidate, [candidate, sibling]);
  assert.match(body, /WI-050 \(parked\)/);
});

test('buildRelatedItemsProjection: no overlap and no dependency edge → empty string (section omitted)', () => {
  const candidate = makeItem({ id: 'WI-100', state: 'captured', touches: 'src/foo/' });
  const unrelated = makeItem({ id: 'WI-060', state: 'queued', touches: 'src/other/' });

  const body = buildRelatedItemsProjection(candidate, [candidate, unrelated]);
  assert.equal(body, '', 'nothing related must produce an empty projection, not an empty section');
});

test('buildRelatedItemsProjection: a resolved sibling (accepted/done) never appears — no collision risk', () => {
  const candidate = makeItem({ id: 'WI-100', state: 'captured', touches: 'src/foo/' });
  const resolved = makeItem({ id: 'WI-050', state: 'accepted', touches: 'src/foo/bar.ts' });

  const body = buildRelatedItemsProjection(candidate, [candidate, resolved]);
  assert.equal(body, '', 'a resolved item carries no in-flight collision risk');
});

test('buildRelatedItemsProjection: line cap enforced — at most 10 rows plus a visible truncation marker', () => {
  const candidate = makeItem({ id: 'WI-100', state: 'captured', touches: 'src/foo/' });
  const siblings: ItemRecord[] = [];
  for (let i = 0; i < 15; i++) {
    siblings.push(makeItem({ id: `WI-2${String(i).padStart(2, '0')}`, state: 'queued', touches: 'src/foo/' }));
  }

  const body = buildRelatedItemsProjection(candidate, [candidate, ...siblings]);
  const lines = body.split('\n');
  const markerLine = lines.filter(l => l.includes('truncated'));
  const rowLines = lines.filter(l => /^WI-/.test(l));
  assert.equal(markerLine.length, 1, 'a truncation marker must be visible when rows are dropped');
  assert.ok(rowLines.length <= 10, `at most 10 rows, got ${rowLines.length}`);
});

test('buildRelatedItemsProjection: char cap enforced with a visible truncation marker', () => {
  const candidate = makeItem({ id: 'WI-100', state: 'captured', touches: 'src/foo/' });
  // A handful of siblings with very long titles — well under the 10-line cap but over 1000 chars.
  const siblings: ItemRecord[] = [];
  for (let i = 0; i < 5; i++) {
    siblings.push(makeItem({
      id: `WI-3${i}`, state: 'queued', touches: 'src/foo/',
      title: 'x'.repeat(90), // one-liner truncates titles at 80 chars but the row still adds up
    }));
  }
  const body = buildRelatedItemsProjection(candidate, [candidate, ...siblings]);
  assert.ok(body.length <= 1000, `projection must stay within the 1000-char cap, got ${body.length}`);
});

test('buildRelatedItemsProjection: falls back to spec, then sourceText, when no router title was stamped', () => {
  const candidate = makeItem({ id: 'WI-100', state: 'captured', touches: 'src/foo/' });
  const withSpec = makeItem({ id: 'WI-050', state: 'queued', touches: 'src/foo/', spec: 'Add the foo widget' });
  const withTextOnly = makeItem({ id: 'WI-051', state: 'queued', touches: 'src/foo/', sourceText: 'please add bar' });

  const body = buildRelatedItemsProjection(candidate, [candidate, withSpec, withTextOnly]);
  assert.match(body, /WI-050 \(queued\): Add the foo widget/);
  assert.match(body, /WI-051 \(queued\): please add bar/);
});

// ---------------------------------------------------------------------------
// Integration — the section reaches the actual router prompt (stepRoute/runReactor)
// ---------------------------------------------------------------------------

function capturingProvider(text: string, captured: string[]): LlmProvider {
  return {
    name: 'fake',
    async run(req: ProviderRequest): Promise<ProviderResult> {
      captured.push(req.prompt);
      return { ok: true, text, usage: { in: 0, out: 1, usd: 0 } };
    },
  };
}

const BUILD_BLOCK = [
  'ROUTE: build',
  'SPEC: do the thing',
  'CRITERIA:',
  '- observable outcome',
  'TOUCHES: src/foo/',
  'REPLY: queuing it',
].join('\n');

test('reactor: routing an item overlapping an in-flight sibling shows that sibling in the prompt', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    mkdirSync(join(repoRoot, '.ai', 'loops', 'prompts'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai', 'loops', 'prompts', 'router.md'), 'stub routing prompt');

    await appendEvents(ledgerDir, [
      // An in-flight sibling already queued against the same Touches prefix.
      makeEvent('cli', 'WI-050', 'item.captured', { source: 'test', text: 'existing foo work' }),
      makeEvent('reactor', 'WI-050', 'item.queued', { spec: 'existing foo work', touches: 'src/foo/' }),
      // The new item being routed this beat, whose text will get TOUCHES: src/foo/ from the model.
      makeEvent('cli', 'WI-100', 'item.captured', { source: 'test', text: 'add another foo thing' }),
    ]);

    const captured: string[] = [];
    await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: capturingProvider(BUILD_BLOCK, captured),
      config: { ...CONFIG_DEFAULTS, gateCommand: 'exit 0', gateWorkdir: '.', promptsDir: '.ai/loops/prompts' },
    });

    const routingPrompts = captured.filter(p => p.includes('ROUTE THIS ITEM ONLY') && p.includes('ID: WI-100'));
    assert.equal(routingPrompts.length, 1, 'WI-100 must have been routed exactly once');
    assert.match(routingPrompts[0]!, /RELATED IN-FLIGHT ITEMS/, 'the section header must reach the prompt');
    assert.match(routingPrompts[0]!, /WI-050 \(queued\)/, 'the overlapping sibling must be named');
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});

test('reactor: routing an item with no overlapping siblings omits the section entirely', async () => {
  const ledgerDir = makeTempDir();
  const repoRoot = makeTempDir();
  try {
    mkdirSync(join(repoRoot, '.ai', 'loops', 'prompts'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai', 'loops', 'prompts', 'router.md'), 'stub routing prompt');

    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-200', 'item.captured', { source: 'test', text: 'a brand new isolated item' }),
    ]);

    const captured: string[] = [];
    await runReactor({
      repoRoot,
      ledgerDir,
      autonomy: 'on',
      provider: capturingProvider(BUILD_BLOCK, captured),
      config: { ...CONFIG_DEFAULTS, gateCommand: 'exit 0', gateWorkdir: '.', promptsDir: '.ai/loops/prompts' },
    });

    const routingPrompts = captured.filter(p => p.includes('ROUTE THIS ITEM ONLY') && p.includes('ID: WI-200'));
    assert.equal(routingPrompts.length, 1);
    assert.doesNotMatch(routingPrompts[0]!, /RELATED IN-FLIGHT ITEMS/, 'no siblings → no section, not an empty one');
  } finally {
    cleanDir(ledgerDir);
    cleanDir(repoRoot);
  }
});
