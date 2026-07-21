/**
 * views.test.ts — pure render tests for the console's views against the synthetic fixtures.
 * Reshelled onto `@loopkit/ui` (Command/Missions/Acceptance/System/Analytics) — see
 * server.test.ts for the end-to-end HTTP-level shell/no-inline-script/verb assertions that
 * apply uniformly across every route.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { fold, makeEvent, AcceptanceTierClassifyConfig } from '@loopkit/core';
import type { LedgerEvent } from '@loopkit/core';

import {
  renderCommand,
  renderMissions,
  renderItemTimeline,
  renderAcceptance,
  renderSystem,
  renderActivity,
  renderAnalytics,
  tierConfigFromLoopkitConfig,
  unblockNote,
  ArtifactEntry,
} from '../src/views.js';
import { sampleLedger, hostileLedger, tieredMergeLedger, decisionParkVariantsLedger } from './fixtures.js';

const NOW = new Date('2026-07-02T00:00:00.000Z');
const LATER_NOW = new Date('2026-07-04T00:00:00.000Z');
const COMMAND_URL = new URL('http://localhost/command');

/** A scratch git repo with one commit on `master` and one branch off it — used to exercise
 *  the decision desk's branch-liveness check (`git rev-parse --verify`) against a real,
 *  disposable repo rather than this project's own history. Caller must rmSync the returned
 *  root when done. */
function makeGitRepoWithBranch(branch: string): string {
  const root = mkdtempSync(join(tmpdir(), 'loopkit-views-test-'));
  const run = (...args: string[]) => spawnSync('git', args, { cwd: root, stdio: 'pipe' });
  run('init', '-q', '-b', 'master');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'test');
  run('commit', '--allow-empty', '-q', '-m', 'root');
  run('branch', branch);
  return root;
}

/** A parked item with a single `item.parked` event carrying `reason`/`parkKind`, optionally
 *  preceded by a `build.dispatched` recording `branch` — the minimal event shape the park-
 *  explain block reads from (parkReason, parkKind, resolveItemBranch). */
function parkedItem(id: string, reason: string, parkKind: 'decision' | 'ops', branch?: string): LedgerEvent[] {
  const events: LedgerEvent[] = [
    makeEvent('cli', id, 'item.captured', { source: 'cli', text: 'a change' }, '2026-07-01T09:00:00.000Z'),
    makeEvent('reactor', id, 'item.queued', { spec: 'a change' }, '2026-07-01T09:01:00.000Z'),
  ];
  if (branch) {
    events.push(makeEvent('dispatch', id, 'build.dispatched', { attempt: 1, branch, worktree: '/tmp/wt' }, '2026-07-01T09:02:00.000Z'));
  }
  events.push(makeEvent('dispatch', id, 'item.parked', { reason, parkKind }, '2026-07-01T09:03:00.000Z'));
  return events;
}

/** A minimal tier config: no surface prefixes, no plane prefixes, no risk patterns — every
 *  fixture item classifies purely on files-changed / judge-verdict, independent of any real
 *  fork's loopkit.config.json. */
const BARE_TIER_CFG: AcceptanceTierClassifyConfig = {
  surfacePrefixes: [],
  planePrefixes: [],
  riskPatterns: [],
};

/** A tier config naming `packages/console/` as a product surface — exercises the 'review' tier. */
const SURFACE_TIER_CFG: AcceptanceTierClassifyConfig = {
  surfacePrefixes: ['packages/console/'],
  planePrefixes: [],
  riskPatterns: [],
};

// ---------------------------------------------------------------------------
// View — Command (/command)
// ---------------------------------------------------------------------------

test('renderCommand: shows the glance card, decision desk, and conductor regions', () => {
  const result = fold(sampleLedger());
  const html = renderCommand(result, NOW, [], COMMAND_URL);

  assert.match(html, /Command/);
  assert.match(html, /Glance/);
  assert.match(html, /Decision desk/);
  assert.match(html, /Conductor/);
  assert.match(html, /WI-003/); // decision park shows on the decision desk
  assert.match(html, /WI-002/); // building item shows on the conductor card
});

test('renderCommand: empty fold still renders the glance/decision-desk/conductor shell, no crash', () => {
  const html = renderCommand(fold([]), NOW, [], COMMAND_URL);
  assert.match(html, /Command/);
  assert.match(html, /Nothing needs you — the queue is unblocked\./);
  assert.match(html, /No workers building right now\./);
});

test('renderCommand: a decision park flips the page status chip to "needs you"', () => {
  const html = renderCommand(fold(sampleLedger()), NOW, [], COMMAND_URL);
  assert.match(html, /Lane needs you/);
});

test('renderCommand: no decision parks reads "Lane healthy"', () => {
  const html = renderCommand(fold([]), NOW, [], COMMAND_URL);
  assert.match(html, /Lane healthy/);
});

test('renderCommand: renders the intent-capture composer, no target selector with 0/1 targets', () => {
  const html = renderCommand(fold(sampleLedger()), NOW, [], COMMAND_URL);
  assert.match(html, /<form id="opsui-intent-form" class="opsui-composer"[^>]*action="\/intent"/);
  assert.match(html, /<textarea class="opsui-composer__input"/);
  assert.ok(!html.includes('<select name="target"'));
});

test('renderCommand: with 2+ registered targets, shows a target <select>', () => {
  const events = [
    ...sampleLedger(),
    { id: 'ev-t1', ts: '2026-07-01T00:00:00.000Z', actor: 'cli', item: 'alpha', type: 'target.registered', data: { name: 'alpha', repoPath: '/tmp/alpha', manifestHash: 'a'.repeat(40), defaultBranch: 'main' } },
    { id: 'ev-t2', ts: '2026-07-01T00:00:01.000Z', actor: 'cli', item: 'beta', type: 'target.registered', data: { name: 'beta', repoPath: '/tmp/beta', manifestHash: 'b'.repeat(40), defaultBranch: 'main' } },
  ];
  const html = renderCommand(fold(events), NOW, [], COMMAND_URL);
  assert.match(html, /<select name="target" form="opsui-intent-form" required>/);
  assert.match(html, /<option value="alpha">alpha<\/option>/);
  assert.match(html, /<option value="beta">beta<\/option>/);
});

test('renderCommand: a captured id renders the composer\'s confirmation chip linking to /item/<id>', () => {
  const html = renderCommand(fold([]), NOW, [], COMMAND_URL, 'WI-042');
  assert.match(html, /Captured as/);
  assert.match(html, /WI-042/);
  // The chip links to the console's real item route (app-resolved capturedHref), never a
  // hardcoded origin-product path.
  assert.match(html, /<a class="opsui-composer__captured-link" href="\/item\/WI-042">/);
});

test('renderCommand: decision-park rows carry approve + reject forms', () => {
  const html = renderCommand(fold(sampleLedger()), NOW, [], COMMAND_URL);
  assert.match(html, /action="\/item\/WI-003\/approve\?returnTo=%2Fcommand"/);
  assert.match(html, /action="\/item\/WI-003\/reject\?returnTo=%2Fcommand"/);
});

/** The approve <form> markup for one item: from its action URL to the form's closing tag. */
function approveFormFor(html: string, itemId: string): string {
  const start = html.indexOf(`/item/${itemId}/approve`);
  assert.ok(start > -1, `no approve form found for ${itemId}`);
  const end = html.indexOf('</form>', start);
  return html.slice(start, end);
}

test('renderCommand: the approve label states what approving does — merge built branch vs requeue', () => {
  const html = renderCommand(fold(decisionParkVariantsLedger()), NOW, [], COMMAND_URL);
  // WI-010's build recorded a branch — approving merges it.
  assert.match(approveFormFor(html, 'WI-010'), /Approve — merge built branch/);
  // WI-011 parked before any build — approving requeues it.
  assert.match(approveFormFor(html, 'WI-011'), /Approve — requeue for build/);
});

test('renderCommand: a decision park whose build recorded no branch keeps the neutral Approve label', () => {
  // WI-003's build.dispatched carried no branch signal — the render can't promise either outcome.
  const html = renderCommand(fold(sampleLedger()), NOW, [], COMMAND_URL);
  assert.match(approveFormFor(html, 'WI-003'), />Approve<\/button>/);
});

// ---------------------------------------------------------------------------
// Decision desk — structured park explanation (What it is / Why parked / What approving
// does / Recommendation), replacing the old raw "Parked: <reason>" summary suffix.
// ---------------------------------------------------------------------------

test('decisionDeskCard: an out-of-scope (touches-overstep) park lists the files and recommends review', () => {
  const events = parkedItem(
    'WI-500',
    'needs-decision: files outside declared Touches (packages/console/**): packages/core/src/fold.ts, packages/core/src/schema.ts',
    'decision',
  );
  const html = renderCommand(fold(events), NOW, [], COMMAND_URL);
  assert.match(html, /Why parked<\/span><span class="evidence__val">2 files outside the declared scope: packages\/core\/src\/fold\.ts, packages\/core\/src\/schema\.ts/);
  assert.match(html, /Recommendation<\/span><span class="evidence__val">Review the file list before approving\./);
  assert.ok(!html.includes('Parked: needs-decision'));
});

test('decisionDeskCard: a protected-path (spine) park names the path and always recommends review', () => {
  const events = parkedItem('WI-501', 'needs-decision: touches spine (packages/core/src/schema.ts) — approve to merge', 'decision');
  const html = renderCommand(fold(events), NOW, [], COMMAND_URL);
  assert.match(html, /Why parked<\/span><span class="evidence__val">Touches a protected path: packages\/core\/src\/schema\.ts/);
  assert.match(html, /Recommendation<\/span><span class="evidence__val">Always review — a protected path changed\./);
});

test('opsParksCard: a push-failure park reads as transient and safe to approve', () => {
  const events = parkedItem('WI-502', 'push to origin failed: non-fast-forward', 'ops');
  const html = renderCommand(fold(events), NOW, [], COMMAND_URL);
  assert.match(html, /Why parked<\/span><span class="evidence__val">Pushing the built branch to the target repo failed\./);
  assert.match(html, /Recommendation<\/span><span class="evidence__val">Transient — usually safe to approve\./);
});

test('opsParksCard: a merge-conflict park reads as transient', () => {
  const events = parkedItem('WI-503', 'infra: merge conflict on work/WI-503', 'ops');
  const html = renderCommand(fold(events), NOW, [], COMMAND_URL);
  assert.match(html, /Why parked<\/span><span class="evidence__val">The built branch conflicts with the target branch and could not be merged automatically\./);
  assert.match(html, /Recommendation<\/span><span class="evidence__val">Transient — usually safe to approve once the target has settled\./);
});

test('opsParksCard: a no-commit park explains no usable build and recommends a requeue', () => {
  const events = parkedItem('WI-504', 'no-commit: agent produced no commit (log: /tmp/x.log)', 'ops');
  const html = renderCommand(fold(events), NOW, [], COMMAND_URL);
  assert.match(html, /Why parked<\/span><span class="evidence__val">The build produced no commit to merge\./);
  assert.match(html, /Recommendation<\/span><span class="evidence__val">No usable build exists — approving requeues a fresh attempt\./);
});

test('decisionDeskCard: a park reason matching no known class falls back to the raw reason with no recommendation line', () => {
  const events = parkedItem('WI-505', 'armed trigger nightly-audit fired (escalation): rotate the signing key', 'decision');
  const html = renderCommand(fold(events), NOW, [], COMMAND_URL);
  assert.match(html, /Why parked<\/span><span class="evidence__val">armed trigger nightly-audit fired \(escalation\): rotate the signing key/);
  assert.ok(!html.includes('Recommendation<'));
});

test('decisionDeskCard: "What approving does" merges the recorded branch when it is still live', () => {
  const repoRoot = makeGitRepoWithBranch('work/WI-506');
  try {
    const events = parkedItem('WI-506', 'needs-decision: touches spine (packages/core/src/schema.ts) — approve to merge', 'decision', 'work/WI-506');
    const html = renderCommand(fold(events), NOW, [], COMMAND_URL, undefined, undefined, undefined, repoRoot);
    assert.match(html, /What approving does<\/span><span class="evidence__val">Merges branch work\/WI-506\./);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('decisionDeskCard: "What approving does" reads as a requeue when the recorded branch no longer exists', () => {
  const repoRoot = makeGitRepoWithBranch('work/unrelated');
  try {
    const events = parkedItem('WI-507', 'needs-decision: touches spine (packages/core/src/schema.ts) — approve to merge', 'decision', 'work/WI-507-long-gone');
    const html = renderCommand(fold(events), NOW, [], COMMAND_URL, undefined, undefined, undefined, repoRoot);
    assert.match(html, /What approving does<\/span><span class="evidence__val">Requeues fresh — branch work\/WI-507-long-gone no longer exists\./);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('decisionDeskCard: "What approving does" reads as a requeue when no build is on record', () => {
  const events = parkedItem('WI-508', 'needs-decision: touches spine (packages/core/src/schema.ts) — approve to merge', 'decision');
  const html = renderCommand(fold(events), NOW, [], COMMAND_URL);
  assert.match(html, /What approving does<\/span><span class="evidence__val">Requeues fresh — no build is on record\./);
});

test('renderMissions: a parked item explains itself with the same structured block as the decision desk', () => {
  const events = parkedItem('WI-509', 'push to origin failed: timeout', 'ops');
  const html = renderMissions(fold(events), NOW);
  assert.match(html, /Why parked<\/span><span class="evidence__val">Pushing the built branch to the target repo failed\./);
});

test('renderCommand: a decision-desk row with a scout brief renders it as a collapsed details block', () => {
  const events = [...sampleLedger(), makeEvent('dispatch', 'WI-003', 'item.briefed', { brief: 'branch point: touches the public rename surface' }, '2026-07-01T11:04:00.000Z')];
  const html = renderCommand(fold(events), NOW, [], COMMAND_URL);
  assert.match(html, /<details class="evidence__details"><summary>Scout brief/);
  assert.match(html, /branch point: touches the public rename surface/);
});

test('renderCommand: a decision-desk row with no scout brief renders no details block', () => {
  const html = renderCommand(fold(sampleLedger()), NOW, [], COMMAND_URL);
  assert.ok(!html.includes('evidence__details'));
});

test('renderCommand: escapes a hostile scout brief on the decision desk', () => {
  const payload = '<script>alert(1)</script>&"\'';
  const events = [...sampleLedger(), makeEvent('dispatch', 'WI-003', 'item.briefed', { brief: payload }, '2026-07-01T11:04:00.000Z')];
  const html = renderCommand(fold(events), NOW, [], COMMAND_URL);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /&lt;script&gt;/);
});

test('renderCommand: the Active ops-parks card shows the same unblock note as Missions', () => {
  const events = [
    ...queuedItem('WI-801'),
    makeEvent('dispatch', 'WI-801', 'item.parked', { reason: 'infra: no commit', parkKind: 'ops' }, '2026-07-01T09:04:00.000Z'),
  ];
  const html = renderCommand(fold(events), NOW, [], COMMAND_URL);
  assert.match(html, /Active ops-parks/);
  assert.match(html, /Auto-retries; escalates on breaker/);
});

test('renderCommand: the Glance card renders a 24h/7d/30d window picker', () => {
  const html = renderCommand(fold(sampleLedger()), NOW, [], COMMAND_URL);
  assert.match(html, /class="opsui-window"/);
  assert.match(html, /href="\?window=24h"/);
  assert.match(html, /href="\?window=7d"/);
  assert.match(html, /href="\?window=30d"/);
});

test('renderCommand: the Glance card shows a window-scoped Flow tile — median mergedAt-capturedAt with N-in/N-out plus live queue depth', () => {
  // sampleLedger's 24h window (relative to NOW) sees 4 captures (WI-001..WI-004) and 1 merge
  // (WI-004, captured 12:00 -> merged 12:21 = a 21m cycle); WI-005 merged the day before, outside 24h.
  // WI-001 is 'queued' — the only item in the live queue count, independent of the window.
  const html24h = renderCommand(fold(sampleLedger()), NOW, [], COMMAND_URL);
  assert.match(html24h, /Flow/);
  assert.match(html24h, /21m/);
  assert.match(html24h, /median cycle · 4 in \/ 1 out \(last 24h\) · 1 queued/);

  // The 7d window pulls in WI-005 too (also a 21m cycle), so the median is unchanged but the
  // in/out counts grow — proving the tile recomputes per window, not just once.
  const html7d = renderCommand(fold(sampleLedger()), NOW, [], new URL('http://localhost/command?window=7d'));
  assert.match(html7d, /median cycle · 5 in \/ 2 out \(last 7d\) · 1 queued/);
});

test('renderCommand: the Glance card shows a window-scoped Reliability tile — share of window merges with attempts===1', () => {
  const html = renderCommand(fold(sampleLedger()), NOW, [], COMMAND_URL);
  assert.match(html, /Reliability/);
  assert.match(html, /100%/);
  assert.match(html, /1\/1 merged first try \(last 24h\)/);
});

test('renderCommand: Flow and Reliability tiles read "—" with no window merges, and both link to \\/missions', () => {
  // A lone decision park (no merges anywhere) keeps the glance out of its All-clear collapse
  // — the empty-fold case renders All-clear instead, which drops every tile, Flow/Reliability
  // included, so it can't exercise this "—" formatting. WI-500 was itself captured inside the
  // 24h window (NOW), so Flow's "in" count is 1, not 0 — only "out" (merges) stays 0.
  const html = renderCommand(fold(parkedItem('WI-500', 'needs a decision', 'decision')), NOW, [], COMMAND_URL);
  assert.match(html, /<a class="opsui-metric opsui-metric--neutral" href="\/missions">[\s\S]*?Flow[\s\S]*?—[\s\S]*?median cycle · 1 in \/ 0 out \(last 24h\) · 0 queued/);
  assert.match(html, /<a class="opsui-metric opsui-metric--neutral" href="\/missions">[\s\S]*?Reliability[\s\S]*?—/);
});

test('renderCommand: the Glance card renders exactly the five named tiles (Decisions/To test/Stuck/Flow/Reliability), one row, and drops the old standalone Cycle-time/First-try/Queue/Shipped tiles', () => {
  const html = renderCommand(fold(sampleLedger()), LATER_NOW, [], COMMAND_URL);
  const glance = cardScope(html, 'Glance', 'Conversations');

  assert.match(glance, /class="opsui-glancegrid opsui-command-glance"/);
  assert.match(glance, />Decisions</);
  assert.match(glance, />To test</);
  assert.match(glance, />Stuck</);
  assert.match(glance, />Flow</);
  assert.match(glance, />Reliability</);

  // The old labels/standalone rows are gone from the glance card — this data now lives in the
  // Flow/Reliability footnotes (and the Shipped recently card further down the page).
  assert.ok(!glance.includes('Cycle time'));
  assert.ok(!glance.includes('First-try reliability'));
  assert.ok(!/opsui-glance-pulse__id">Queue</.test(glance));
  assert.ok(!/opsui-glance-pulse__id">Shipped</.test(glance));
});

// ---------------------------------------------------------------------------
// Per-item message threads — compact card on Command's decision desk, full section on the
// item timeline. Both render newest-reply-first and carry a plain POST reply form.
// ---------------------------------------------------------------------------

/** N msg.in events on `itemId`, one minute apart starting at `startTs`, texts "msg 1".."msg N". */
function threadMessages(itemId: string, count: number, startTs: string): LedgerEvent[] {
  const start = new Date(startTs).getTime();
  return Array.from({ length: count }, (_, i) =>
    makeEvent('operator', itemId, 'msg.in', { text: `msg ${i + 1}` }, new Date(start + i * 60_000).toISOString()),
  );
}

test('renderCommand: a decision-desk item with messages renders a thread card, newest first, with a reply form', () => {
  const events = [...sampleLedger(), ...threadMessages('WI-003', 2, '2026-07-01T11:20:00.000Z')];
  const html = renderCommand(fold(events), NOW, [], COMMAND_URL);

  assert.match(html, /class="thread-card"/);
  assert.match(html, /msg 1/);
  assert.match(html, /msg 2/);
  // Newest-reply-first: "msg 2" (later ts) appears before "msg 1" in the markup.
  assert.ok(html.indexOf('msg 2') < html.indexOf('msg 1'));
  assert.match(html, /<form method="post" action="\/item\/WI-003\/reply\?returnTo=%2Fcommand" enctype="multipart\/form-data"/);
  assert.match(html, /<textarea name="text"/);
  assert.match(html, /<input type="file" name="attachment"/);
});

test('renderCommand: a decision-desk item with no messages renders the thread card empty state', () => {
  const html = renderCommand(fold(sampleLedger()), NOW, [], COMMAND_URL);
  assert.match(html, /No messages yet\./);
});

/** Scopes a rendered Command page down to one card's markup (between its title and the next
 *  card's title) — the Conversations card also renders an item's thread (its own, independently
 *  paginated, `convThreadPage_<id>` param), so unscoped containment checks on the decision desk's
 *  own thread would false-positive on the Conversations card's copy of the same messages. */
function cardScope(html: string, title: string, nextTitle?: string): string {
  const start = html.indexOf(`<h3 class="opsui-card__title">${title}</h3>`);
  const end = nextTitle ? html.indexOf(`<h3 class="opsui-card__title">${nextTitle}</h3>`) : -1;
  return html.slice(start, end === -1 ? undefined : end);
}

/** Like `cardScope`, but the end boundary is an arbitrary literal marker rather than another
 *  card's `<h3>` title — the acceptance desk's "Lower priority" region is a `<details>` summary,
 *  not a Card title, so scoping "Waiting on your test" needs a plain substring boundary. */
function sliceBetween(html: string, startMarker: string, endMarker?: string): string {
  const start = html.indexOf(startMarker);
  const end = endMarker ? html.indexOf(endMarker, start) : -1;
  return html.slice(start, end === -1 ? undefined : end);
}

test('renderCommand: a decision-desk thread paginates independently per item via ?threadsPage_<id>=', () => {
  const events = [...sampleLedger(), ...threadMessages('WI-003', 5, '2026-07-01T11:20:00.000Z')];
  const result = fold(events);
  const page1 = renderCommand(result, NOW, [], COMMAND_URL);
  // Page 1 (compact page size 3) shows the 3 newest; "msg 1" (oldest) is on a later page.
  const deskPage1 = cardScope(page1, 'Decision desk', 'Conductor');
  assert.match(deskPage1, /msg 5/);
  assert.ok(!deskPage1.includes('msg 1'));
  assert.match(page1, /href="\/command\?threadsPage_WI-003=2"/);

  const page2Url = new URL('http://localhost/command?threadsPage_WI-003=2');
  const page2 = renderCommand(result, NOW, [], page2Url);
  const deskPage2 = cardScope(page2, 'Decision desk', 'Conductor');
  assert.match(deskPage2, /msg 1/);
  assert.ok(!deskPage2.includes('msg 5'));
});

test('renderCommand: the shipped count changes with the ?window= query', () => {
  const events = [
    ...sampleLedger(),
    // A merge far outside the 24h window from LATER_NOW but inside 30d.
    { id: 'ev-old', ts: '2026-06-20T00:00:00.000Z', actor: 'cli', item: 'WI-777', type: 'item.captured', data: { source: 'cli', text: 'old work' } },
    { id: 'ev-old2', ts: '2026-06-20T00:01:00.000Z', actor: 'reactor', item: 'WI-777', type: 'item.merged', data: { commit: 'aaa0000' } },
  ];
  const result = fold(events);
  const html24h = renderCommand(result, LATER_NOW, [], new URL('http://localhost/command?window=24h'));
  const html30d = renderCommand(result, LATER_NOW, [], new URL('http://localhost/command?window=30d'));
  assert.notEqual(html24h, html30d);
});

// ---------------------------------------------------------------------------
// Shipped recently card — merged/accepted items, newest-first, paginated.
// ---------------------------------------------------------------------------

test('renderCommand: Shipped recently lists merged/accepted items newest-first with commit + age', () => {
  const result = fold(sampleLedger());
  const html = renderCommand(result, LATER_NOW, [], COMMAND_URL);

  assert.match(html, /Shipped recently/);
  assert.match(html, /WI-004/); // merged, awaiting acceptance
  assert.match(html, /WI-005/); // accepted
  assert.match(html, /commit abc1234/);
  assert.match(html, /commit def5678/);
  // WI-004 merged 2026-07-01T12:21, WI-005 merged 2026-06-30T09:21 — WI-004 is newer.
  assert.ok(html.indexOf('WI-004') < html.indexOf('WI-005'));
});

test('renderCommand: Shipped recently shows an Accept action only for still-unaccepted items', () => {
  const html = renderCommand(fold(sampleLedger()), LATER_NOW, [], COMMAND_URL);
  assert.match(html, /action="\/item\/WI-004\/accept\?returnTo=%2Fcommand"/);
  assert.ok(!html.includes('/item/WI-005/accept'));
});

test('renderCommand: Shipped recently links each row to its item timeline', () => {
  const html = renderCommand(fold(sampleLedger()), LATER_NOW, [], COMMAND_URL);
  assert.match(html, /href="\/item\/WI-004"/);
  assert.match(html, /href="\/item\/WI-005"/);
});

test('renderCommand: Shipped recently paginates via ?shippedPage=', () => {
  const events = [...sampleLedger(), ...tieredMergeLedger()];
  const result = fold(events);
  const page1 = renderCommand(result, LATER_NOW, [], COMMAND_URL);
  // Page size 5: the 5 newest merges (WI-104, 103, 102, 101, WI-004) show; WI-005 (oldest) doesn't.
  // Scoped to the Shipped recently card itself — Recent captures (above it on the page) lists
  // every item regardless of shippedPage, including WI-104/WI-005, so an unscoped containment
  // check would false-positive on that card's copy.
  const shippedPage1 = cardScope(page1, 'Shipped recently');
  assert.match(shippedPage1, /WI-104/);
  assert.match(shippedPage1, /WI-004/);
  assert.ok(!shippedPage1.includes('WI-005'));
  assert.match(page1, /href="\/command\?shippedPage=2"/);

  const page2 = renderCommand(result, LATER_NOW, [], new URL('http://localhost/command?shippedPage=2'));
  const shippedPage2 = cardScope(page2, 'Shipped recently');
  assert.match(shippedPage2, /WI-005/);
  assert.ok(!shippedPage2.includes('WI-104'));
});

test('renderCommand: Shipped recently renders an empty state with no merged items', () => {
  const html = renderCommand(fold([]), LATER_NOW, [], COMMAND_URL);
  assert.match(html, /Nothing shipped yet/);
});

// ---------------------------------------------------------------------------
// Recent work items strip — the last ~5 recently-worked (merged/accepted) items, newest-first,
// at the very top of Command, above the Glance card.
// ---------------------------------------------------------------------------

test('renderCommand: the Recent work items strip renders above Glance, newest merge/accept first, with timeline links', () => {
  const html = renderCommand(fold(sampleLedger()), LATER_NOW, [], COMMAND_URL);
  const strip = sliceBetween(html, 'Recent work items', '<section class="opsui-card opsui-card--glance"');

  assert.match(strip, /Recent work items/);
  assert.match(strip, /WI-004/); // merged, awaiting acceptance
  assert.match(strip, /WI-005/); // accepted
  assert.match(strip, /href="\/item\/WI-004"[^>]*>timeline</);
  assert.match(strip, /href="\/item\/WI-005"[^>]*>timeline</);
  // WI-004 merged 2026-07-01T12:21, WI-005 merged 2026-06-30T09:21 — WI-004 is newer.
  assert.ok(strip.indexOf('WI-004') < strip.indexOf('WI-005'));
  // The strip renders BEFORE the Glance card in document order.
  assert.ok(html.indexOf('Recent work items') < html.indexOf('>Glance<'));
});

test('renderCommand: the Recent work items strip shows a thread link only for items with messages', () => {
  const events = [...sampleLedger(), ...threadMessages('WI-005', 1, '2026-06-30T10:30:00.000Z')];
  const html = renderCommand(fold(events), LATER_NOW, [], COMMAND_URL);
  const strip = sliceBetween(html, 'Recent work items', '<section class="opsui-card opsui-card--glance"');

  const wi004Row = strip.slice(strip.indexOf('WI-004'), strip.indexOf('WI-005'));
  const wi005Row = strip.slice(strip.indexOf('WI-005'));
  assert.ok(!wi004Row.includes('>thread<')); // WI-004 has no messages
  assert.match(wi005Row, />thread</); // WI-005 now has one
});

test('renderCommand: the Recent work items strip renders no markup at all with nothing shipped yet', () => {
  const html = renderCommand(fold([]), NOW, [], COMMAND_URL);
  assert.ok(!html.includes('Recent work items'));
  assert.ok(!html.includes('opsui-recentwork'));
});

test('renderCommand: the Recent work items strip caps at the 5 most recently shipped items', () => {
  const events = [...sampleLedger(), ...tieredMergeLedger()];
  const html = renderCommand(fold(events), LATER_NOW, [], COMMAND_URL);
  const strip = sliceBetween(html, 'Recent work items', '<section class="opsui-card opsui-card--glance"');
  // sampleLedger contributes WI-004/WI-005 (merged/accepted); tieredMergeLedger contributes
  // WI-101..WI-104 (all merged) — 6 shipped total, capped to the newest 5, so the oldest
  // (WI-005) drops off the strip.
  assert.ok(!strip.includes('WI-005'));
  assert.match(strip, /WI-004/);
  assert.match(strip, /WI-101/);
  assert.match(strip, /WI-104/);
});

// ---------------------------------------------------------------------------
// Conversations card — active threads across items and operator conversations, plus a
// compact recent-captures receipt strip. Both cards render above the intent composer's
// own "Captured as" receipt chip.
// ---------------------------------------------------------------------------

test('renderCommand: the Conversations card renders an active item thread as a collapsed details block with id, badge, and reply form', () => {
  const events = [...sampleLedger(), ...threadMessages('WI-003', 2, '2026-07-01T11:20:00.000Z')];
  const html = renderCommand(fold(events), NOW, [], COMMAND_URL);

  assert.match(html, /Conversations/);
  const convHtml = cardScope(html, 'Conversations', 'Recent captures');
  assert.match(convHtml, /class="opsui-conversations__thread"/);
  assert.match(convHtml, /WI-003/);
  assert.match(convHtml, /data-state="critical"/); // parked → critical badge
  assert.match(convHtml, /msg 1/);
  assert.match(convHtml, /msg 2/);
  assert.match(convHtml, /<form method="post" action="\/item\/WI-003\/reply\?returnTo=%2Fcommand"/);
});

test('renderCommand: the Conversations card surfaces an item spawned by a still-active conversation, even with no messages of its own', () => {
  const events = [
    ...sampleLedger(),
    makeEvent('operator', 'CONV-010', 'conv.started', { source: 'console', title: 'routing question' }, '2026-07-01T09:30:00.000Z'),
    makeEvent('operator', 'CONV-010', 'msg.in', { text: 'can you route this to the demo target?' }, '2026-07-01T09:30:01.000Z'),
    makeEvent('reactor', 'CONV-010', 'conv.promoted', { items: ['WI-001'] }, '2026-07-01T09:30:02.000Z'),
  ];
  const html = renderCommand(fold(events), NOW, [], COMMAND_URL);
  const convHtml = cardScope(html, 'Conversations', 'Recent captures');
  assert.match(convHtml, /WI-001/);
  assert.match(convHtml, /can you route this to the demo target\?/);
});

test('renderCommand: the Conversations card renders an empty state with no active threads', () => {
  const html = renderCommand(fold(sampleLedger()), NOW, [], COMMAND_URL);
  const convHtml = cardScope(html, 'Conversations', 'Recent captures');
  assert.match(convHtml, /No active conversations/);
});

test('renderCommand: a Conversations thread paginates independently via ?convThreadPage_<id>=', () => {
  const events = [...sampleLedger(), ...threadMessages('WI-003', 5, '2026-07-01T11:20:00.000Z')];
  const result = fold(events);
  const page1 = renderCommand(result, NOW, [], COMMAND_URL);
  const convPage1 = cardScope(page1, 'Conversations', 'Recent captures');
  assert.match(convPage1, /msg 5/);
  assert.ok(!convPage1.includes('msg 1'));
  assert.match(page1, /href="\/command\?convThreadPage_WI-003=2"/);

  const page2 = renderCommand(result, NOW, [], new URL('http://localhost/command?convThreadPage_WI-003=2'));
  const convPage2 = cardScope(page2, 'Conversations', 'Recent captures');
  assert.match(convPage2, /msg 1/);
  assert.ok(!convPage2.includes('msg 5'));
});

test('renderCommand: Recent captures lists every item newest-captured-first with a state badge and timeline link', () => {
  const html = renderCommand(fold(sampleLedger()), LATER_NOW, [], COMMAND_URL);
  const capturesHtml = cardScope(html, 'Recent captures', 'Decision desk');
  assert.match(capturesHtml, /class="opsui-captures-strip"/);
  assert.match(capturesHtml, /href="\/item\/WI-004"/);
  assert.match(capturesHtml, /href="\/item\/WI-005"/);
  // WI-004 captured 2026-07-01T12:00, WI-005 captured 2026-06-30T09:00 — WI-004 is newer.
  assert.ok(capturesHtml.indexOf('WI-004') < capturesHtml.indexOf('WI-005'));
});

test('renderCommand: Recent captures paginates via ?capturesPage=', () => {
  const start = new Date('2026-07-01T00:00:00.000Z').getTime();
  const events = Array.from({ length: 10 }, (_, i) =>
    makeEvent('cli', `WI-9${i}`, 'item.captured', { source: 'cli', text: `capture ${i}` }, new Date(start + i * 60_000).toISOString()),
  );
  const result = fold(events);
  const page1 = renderCommand(result, NOW, [], COMMAND_URL);
  const capturesPage1 = cardScope(page1, 'Recent captures', 'Decision desk');
  // Page size 8: the 8 newest (WI-99..WI-92) show; WI-90 (oldest) doesn't.
  assert.match(capturesPage1, /WI-99/);
  assert.ok(!capturesPage1.includes('WI-90'));
  assert.match(page1, /href="\/command\?capturesPage=2"/);

  const page2 = renderCommand(result, NOW, [], new URL('http://localhost/command?capturesPage=2'));
  const capturesPage2 = cardScope(page2, 'Recent captures', 'Decision desk');
  assert.match(capturesPage2, /WI-90/);
  assert.ok(!capturesPage2.includes('WI-99'));
});

test('renderCommand: Recent captures renders an empty state with no captures', () => {
  const html = renderCommand(fold([]), NOW, [], COMMAND_URL);
  const capturesHtml = cardScope(html, 'Recent captures', 'Decision desk');
  assert.match(capturesHtml, /Nothing captured yet/);
});

// ---------------------------------------------------------------------------
// View — Missions (/missions)
// ---------------------------------------------------------------------------

test('renderMissions: groups items by state and shows counts', () => {
  const result = fold(sampleLedger());
  const html = renderMissions(result, NOW);

  assert.match(html, /Missions/);
  assert.match(html, /WI-001/); // queued
  assert.match(html, /WI-002/); // building
  assert.match(html, /WI-003/); // parked
  assert.match(html, /WI-004/); // merged
  assert.match(html, /WI-005/); // accepted
  assert.match(html, /Building \(1\)/);
  assert.match(html, /Needs you \(parked\) \(1\)/);
});

test('renderMissions: empty fold renders an intentional empty state, no crash', () => {
  const html = renderMissions(fold([]), NOW);
  assert.match(html, /Missions/);
  assert.match(html, /The ledger is empty/);
});

test('renderMissions: parked (decision) rows carry approve + reject forms; merged rows carry an accept form', () => {
  const html = renderMissions(fold(sampleLedger()), NOW);
  assert.match(html, /action="\/item\/WI-003\/approve\?returnTo=%2Fmissions"/);
  assert.match(html, /action="\/item\/WI-003\/reject\?returnTo=%2Fmissions"/);
  assert.match(html, /action="\/item\/WI-004\/accept\?returnTo=%2Fmissions"/);
  assert.ok(!html.includes('/item/WI-004/approve'));
});

test('renderMissions: a building row carries Stop (with confirm) + Escalate forms', () => {
  const html = renderMissions(fold(sampleLedger()), NOW);
  assert.match(html, /action="\/item\/WI-002\/stop\?returnTo=%2Fmissions"/);
  assert.match(html, /data-opsui-confirm="Stop this build\?/);
  assert.match(html, /action="\/item\/WI-002\/escalate\?returnTo=%2Fmissions"/);
});

test('renderMissions: a queued row carries Hold + Escalate forms', () => {
  const html = renderMissions(fold(sampleLedger()), NOW);
  assert.match(html, /action="\/item\/WI-001\/hold\?returnTo=%2Fmissions"/);
  assert.match(html, /action="\/item\/WI-001\/escalate\?returnTo=%2Fmissions"/);
});

test('renderMissions: a held (parkKind hold) row carries only a Resume form', () => {
  const events = [
    ...queuedItem('WI-501'),
    makeEvent('cli', 'WI-501', 'item.parked', { reason: 'held by operator', parkKind: 'hold' }, '2026-07-01T09:04:00.000Z'),
  ];
  const html = renderMissions(fold(events), NOW);
  assert.match(html, /action="\/item\/WI-501\/resume\?returnTo=%2Fmissions"/);
  assert.ok(!html.includes('/item/WI-501/requeue'));
  assert.ok(!html.includes('/item/WI-501/dismiss'));
});

test('renderMissions: an ops-parked row carries Requeue now + Dismiss (with confirm) forms', () => {
  const events = [
    ...queuedItem('WI-601'),
    makeEvent('dispatch', 'WI-601', 'item.parked', { reason: 'infra: no commit', parkKind: 'ops' }, '2026-07-01T09:04:00.000Z'),
  ];
  const html = renderMissions(fold(events), NOW);
  assert.match(html, /action="\/item\/WI-601\/requeue\?returnTo=%2Fmissions"/);
  assert.match(html, /action="\/item\/WI-601\/dismiss\?returnTo=%2Fmissions"/);
  assert.match(html, /data-opsui-confirm="Dismiss this item\?/);
  assert.ok(!html.includes('/item/WI-601/resume'));
});

test('renderMissions: a Stop confirm names co-batched siblings sharing the same worktree', () => {
  const events = [
    makeEvent('cli', 'WI-701', 'item.captured', { source: 'cli', text: 'a' }, '2026-07-01T09:00:00.000Z'),
    makeEvent('reactor', 'WI-701', 'item.queued', { spec: 'a' }, '2026-07-01T09:01:00.000Z'),
    makeEvent('dispatch', 'WI-701', 'build.dispatched', { attempt: 1, worktree: '/wt/shared' }, '2026-07-01T09:02:00.000Z'),
    makeEvent('cli', 'WI-702', 'item.captured', { source: 'cli', text: 'b' }, '2026-07-01T09:00:00.000Z'),
    makeEvent('reactor', 'WI-702', 'item.queued', { spec: 'b' }, '2026-07-01T09:01:00.000Z'),
    makeEvent('dispatch', 'WI-702', 'build.dispatched', { attempt: 1, worktree: '/wt/shared' }, '2026-07-01T09:02:00.000Z'),
  ];
  const html = renderMissions(fold(events), NOW);
  assert.match(html, /data-opsui-confirm="Stop this build\? It shares a worktree with WI-702/);
});

test('renderMissions: escapes hostile source text (no raw <script> reaches the output)', () => {
  const result = fold(hostileLedger());
  const html = renderMissions(result, NOW);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /&lt;script&gt;/);
});

/** captured -> routed -> queued -> dispatched -> gate.passed -> merged, no code changes —
 *  a bare merged item (Missions "merged" lane, Acceptance "auto" tier). `ts` drives the merge
 *  transition time, so a batch of these sorts deterministically newest-first. */
function mergedItem(id: string, ts: string): LedgerEvent[] {
  return [
    ...queuedItem(id),
    makeEvent('dispatch', id, 'build.dispatched', { attempt: 1 }, ts),
    makeEvent('dispatch', id, 'gate.passed', { tests: 'green' }, ts),
    makeEvent('reactor', id, 'item.merged', { commit: `${id}sha` }, ts),
  ];
}

test('renderMissions: the merged lane paginates independently via ?lanePage_merged_awaiting_acceptance=', () => {
  const events = Array.from({ length: 11 }, (_, i) =>
    mergedItem(`WI-8${String(i).padStart(2, '0')}`, `2026-07-03T09:${String(i).padStart(2, '0')}:00.000Z`),
  ).flat();
  const result = fold(events);
  const page1 = renderMissions(result, LATER_NOW, [], new URL('http://localhost/missions'));
  const lanePage1 = cardScope(page1, 'Merged (awaiting acceptance) (11)', 'Accepted / terminal');
  // Page size 10, newest-merged-first: WI-810 (last/newest) shows, WI-800 (oldest) doesn't.
  assert.match(lanePage1, /WI-810/);
  assert.ok(!lanePage1.includes('WI-800'));
  assert.match(page1, /href="\/missions\?lanePage_merged_awaiting_acceptance=2"/);

  const page2 = renderMissions(result, LATER_NOW, [], new URL('http://localhost/missions?lanePage_merged_awaiting_acceptance=2'));
  const lanePage2 = cardScope(page2, 'Merged (awaiting acceptance) (11)', 'Accepted / terminal');
  assert.match(lanePage2, /WI-800/);
  assert.ok(!lanePage2.includes('WI-810'));
});

// ---------------------------------------------------------------------------
// "Why isn't this building?" card — read-only dispatch diagnosis for queued/parked items.
// ---------------------------------------------------------------------------

/** captured -> routed -> queued (with optional touches), one item. */
function queuedItem(id: string, touches?: string): LedgerEvent[] {
  return [
    makeEvent('cli', id, 'item.captured', { source: 'cli', text: `work on ${id}` }, '2026-07-01T09:00:00.000Z'),
    makeEvent('reactor', id, 'item.routed', { route: 'build', reply: 'queuing' }, '2026-07-01T09:01:00.000Z'),
    makeEvent('reactor', id, 'item.queued', { spec: `work on ${id}`, touches }, '2026-07-01T09:02:00.000Z'),
  ];
}

/** Same as queuedItem, plus a build.dispatched — leaves the item 'building'. */
function buildingItem(id: string, touches?: string): LedgerEvent[] {
  return [
    ...queuedItem(id, touches),
    makeEvent('dispatch', id, 'build.dispatched', { attempt: 1 }, '2026-07-01T09:03:00.000Z'),
  ];
}

test('renderMissions: a queued item whose touches overlap an in-flight build shows the touches-conflict diagnosis', () => {
  const events = [
    ...buildingItem('WI-102', 'packages/console'),
    ...queuedItem('WI-101', 'packages/console/src/views.ts'),
  ];
  const html = renderMissions(fold(events), NOW);
  assert.match(html, /Why isn&#39;t this building\?/);
  assert.match(html, /Touches conflict with in-flight WI-102/);
});

test('renderMissions: a touches-less queued item behind an in-flight build shows the lane-serialized diagnosis', () => {
  const events = [
    ...buildingItem('WI-202', 'packages/core'),
    ...queuedItem('WI-201'), // no declared touches
  ];
  const html = renderMissions(fold(events), NOW);
  assert.match(html, /Lane-serialized — no declared touches/);
});

test('renderMissions: a queued item with disjoint touches from every in-flight build shows the runnable diagnosis', () => {
  const events = [
    ...buildingItem('WI-302', 'packages/beta'),
    ...queuedItem('WI-301', 'packages/alpha'),
  ];
  const html = renderMissions(fold(events), NOW);
  assert.match(html, /Runnable — no touches conflict, waiting for a free dispatch slot\./);
});

test('renderMissions: a queued item with no in-flight builds at all shows the runnable diagnosis', () => {
  const html = renderMissions(fold(queuedItem('WI-401')), NOW);
  assert.match(html, /Runnable — no touches conflict, waiting for a free dispatch slot\./);
});

test('renderMissions: the "Why isn\'t this building?" card surfaces parkReason/parkKind/parkFingerprint/parkNovelty for parked items', () => {
  const html = renderMissions(fold(sampleLedger()), NOW);
  assert.match(html, /Parked: touches a public API boundary/);
  assert.match(html, /evidence__key">Kind<\/span><span class="evidence__val">decision/);
  assert.match(html, /evidence__key">Fingerprint<\/span><span class="evidence__val">[0-9a-f]+/);
  assert.match(html, /evidence__key">Novelty<\/span><span class="evidence__val">first-seen/);
});

test('renderMissions: the "Why isn\'t this building?" card is absent with nothing queued or parked', () => {
  const html = renderMissions(fold([]), NOW);
  assert.ok(!html.includes("Why isn&#39;t this building?"));
});

// ---------------------------------------------------------------------------
// unblockNote — per-parkKind unblock message, shared verbatim by the ops-parks card,
// the Missions parked lane, and the why-not-building card (all via itemMetadata).
// ---------------------------------------------------------------------------

test('unblockNote: returns the per-parkKind message', () => {
  assert.equal(unblockNote('decision', undefined), 'Approve or reject below');
  assert.equal(unblockNote('hold', undefined), 'Resume when ready');
  assert.equal(unblockNote('ops', undefined), 'Auto-retries; escalates on breaker');
  assert.equal(unblockNote(undefined, undefined), undefined);
  assert.equal(unblockNote('bogus', undefined), undefined);
});

test('unblockNote: decomposition parses the successor WI id once from parkReason', () => {
  assert.equal(
    unblockNote('decomposition', 'queued for planner decomposition as WI-042'),
    'Waiting on planner → WI-042',
  );
  assert.equal(unblockNote('decomposition', 'no successor mentioned yet'), 'Waiting on planner');
});

test('renderMissions: the parked lane, ops-parks-shaped rows, and the why-not-building card all show the same unblock note', () => {
  const events = [
    ...queuedItem('WI-801'),
    makeEvent('dispatch', 'WI-801', 'item.parked', { reason: 'infra: no commit', parkKind: 'ops' }, '2026-07-01T09:04:00.000Z'),
  ];
  const html = renderMissions(fold(events), NOW);
  const occurrences = html.split('Auto-retries; escalates on breaker').length - 1;
  // Once in the Parked lane row, once in the why-not-building card's parked row.
  assert.equal(occurrences, 2);
});

test('renderMissions: a decomposition-parked epic shows "Waiting on planner → <successor>" in its metadata', () => {
  const events = [
    ...queuedItem('WI-901'),
    makeEvent('reactor', 'WI-901', 'item.parked', { reason: 'queued for planner decomposition as WI-902', parkKind: 'decomposition' }, '2026-07-01T09:04:00.000Z'),
  ];
  const html = renderMissions(fold(events), NOW);
  assert.match(html, /Waiting on planner → WI-902/);
});

// ---------------------------------------------------------------------------
// View — Item timeline (/item/<id>)
// ---------------------------------------------------------------------------

test('renderItemTimeline: known item renders its events in chronological order', () => {
  const events = sampleLedger();
  const result = fold(events);
  const html = renderItemTimeline('WI-002', result.items.get('WI-002'), events);

  assert.match(html, /WI-002/);
  assert.match(html, /item\.captured/);
  assert.match(html, /build\.dispatched/);
  const capturedIdx = html.indexOf('item.captured');
  const dispatchedIdx = html.indexOf('build.dispatched');
  assert.ok(capturedIdx > -1 && dispatchedIdx > -1 && capturedIdx < dispatchedIdx);
});

test('renderItemTimeline: the raw event log renders each event through the shared EventRow component, with actor + local timestamp as metadata', () => {
  const events = sampleLedger();
  const result = fold(events);
  const html = renderItemTimeline('WI-002', result.items.get('WI-002'), events);

  assert.match(html, /class="opsui-eventrow opsui-eventrow--neutral"/);
  // Actor and a local-clock rendering of the event's ts both appear as metadata chips.
  assert.match(html, /<span class="opsui-eventrow__metaitem">cli<\/span>/);
  assert.match(html, new RegExp(`<span class="opsui-eventrow__metaitem">${new Date('2026-07-01T10:00:00.000Z').toLocaleString().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</span>`));
});

test('renderItemTimeline: event-family colour mapping — captures/routing neutral, messages progress, gate/merge/deploy by outcome, parks critical', () => {
  const events: LedgerEvent[] = [
    makeEvent('cli', 'WI-700', 'item.captured', { source: 'cli', text: 'demo' }, '2026-07-01T09:00:00.000Z'),
    makeEvent('reactor', 'WI-700', 'item.routed', { route: 'build', reply: 'queuing' }, '2026-07-01T09:01:00.000Z'),
    makeEvent('reactor', 'WI-700', 'item.queued', { spec: 'demo' }, '2026-07-01T09:02:00.000Z'),
    makeEvent('operator', 'WI-700', 'msg.in', { text: 'any update?' }, '2026-07-01T09:03:00.000Z'),
    makeEvent('reactor', 'WI-700', 'msg.out', { text: 'still building' }, '2026-07-01T09:04:00.000Z'),
    makeEvent('dispatch', 'WI-700', 'gate.passed', { tests: 'green' }, '2026-07-01T09:05:00.000Z'),
    makeEvent('dispatch', 'WI-700', 'gate.failed', { reason: 'tests red' }, '2026-07-01T09:06:00.000Z'),
    makeEvent('reactor', 'WI-700', 'item.merged', { commit: 'abc1234' }, '2026-07-01T09:07:00.000Z'),
    makeEvent('reactor', 'WI-700', 'deploy.succeeded', { commit: 'abc1234' }, '2026-07-01T09:08:00.000Z'),
    makeEvent('reactor', 'WI-700', 'deploy.failed', { reason: 'rollback' }, '2026-07-01T09:09:00.000Z'),
    makeEvent('conductor', 'WI-700', 'item.parked', { reason: 'ambiguous scope', parkKind: 'decision' }, '2026-07-01T09:10:00.000Z'),
  ];
  const result = fold(events);
  const html = renderItemTimeline('WI-700', result.items.get('WI-700'), events);

  const rowFor = (type: string) => {
    const start = html.indexOf(`opsui-eventrow__title">${type}<`);
    assert.ok(start > -1, `expected a rendered row for ${type}`);
    const articleStart = html.lastIndexOf('<article', start);
    return html.slice(articleStart, html.indexOf('</article>', start) + '</article>'.length);
  };

  for (const type of ['item.captured', 'item.routed', 'item.queued']) {
    assert.match(rowFor(type), /opsui-eventrow--neutral/, `${type} should be neutral`);
  }
  for (const type of ['msg.in', 'msg.out']) {
    assert.match(rowFor(type), /opsui-eventrow--progress/, `${type} should be progress`);
  }
  assert.match(rowFor('gate.passed'), /opsui-eventrow--success/);
  assert.match(rowFor('item.merged'), /opsui-eventrow--success/);
  assert.match(rowFor('deploy.succeeded'), /opsui-eventrow--success/);
  assert.match(rowFor('gate.failed'), /opsui-eventrow--critical/);
  assert.match(rowFor('deploy.failed'), /opsui-eventrow--critical/);
  assert.match(rowFor('item.parked'), /opsui-eventrow--critical/);
});

test('renderItemTimeline: summarizeEventData prefers human payload fields as labeled phrases, falling back to key=value only when none are present', () => {
  const longText = 'x'.repeat(250);
  const events: LedgerEvent[] = [
    makeEvent('cli', 'WI-701', 'item.captured', { source: 'cli', text: longText }, '2026-07-01T09:00:00.000Z'),
    makeEvent('reactor', 'WI-701', 'item.routed', { route: 'build', reply: 'queuing now' }, '2026-07-01T09:01:00.000Z'),
    makeEvent('reactor', 'WI-701', 'item.queued', { spec: 'add a thing', priority: 'high', touches: 'src/x.ts' }, '2026-07-01T09:02:00.000Z'),
    makeEvent('dispatch', 'WI-701', 'build.dispatched', { attempt: 2, worktree: '/tmp/wt' }, '2026-07-01T09:03:00.000Z'),
  ];
  const result = fold(events);
  const html = renderItemTimeline('WI-701', result.items.get('WI-701'), events);

  // `text` renders as a labeled phrase, truncated generously (200 chars) rather than the old 60.
  assert.match(html, /Text: x{200}…/);
  assert.ok(!html.includes('x'.repeat(201)));
  // `reply` beats `route` when an item.routed event carries both.
  assert.match(html, /Reply: queuing now/);
  assert.ok(!html.includes('route=build'));
  // `spec` beats `priority`/`touches` on item.queued.
  assert.match(html, /Spec: add a thing/);
  assert.ok(!html.includes('priority=high'));
  // No human field on build.dispatched (just attempt/worktree) — falls back to key=value.
  assert.match(html, /attempt=2/);
});

test('renderItemTimeline: unknown item renders a "no such item" message, not a crash', () => {
  const events = sampleLedger();
  const result = fold(events);
  const html = renderItemTimeline('WI-999', result.items.get('WI-999'), events);
  assert.match(html, /No such item/);
});

test('renderItemTimeline: a parked (decision) item renders approve + reject forms', () => {
  const events = sampleLedger();
  const result = fold(events);
  const html = renderItemTimeline('WI-003', result.items.get('WI-003'), events);
  assert.match(html, /action="\/item\/WI-003\/approve\?returnTo=/);
  assert.match(html, /action="\/item\/WI-003\/reject\?returnTo=/);
});

test('renderItemTimeline: a merged item renders an accept form, not approve/reject', () => {
  const events = sampleLedger();
  const result = fold(events);
  const html = renderItemTimeline('WI-004', result.items.get('WI-004'), events);
  assert.match(html, /action="\/item\/WI-004\/accept\?returnTo=/);
  assert.ok(!html.includes('/item/WI-004/approve'));
});

test('renderItemTimeline: a building item renders Stop + Escalate run-control forms', () => {
  const events = sampleLedger();
  const result = fold(events);
  const html = renderItemTimeline('WI-002', result.items.get('WI-002'), events);
  assert.match(html, /Run controls/);
  assert.match(html, /action="\/item\/WI-002\/stop\?returnTo=/);
  assert.match(html, /action="\/item\/WI-002\/escalate\?returnTo=/);
});

test('renderItemTimeline: a queued item renders Hold + Escalate run-control forms', () => {
  const events = sampleLedger();
  const result = fold(events);
  const html = renderItemTimeline('WI-001', result.items.get('WI-001'), events);
  assert.match(html, /action="\/item\/WI-001\/hold\?returnTo=/);
  assert.match(html, /action="\/item\/WI-001\/escalate\?returnTo=/);
});

test('renderItemTimeline: a held item renders a Resume run-control form', () => {
  const events = [
    ...queuedItem('WI-501'),
    makeEvent('cli', 'WI-501', 'item.parked', { reason: 'held by operator', parkKind: 'hold' }, '2026-07-01T09:04:00.000Z'),
  ];
  const result = fold(events);
  const html = renderItemTimeline('WI-501', result.items.get('WI-501'), events, undefined, result);
  assert.match(html, /action="\/item\/WI-501\/resume\?returnTo=/);
});

test('renderItemTimeline: an ops-parked item renders Requeue now + Dismiss run-control forms', () => {
  const events = [
    ...queuedItem('WI-601'),
    makeEvent('dispatch', 'WI-601', 'item.parked', { reason: 'infra: no commit', parkKind: 'ops' }, '2026-07-01T09:04:00.000Z'),
  ];
  const result = fold(events);
  const html = renderItemTimeline('WI-601', result.items.get('WI-601'), events, undefined, result);
  assert.match(html, /action="\/item\/WI-601\/requeue\?returnTo=/);
  assert.match(html, /action="\/item\/WI-601\/dismiss\?returnTo=/);
});

test('renderItemTimeline: a merged item renders a "Found a problem" feedback form alongside accept', () => {
  const events = sampleLedger();
  const result = fold(events);
  const html = renderItemTimeline('WI-004', result.items.get('WI-004'), events);
  assert.match(html, /action="\/item\/WI-004\/feedback\?returnTo=/);
  assert.match(html, /placeholder="Found a problem with WI-004\? Describe it…"/);
  assert.match(html, />Found a problem</);
});

test('renderItemTimeline: an already-accepted (terminal) item renders no verb forms', () => {
  const events = sampleLedger();
  const result = fold(events);
  const html = renderItemTimeline('WI-005', result.items.get('WI-005'), events);
  assert.ok(!html.includes('opsui-eventrow__actionform'));
});

test('renderItemTimeline: escapes hostile event data in the summary line', () => {
  const events = hostileLedger();
  const result = fold(events);
  const html = renderItemTimeline('WI-900', result.items.get('WI-900'), events);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /&lt;script&gt;/);
});

test('renderItemTimeline: renders the full thread — newest first, with a reply form', () => {
  const events = [...sampleLedger(), ...threadMessages('WI-002', 2, '2026-07-01T10:30:00.000Z')];
  const result = fold(events);
  const html = renderItemTimeline('WI-002', result.items.get('WI-002'), events, NOW, result);

  assert.match(html, /Thread/);
  // Scope the ordering check to the thread card itself — the raw event-log timeline above it
  // also mentions "msg 1"/"msg 2" (oldest-first, by design), which would otherwise confuse indexOf.
  const threadHtml = html.slice(html.indexOf('class="thread-card"'));
  assert.ok(threadHtml.indexOf('msg 2') < threadHtml.indexOf('msg 1'));
  assert.match(html, /<form method="post" action="\/item\/WI-002\/reply\?returnTo=%2Fitem%2FWI-002"/);
});

test('renderItemTimeline: the full thread paginates via ?threadsPage=', () => {
  const events = [...sampleLedger(), ...threadMessages('WI-002', 11, '2026-07-01T10:30:00.000Z')];
  const result = fold(events);
  const url = new URL('http://localhost/item/WI-002');
  const page1 = renderItemTimeline('WI-002', result.items.get('WI-002'), events, NOW, result, undefined, url);
  // Full-thread page size is 10 — the 11th (oldest, "msg 1") spills to page 2.
  assert.match(page1, /msg 11/);
  assert.ok(!page1.includes('>msg 1<'));
  assert.match(page1, /href="\/item\/WI-002\?threadsPage=2"/);

  const page2 = renderItemTimeline('WI-002', result.items.get('WI-002'), events, NOW, result, undefined, new URL('http://localhost/item/WI-002?threadsPage=2'));
  assert.match(page2, />msg 1</);
});

test('renderItemTimeline: a conversation that spawned the item shows its lead-in messages in the same thread', () => {
  const events = [
    ...sampleLedger(),
    makeEvent('operator', 'CONV-001', 'conv.started', { source: 'console' }, '2026-07-01T10:50:00.000Z'),
    makeEvent('operator', 'CONV-001', 'msg.in', { text: 'the conversation lead-in' }, '2026-07-01T10:50:01.000Z'),
    makeEvent('reactor', 'CONV-001', 'conv.promoted', { items: ['WI-002'] }, '2026-07-01T10:50:02.000Z'),
  ];
  const result = fold(events);
  const html = renderItemTimeline('WI-002', result.items.get('WI-002'), events, NOW, result);
  assert.match(html, /the conversation lead-in/);
});

test('renderItemTimeline: escapes hostile text typed into a reply', () => {
  const events = [
    ...sampleLedger(),
    makeEvent('operator', 'WI-002', 'msg.in', { text: '<script>alert(2)</script>' }, '2026-07-01T10:31:00.000Z'),
  ];
  const result = fold(events);
  const html = renderItemTimeline('WI-002', result.items.get('WI-002'), events, NOW, result);
  assert.ok(!html.includes('<script>alert(2)</script>'));
  assert.match(html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
});

test('renderItemTimeline: the summary card shows state, lane, target, touches, model, attempts, and timestamps', () => {
  const events = [
    makeEvent('cli', 'WI-050', 'item.captured', { source: 'cli', text: 'add caching layer', target: 'demo' }, '2026-07-01T08:00:00.000Z'),
    makeEvent('reactor', 'WI-050', 'item.routed', { route: 'build', reply: 'queuing' }, '2026-07-01T08:01:00.000Z'),
    makeEvent('reactor', 'WI-050', 'item.queued', { spec: 'add caching layer', touches: 'packages/core/src/cache.ts', model: 'sonnet' }, '2026-07-01T08:02:00.000Z'),
    makeEvent('dispatch', 'WI-050', 'build.dispatched', { attempt: 1 }, '2026-07-01T08:03:00.000Z'),
  ];
  const result = fold(events);
  const html = renderItemTimeline('WI-050', result.items.get('WI-050'), events, NOW);

  assert.match(html, /Summary/);
  assert.match(html, /<span class="evidence__key">State<\/span><span class="evidence__val">building<\/span>/);
  assert.match(html, /<span class="evidence__key">Target<\/span><span class="evidence__val">demo<\/span>/);
  assert.match(html, /<span class="evidence__key">Touches<\/span><span class="evidence__val">packages\/core\/src\/cache\.ts<\/span>/);
  assert.match(html, /<span class="evidence__key">Model<\/span><span class="evidence__val">sonnet<\/span>/);
  assert.match(html, /<span class="evidence__key">Attempts<\/span><span class="evidence__val">1<\/span>/);
  assert.match(html, /<span class="evidence__key">Created<\/span><span class="evidence__val">2026-07-01T08:00:00\.000Z<\/span>/);
  assert.match(html, /<span class="evidence__key">Updated<\/span><span class="evidence__val">2026-07-01T08:03:00\.000Z<\/span>/);
  // Summary card sits above the raw timeline.
  assert.ok(html.indexOf('>Summary<') < html.indexOf('>Timeline<'));
});

test('renderItemTimeline: the summary card surfaces the live park kind', () => {
  const events = sampleLedger();
  const result = fold(events);
  const html = renderItemTimeline('WI-003', result.items.get('WI-003'), events, NOW);
  assert.match(html, /<span class="evidence__key">Park kind<\/span><span class="evidence__val">decision<\/span>/);
});

test('renderItemTimeline: the summary card surfaces the scout brief as a collapsed details block', () => {
  const events = [...sampleLedger(), makeEvent('dispatch', 'WI-002', 'item.briefed', { brief: 'branch point: cache invalidation lives in fold.ts' }, '2026-07-01T10:04:00.000Z')];
  const result = fold(events);
  const html = renderItemTimeline('WI-002', result.items.get('WI-002'), events, NOW);
  assert.match(html, /<details class="evidence__details"><summary>Scout brief/);
  assert.match(html, /branch point: cache invalidation lives in fold\.ts/);
});

test('renderItemTimeline: no scout brief renders no details block', () => {
  const events = sampleLedger();
  const result = fold(events);
  const html = renderItemTimeline('WI-002', result.items.get('WI-002'), events, NOW);
  assert.ok(!html.includes('evidence__details'));
});

test('renderItemTimeline: escapes a hostile scout brief in the summary card', () => {
  const payload = '<script>alert(1)</script>&"\'';
  const events = [...sampleLedger(), makeEvent('dispatch', 'WI-002', 'item.briefed', { brief: payload }, '2026-07-01T10:04:00.000Z')];
  const result = fold(events);
  const html = renderItemTimeline('WI-002', result.items.get('WI-002'), events, NOW);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /&lt;script&gt;/);
});

test('renderItemTimeline: the summary card reads "not deployed" with no deploy signal at all', () => {
  const events = sampleLedger();
  const result = fold(events);
  const html = renderItemTimeline('WI-002', result.items.get('WI-002'), events, NOW);
  assert.match(html, /<span class="evidence__key">Deploy<\/span><span class="evidence__val">not deployed<\/span>/);
});

test('renderItemTimeline: the deploy receipt reports "deployed <sha>" from a deploy.succeeded event', () => {
  const events = [
    ...sampleLedger(),
    makeEvent('deploy-hook', 'WI-004', 'deploy.succeeded', { commit: 'deadbee1' }, '2026-07-01T12:30:00.000Z'),
  ];
  const result = fold(events);
  const html = renderItemTimeline('WI-004', result.items.get('WI-004'), events, NOW);
  assert.match(html, /<span class="evidence__key">Deploy<\/span><span class="evidence__val">deployed deadbee1<\/span>/);
});

test('renderItemTimeline: a later deploy.failed supersedes an earlier deploy.succeeded — latest wins', () => {
  const events = [
    ...sampleLedger(),
    makeEvent('deploy-hook', 'WI-004', 'deploy.succeeded', { commit: 'deadbee1' }, '2026-07-01T12:30:00.000Z'),
    makeEvent('deploy-hook', 'WI-004', 'deploy.failed', { reason: 'health check timed out' }, '2026-07-01T12:35:00.000Z'),
  ];
  const result = fold(events);
  const html = renderItemTimeline('WI-004', result.items.get('WI-004'), events, NOW);
  assert.match(html, /<span class="evidence__key">Deploy<\/span><span class="evidence__val">deploy failed — health check timed out<\/span>/);
});

test('renderItemTimeline: the Evidence card lists this item\'s artifacts as download links, newest first', () => {
  const events = sampleLedger();
  const result = fold(events);
  const artifacts: ArtifactEntry[] = [
    { itemId: 'WI-002', attempt: 1, kind: 'Build log', filename: 'WI-002-attempt-1.log', targetSeg: '_', mtimeMs: 1000 },
    { itemId: 'WI-002', attempt: 2, kind: 'Gate log', filename: 'WI-002-attempt-2.gate.log', targetSeg: '_', mtimeMs: 2000 },
  ];
  const html = renderItemTimeline('WI-002', result.items.get('WI-002'), events, NOW, result, undefined, undefined, artifacts);
  assert.match(html, /Evidence/);
  const first = html.indexOf('WI-002-attempt-2.gate.log');
  const second = html.indexOf('WI-002-attempt-1.log');
  assert.ok(first > -1 && second > -1 && first < second, 'newest attempt should list first');
  assert.match(html, /<a href="\/artifact\/_\/WI-002-attempt-2\.gate\.log" download>WI-002 attempt 2 — Gate log<\/a>/);
});

test('renderItemTimeline: the Evidence card only lists artifacts scoped to this item', () => {
  const events = sampleLedger();
  const result = fold(events);
  const artifacts: ArtifactEntry[] = [
    { itemId: 'WI-002', attempt: 1, kind: 'Build log', filename: 'WI-002-attempt-1.log', targetSeg: '_', mtimeMs: 1000 },
    { itemId: 'WI-003', attempt: 1, kind: 'Build log', filename: 'WI-003-attempt-1.log', targetSeg: '_', mtimeMs: 1500 },
  ];
  const html = renderItemTimeline('WI-002', result.items.get('WI-002'), events, NOW, result, undefined, undefined, artifacts);
  assert.match(html, /WI-002-attempt-1\.log/);
  assert.ok(!html.includes('WI-003-attempt-1.log'));
});

test('renderItemTimeline: the Evidence card renders an empty state with no artifacts', () => {
  const events = sampleLedger();
  const result = fold(events);
  const html = renderItemTimeline('WI-002', result.items.get('WI-002'), events, NOW);
  assert.match(html, /No artifacts yet/);
});

// ---------------------------------------------------------------------------
// View — Acceptance desk (/acceptance)
// ---------------------------------------------------------------------------

test('renderAcceptance: classifies merged items and puts must/review on the waiting desk', () => {
  const result = fold(tieredMergeLedger());
  const html = renderAcceptance(result, BARE_TIER_CFG, LATER_NOW);

  assert.match(html, /Acceptance/);
  // WI-101 has no changed files → auto; WI-104's judge verdict failed → must.
  assert.match(html, /WI-101/);
  assert.match(html, /WI-104/);
  assert.match(html, /Waiting on your test/);
  assert.match(html, /Lower priority/);
});

test('renderAcceptance: a surface prefix promotes a merge to the review tier, onto the waiting desk', () => {
  const result = fold(tieredMergeLedger());
  const html = renderAcceptance(result, SURFACE_TIER_CFG, LATER_NOW);
  // WI-103 touches packages/console/ — declared a surface in SURFACE_TIER_CFG → review, which
  // lands in "Waiting on your test", not the collapsed "Lower priority" region.
  const waiting = sliceBetween(html, '<h3 class="opsui-card__title">Waiting on your test</h3>', '<details class="opsui-acceptance__collapse">');
  assert.match(waiting, /WI-103/);
  assert.match(waiting, /opsui-status--warning/);
});

test('renderAcceptance: renders merge evidence (sha range, gate command, changed files) per item', () => {
  const result = fold(tieredMergeLedger());
  const html = renderAcceptance(result, BARE_TIER_CFG, LATER_NOW);

  assert.match(html, /1111111111111111111111111111111111aaaa\.\.2222222222222222222222222222222222bbbb/);
  assert.match(html, /npm test --workspace=@loopkit\/core/);
  assert.match(html, /packages\/core\/src\/helpers\.ts/);
});

test('renderAcceptance: surfaces the same deploy receipt row inside the evidence block', () => {
  const events = [
    ...tieredMergeLedger(),
    makeEvent('deploy-hook', 'WI-102', 'deploy.succeeded', { commit: 'bbb2222' }, '2026-07-03T10:10:00.000Z'),
  ];
  const result = fold(events);
  const html = renderAcceptance(result, BARE_TIER_CFG, LATER_NOW, events);
  assert.match(html, /<span class="evidence__key">Deploy<\/span><span class="evidence__val">deployed bbb2222<\/span>/);
  // WI-101 merged with no deploy signal at all — reads "not deployed", not a crash.
  assert.match(html, /<span class="evidence__key">Deploy<\/span><span class="evidence__val">not deployed<\/span>/);
});

test('renderAcceptance: each merged item carries an accept form', () => {
  const result = fold(tieredMergeLedger());
  const html = renderAcceptance(result, BARE_TIER_CFG, LATER_NOW);
  assert.match(html, /action="\/item\/WI-101\/accept\?returnTo=%2Facceptance"/);
  assert.match(html, /action="\/item\/WI-102\/accept\?returnTo=%2Facceptance"/);
});

test('renderAcceptance: each merged item carries a "Found a problem" feedback form', () => {
  const result = fold(tieredMergeLedger());
  const html = renderAcceptance(result, BARE_TIER_CFG, LATER_NOW);
  assert.match(html, /action="\/item\/WI-101\/feedback\?returnTo=%2Facceptance"/);
  assert.match(html, /action="\/item\/WI-102\/feedback\?returnTo=%2Facceptance"/);
});

test('renderAcceptance: summarizes the must/review backlog in a page header', () => {
  const result = fold(tieredMergeLedger());
  const html = renderAcceptance(result, BARE_TIER_CFG, LATER_NOW);
  // WI-104 is the only must/review row under BARE_TIER_CFG (judge fail → must); merged at
  // 2026-07-03T12:05, LATER_NOW is 2026-07-04T00:00 → 11h55m old, so the ageLabel reads "11h".
  assert.match(html, /1 awaiting your verdict · oldest 11h/);
});

test('renderAcceptance: no merged items renders an intentional empty state, no crash', () => {
  const html = renderAcceptance(fold(sampleLedger().filter((e) => e.item !== 'WI-004' && e.item !== 'WI-005')), BARE_TIER_CFG, NOW);
  assert.match(html, /Acceptance/);
  assert.match(html, /Nothing awaiting acceptance/);
});

test('renderAcceptance: escapes hostile event data reaching the evidence block', () => {
  const events = hostileLedger();
  const result = fold([...tieredMergeLedger(), ...events]);
  const html = renderAcceptance(result, BARE_TIER_CFG, LATER_NOW);
  assert.ok(!html.includes('<script>alert(1)</script>'));
});

// ---------------------------------------------------------------------------
// Acceptance desk — attended-mode refit (WI-049): glance strip, a single always-visible
// "Waiting on your test" region (must+review, oldest first), one collapsed "Lower priority"
// region (optional+auto), target filter chips, and no wall-clock countdowns anywhere (attended
// mode has no auto-accept — WI-046's countdown was a build-loop leftover).
// ---------------------------------------------------------------------------

test('renderAcceptance: the glance strip renders "to test" and "low-priority" tiles', () => {
  const result = fold(tieredMergeLedger());
  const html = renderAcceptance(result, BARE_TIER_CFG, LATER_NOW);
  // BARE_TIER_CFG: WI-104 (must) waits; WI-101/102/103 (auto/optional/optional) are low-priority.
  const glance = cardScope(html, 'Acceptance', 'Waiting on your test');
  assert.match(glance, /opsui-metric__label">To test</);
  assert.match(glance, /opsui-metric__value">1</);
  assert.match(glance, /opsui-metric__label">Low-priority</);
  assert.match(glance, /opsui-metric__value">3</);
});

test('renderAcceptance: the glance strip is empty-state safe with no merged items', () => {
  const html = renderAcceptance(fold(sampleLedger().filter((e) => e.item !== 'WI-004' && e.item !== 'WI-005')), BARE_TIER_CFG, NOW);
  const glance = cardScope(html, 'Acceptance', 'Nothing awaiting acceptance');
  assert.match(glance, /opsui-metric__label">To test</);
  assert.match(glance, /opsui-metric__value">0</);
  assert.match(glance, /opsui-metric__label">Oldest waiting</);
  assert.match(glance, /opsui-metric__value">—</);
});

test('renderAcceptance: "Waiting on your test" carries must\\/review and excludes optional\\/auto', () => {
  const result = fold(tieredMergeLedger());
  const html = renderAcceptance(result, BARE_TIER_CFG, LATER_NOW);
  const waiting = sliceBetween(html, '<h3 class="opsui-card__title">Waiting on your test</h3>', '<details class="opsui-acceptance__collapse">');
  // WI-104 (must, judge fail) belongs here.
  assert.match(waiting, /WI-104/);
  // WI-101 (auto) and WI-102 (optional) do not.
  assert.ok(!waiting.includes('WI-101'));
  assert.ok(!waiting.includes('WI-102'));
  assert.match(waiting, /opsui-status--warning.*1 to test/s);
});

test('renderAcceptance: "Waiting on your test" reads "Clear" at zero', () => {
  const html = renderAcceptance(fold(sampleLedger().filter((e) => e.item !== 'WI-004' && e.item !== 'WI-005')), BARE_TIER_CFG, NOW);
  // No merged items at all here, so the desk falls to the top-level empty state instead of
  // rendering the waiting/lower-priority regions — assert the page-level "nothing" framing.
  assert.match(html, /nothing awaiting your verdict/);
});

test('renderAcceptance: "Lower priority" collapses optional+auto into one <details>, summary states the count', () => {
  const result = fold(tieredMergeLedger());
  const html = renderAcceptance(result, BARE_TIER_CFG, LATER_NOW);
  assert.match(html, /<details class="opsui-acceptance__collapse"><summary>Lower priority — 3 · no auto-accept while attended<\/summary>/);
  const lower = sliceBetween(html, '<summary>Lower priority — 3 · no auto-accept while attended</summary>');
  assert.match(lower, /WI-101/);
  assert.match(lower, /WI-102/);
  assert.match(lower, /WI-103/);
  assert.ok(!lower.includes('WI-104'));
});

test('renderAcceptance: renders no wall-clock countdown anywhere (attended mode has no auto-accept)', () => {
  const result = fold(tieredMergeLedger());
  const html = renderAcceptance(result, BARE_TIER_CFG, LATER_NOW);
  assert.ok(!html.includes('auto-accepts in'));
  assert.ok(!html.includes('waiting on you — no auto-accept'));
});

test('renderAcceptance: target filter chips render All plus one per registered target, with per-chip counts', () => {
  const events = [
    { id: 'ev-t1', ts: '2026-07-01T00:00:00.000Z', actor: 'cli', item: 'loopkit', type: 'target.registered', data: { name: 'loopkit', repoPath: '/repo/loopkit', manifestHash: 'a'.repeat(40), defaultBranch: 'main' } },
    { id: 'ev-t2', ts: '2026-07-01T00:00:01.000Z', actor: 'cli', item: 'acme-web', type: 'target.registered', data: { name: 'acme-web', repoPath: '/repo/acme-web', manifestHash: 'b'.repeat(40), defaultBranch: 'main' } },
    ...tieredMergeLedger(),
  ];
  const result = fold(events);
  const html = renderAcceptance(result, BARE_TIER_CFG, LATER_NOW, [], new URL('http://localhost/acceptance'));
  assert.match(html, /role="group" aria-label="Filter by target"/);
  assert.match(html, /opsui-acceptance__filter-btn--active" href="\/acceptance" aria-current="true">All<span class="opsui-acceptance__filter-count">4<\/span>/);
  assert.match(html, />loopkit<span class="opsui-acceptance__filter-count">0<\/span>/);
  assert.match(html, />acme-web<span class="opsui-acceptance__filter-count">0<\/span>/);
  // tieredMergeLedger's items carry no `target` — they all fall into the unresolved "Other" bucket.
  assert.match(html, />Other<span class="opsui-acceptance__filter-count">4<\/span>/);
});

test('renderAcceptance: ?target=<name> filters the merged set before tier classification', () => {
  const captureWithTarget = (id: string, target: string, ts: string) => [
    makeEvent('cli', id, 'item.captured', { source: 'cli', text: `work on ${id}`, target }, ts),
    makeEvent('reactor', id, 'item.routed', { route: 'build', reply: 'queuing' }, ts),
    makeEvent('reactor', id, 'item.queued', { spec: `work on ${id}` }, ts),
    makeEvent('dispatch', id, 'build.dispatched', { attempt: 1 }, ts),
    makeEvent('dispatch', id, 'gate.passed', { tests: 'green' }, ts),
    makeEvent('reactor', id, 'item.merged', { commit: `${id}sha` }, ts),
  ];
  const events = [
    { id: 'ev-t1', ts: '2026-07-01T00:00:00.000Z', actor: 'cli', item: 'loopkit', type: 'target.registered', data: { name: 'loopkit', repoPath: '/repo/loopkit', manifestHash: 'a'.repeat(40), defaultBranch: 'main' } },
    { id: 'ev-t2', ts: '2026-07-01T00:00:01.000Z', actor: 'cli', item: 'acme-web', type: 'target.registered', data: { name: 'acme-web', repoPath: '/repo/acme-web', manifestHash: 'b'.repeat(40), defaultBranch: 'main' } },
    ...captureWithTarget('WI-900', 'loopkit', '2026-07-03T09:00:00.000Z'),
    ...captureWithTarget('WI-901', 'acme-web', '2026-07-03T09:05:00.000Z'),
  ];
  const result = fold(events);

  const all = renderAcceptance(result, BARE_TIER_CFG, LATER_NOW, [], new URL('http://localhost/acceptance'));
  assert.match(all, /WI-900/);
  assert.match(all, /WI-901/);

  const loopkitOnly = renderAcceptance(result, BARE_TIER_CFG, LATER_NOW, [], new URL('http://localhost/acceptance?target=loopkit'));
  assert.match(loopkitOnly, /WI-900/);
  assert.ok(!loopkitOnly.includes('WI-901'));
  assert.match(loopkitOnly, /opsui-acceptance__filter-btn--active" href="\/acceptance\?target=loopkit" aria-current="true">loopkit/);

  const acmeOnly = renderAcceptance(result, BARE_TIER_CFG, LATER_NOW, [], new URL('http://localhost/acceptance?target=acme-web'));
  assert.match(acmeOnly, /WI-901/);
  assert.ok(!acmeOnly.includes('WI-900'));
});

test('tierConfigFromLoopkitConfig: maps a LoopkitConfig-shaped object onto the classifier config', () => {
  const cfg = tierConfigFromLoopkitConfig({
    autoApprove: { planePrefixes: ['.loopkit/'], escalationPatterns: ['payment'] },
    acceptance: {
      tiers: {
        surfacePrefixes: ['packages/console/'],
        confidenceFloor: 0.8,
      },
    },
  });
  assert.deepEqual(cfg, {
    surfacePrefixes: ['packages/console/'],
    planePrefixes: ['.loopkit/'],
    riskPatterns: ['payment'],
    confidenceFloor: 0.8,
  });
});

test('tierConfigFromLoopkitConfig: tolerates a missing acceptance block', () => {
  const cfg = tierConfigFromLoopkitConfig({
    autoApprove: { planePrefixes: [], escalationPatterns: [] },
  });
  assert.deepEqual(cfg, {
    surfacePrefixes: [],
    planePrefixes: [],
    riskPatterns: [],
    confidenceFloor: undefined,
  });
});

// ---------------------------------------------------------------------------
// View — System (/system)
// ---------------------------------------------------------------------------

test('renderSystem: reports last-event age, segment sizes, and event counts by type', () => {
  const events = sampleLedger();
  const html = renderSystem(events, [{ name: 'work-2026-07.jsonl', bytes: 4096 }], NOW);

  assert.match(html, /System/);
  assert.match(html, /work-2026-07\.jsonl/);
  assert.match(html, /4,096 bytes|4096 bytes/);
  assert.match(html, /item\.captured/);
  assert.match(html, /Total events/);
});

test('renderSystem: empty ledger renders without crashing', () => {
  const html = renderSystem([], [], NOW);
  assert.match(html, /System/);
  assert.match(html, /No ledger activity yet/);
});

test('renderSystem: the Recent artifacts card lists every attempt\'s artifacts as download links, newest first', () => {
  const events = sampleLedger();
  const artifacts: ArtifactEntry[] = [
    { itemId: 'WI-002', attempt: 1, kind: 'Build log', filename: 'WI-002-attempt-1.log', targetSeg: '_', mtimeMs: 1000 },
    { itemId: 'WI-004', attempt: 1, kind: 'Diff', filename: 'WI-004-attempt-1.diff', targetSeg: 'tgt-abcd2345', mtimeMs: 2000 },
  ];
  const html = renderSystem(events, [], NOW, undefined, undefined, artifacts);
  assert.match(html, /Recent artifacts \(2\)/);
  const first = html.indexOf('WI-004-attempt-1.diff');
  const second = html.indexOf('WI-002-attempt-1.log');
  assert.ok(first > -1 && second > -1 && first < second, 'newest attempt should list first');
  assert.match(html, /<a href="\/artifact\/tgt-abcd2345\/WI-004-attempt-1\.diff" download>WI-004 attempt 1 — Diff<\/a>/);
});

test('renderSystem: the Recent artifacts card renders an empty state with no artifacts', () => {
  const html = renderSystem(sampleLedger(), [], NOW);
  assert.match(html, /No artifacts yet/);
});

// ---------------------------------------------------------------------------
// View — System: SLO rollup
// ---------------------------------------------------------------------------

test('renderSystem: SLO rollup leads the page with routing/backlog/heartbeat rows and a breached/at-risk summary', () => {
  const events = sampleLedger();
  const html = renderSystem(events, [{ name: 'work-2026-07.jsonl', bytes: 4096 }], NOW, 5);

  const rollupIdx = html.indexOf('SLO rollup');
  const segmentsIdx = html.indexOf('Segments (');
  assert.ok(rollupIdx > 0, 'SLO rollup card is present');
  assert.ok(rollupIdx < segmentsIdx, 'SLO rollup leads the page, before the Segments card');

  assert.match(html, /Intent routing latency/);
  assert.match(html, /reactor · routes \+ heals/);
  assert.match(html, /dispatch · builds/);
  assert.match(html, /Unrouted backlog/);
  assert.match(html, /Acceptance backlog/);
  assert.match(html, /Decisions waiting on operator/);
  assert.match(html, /\d+ breached · \d+ at-risk/);
});

test('renderSystem: SLO rollup reads beat heartbeats as unknown when the ledger has no reactor/dispatch actor events', () => {
  const events = [makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'first intent' }, '2026-07-01T09:00:00.000Z')];
  const html = renderSystem(events, [], NOW, 1);

  const rollupHtml = html.slice(html.indexOf('SLO rollup'), html.indexOf('Segments ('));
  assert.match(rollupHtml, /never ran/);
  assert.match(rollupHtml, /data-state="neutral"/);
});

test('renderSystem: a looser sloConfig threshold flips a breached beat-heartbeat row to met', () => {
  const events = sampleLedger();
  const systemUrl = new URL('http://localhost/system');
  const strictHtml = renderSystem(events, [], NOW, 5, undefined, [], systemUrl, {});
  const looseHtml = renderSystem(events, [], NOW, 5, undefined, [], systemUrl, { reactorFreshSec: 999_999_999 });

  const strictRow = strictHtml.slice(strictHtml.indexOf('reactor · routes'), strictHtml.indexOf('reactor · routes') + 300);
  const looseRow = looseHtml.slice(looseHtml.indexOf('reactor · routes'), looseHtml.indexOf('reactor · routes') + 300);
  assert.match(strictRow, /data-state="critical"/);
  assert.match(looseRow, /data-state="success"/);
});

// ---------------------------------------------------------------------------
// View — System: self-heal activity feed
// ---------------------------------------------------------------------------

/** sampleLedger plus one of each heal.* event: three inside the last 24h of NOW
 *  (2026-07-02T00:00Z), three older — exercises both the feed rows and the window filter. */
function healLedger(): LedgerEvent[] {
  return [
    ...sampleLedger(),
    // Older than 24h at NOW:
    makeEvent('reactor', 'system', 'heal.escalated', { key: 'backup', reason: 'still stale after retry', count: 3 }, '2026-06-25T10:00:00.000Z'),
    makeEvent('reactor', 'system', 'heal.graduated', { key: 'instances' }, '2026-06-28T10:00:00.000Z'),
    makeEvent('reactor', 'system', 'heal.shadowed', { key: 'launchd', action: 'bootstrap the missing job', wouldHave: 'auto-heal' }, '2026-06-30T10:00:00.000Z'),
    // Inside the last 24h at NOW:
    makeEvent('reactor', 'system', 'heal.proposed', { key: 'loop-dispatch', action: 'clear the wedged lock', tier: 'auto-heal' }, '2026-07-01T10:00:00.000Z'),
    makeEvent('reactor', 'system', 'heal.executed', { key: 'loop-dispatch', action: 'clear the wedged lock', evidence: 'lock removed', revert: 'none needed' }, '2026-07-01T10:05:00.000Z'),
    makeEvent('reactor', 'system', 'heal.verified', { key: 'loop-dispatch', action: 'clear the wedged lock' }, '2026-07-01T10:10:00.000Z'),
  ];
}

test('renderSystem: self-heal activity feed lists heal.* events newest-first with rule key, action, and outcome', () => {
  const html = renderSystem(healLedger(), [], NOW, 5);

  const feed = html.slice(html.indexOf('Self-heal activity'));
  assert.match(feed, /loop-dispatch/);
  assert.match(feed, /clear the wedged lock/);
  assert.match(feed, /executed — lock removed/);
  assert.match(feed, /verified — breach cleared/);
  // Newest first: verified (10:10) renders before executed (10:05) before proposed (10:00).
  const verifiedIdx = feed.indexOf('verified — breach cleared');
  const executedIdx = feed.indexOf('executed — lock removed');
  const proposedIdx = feed.indexOf('proposed (auto-heal)');
  assert.ok(verifiedIdx > -1 && executedIdx > -1 && proposedIdx > -1);
  assert.ok(verifiedIdx < executedIdx && executedIdx < proposedIdx, 'feed is newest first');
  // Interval caption states the window.
  assert.match(feed, /3 heal event\(s\) · last 24h/);
});

test('renderSystem: the default 24h window hides older heal events; ?window=30d includes all six with escalation/shadow outcomes', () => {
  const events = healLedger();
  const html24 = renderSystem(events, [], NOW, 5);
  assert.ok(!html24.includes('escalated — still stale after retry'), 'escalation older than 24h is windowed out');

  const html30 = renderSystem(events, [], NOW, 5, undefined, [], new URL('http://localhost/system?window=30d'));
  const feed = html30.slice(html30.indexOf('Self-heal activity'));
  assert.match(feed, /6 heal event\(s\) · last 30d/);
  assert.match(feed, /escalated — still stale after retry \(×3\)/);
  assert.match(feed, /graduated — shadow burn-in complete/);
  assert.match(feed, /shadow — would have: auto-heal/);
});

test('renderSystem: the heal feed window picker renders 24h/7d/30d GET chips and an empty state without heal events', () => {
  const html = renderSystem(sampleLedger(), [], NOW, 5);
  const feed = html.slice(html.indexOf('Self-heal activity'));
  for (const opt of ['24h', '7d', '30d']) {
    assert.match(feed, new RegExp(`href="\\?window=${opt}"`));
  }
  assert.match(feed, /No self-heal activity \(last 24h\)/);
});

// ---------------------------------------------------------------------------
// View — Activity (/activity)
// ---------------------------------------------------------------------------

test('renderActivity: lists every item\'s events newest-first, each linking back to its item', () => {
  const events = sampleLedger();
  const result = fold(events);
  const html = renderActivity(events, result, NOW);

  assert.match(html, /Activity/);
  assert.match(html, /item\.merged/);
  assert.match(html, /item\.accepted/);
  // Newest first: WI-004's item.merged (2026-07-01T12:21) lands before WI-001's item.captured
  // (2026-07-01T09:00).
  const mergedIdx = html.indexOf('item.merged');
  const capturedIdx = html.indexOf('item.captured');
  assert.ok(mergedIdx > -1 && capturedIdx > -1 && mergedIdx < capturedIdx);
  // Every row for a folded item links back to that item's own timeline.
  assert.match(html, /<a class="opsui-eventrow__metaitem opsui-eventrow__metaitem--link" href="\/item\/WI-004">WI-004<\/a>/);
});

test('renderActivity: a system-scoped event (sentinel item id, not a real folded item) renders with no item link', () => {
  const events = [
    ...sampleLedger(),
    makeEvent('reactor', 'system', 'heal.proposed', { key: 'backup', action: 'retry', tier: 'auto-heal' }, '2026-07-01T13:00:00.000Z'),
  ];
  const result = fold(events);
  const html = renderActivity(events, result, NOW);

  assert.match(html, /heal\.proposed/);
  const healRow = html.slice(html.indexOf('heal.proposed') - 300, html.indexOf('heal.proposed'));
  assert.ok(!healRow.includes('href="/item/system"'), 'a sentinel item id must never render as an item link');
});

test('renderActivity: uses the same row renderer as the item timeline — timestamp, actor, type, and data summary', () => {
  const events = sampleLedger();
  const result = fold(events);
  const activityHtml = renderActivity(events, result, NOW);
  const itemHtml = renderItemTimeline('WI-002', result.items.get('WI-002'), events, NOW, result);

  // Both views render WI-002's build.dispatched row through the identical EventRow markup shape.
  assert.match(activityHtml, /class="opsui-eventrow opsui-eventrow--neutral"/);
  assert.match(itemHtml, /class="opsui-eventrow opsui-eventrow--neutral"/);
  assert.match(activityHtml, /build\.dispatched.*attempt=1/);
  assert.match(itemHtml, /build\.dispatched.*attempt=1/);
});

test('renderActivity: empty ledger renders the instructive empty state, never a crash', () => {
  const html = renderActivity([], fold([]), NOW);
  assert.match(html, /Activity/);
  assert.match(html, /No ledger activity yet/);
});

test('renderActivity: paginates newest-first via ?page=, sharing the console\'s one Pagination component', () => {
  const many: LedgerEvent[] = [];
  for (let i = 0; i < 60; i++) {
    const hh = String(9 + Math.floor(i / 60)).padStart(2, '0');
    const mm = String(i % 60).padStart(2, '0');
    many.push(makeEvent('cli', 'WI-100', 'msg.in', { text: `note ${i}` }, `2026-07-01T${hh}:${mm}:00.000Z`));
  }
  const result = fold(many);
  const url = new URL('http://localhost/activity');
  const page1 = renderActivity(many, result, NOW, undefined, url);
  assert.match(page1, /Page 1 of 2 \(60 events\)/);
  assert.match(page1, /note 59/);
  assert.ok(!page1.includes('note 9<'), 'page 1 holds only the newest 50 events');

  const page2Url = new URL('http://localhost/activity?page=2');
  const page2 = renderActivity(many, result, NOW, undefined, page2Url);
  assert.match(page2, /Page 2 of 2 \(60 events\)/);
  assert.match(page2, /note 9</);
});

test('renderActivity: provenance footer carries the whole ledger\'s event/item counts', () => {
  const events = sampleLedger();
  const result = fold(events);
  const html = renderActivity(events, result, NOW);
  assert.match(html, /opsui-provenance/);
  assert.match(html, new RegExp(`${events.length} ledger event\\(s\\)`));
  assert.match(html, /5 work item\(s\)/);
  assert.match(html, /loopctl events --recent 50/);
});

// WI-054: renderKnowledge (the legacy operator-configured markdown page) is retired —
// its role moved onto the /company page. Its behavior is now covered by the
// company-page tests in server.test.ts (knowledge sources → cards, decision-log → decision
// region, target chips, error → warning, no sources → empty state).

// ---------------------------------------------------------------------------
// View — Analytics (/analytics)
// ---------------------------------------------------------------------------

test('renderAnalytics: renders the observability board shell (full widget coverage lives in analytics.test.ts)', () => {
  const html = renderAnalytics(fold(sampleLedger()), NOW);
  assert.match(html, /Analytics/);
  assert.match(html, /Quota utilization/);
  assert.match(html, /Pipeline latency/);
});

// ---------------------------------------------------------------------------
// Shell — nav rendering, active-link highlighting (see server.test.ts for the exhaustive
// per-route sweep; these two pin the underlying NavigationRail/TopBar wiring at the view level)
// ---------------------------------------------------------------------------

test('page shell: renders all six sidebar sections with letter badges and purposes', () => {
  const html = renderCommand(fold([]), NOW, [], COMMAND_URL);
  for (const [title, purpose] of [
    ['Command', 'Glance, act and drill without leaving the operating picture'],
    ['Missions', 'Active work items, live builds, queue, backlog and engine health in one board'],
    ['Acceptance', 'Shipped slices awaiting your verdict'],
    ['System', 'SLO board, plane health and build artifacts for the pipeline itself'],
    ['Analytics', 'Plane spend·judge·trajectory + throughput/capture/latency'],
    // Sixth destination — the desktop rail lists it flat (no "More" overflow); only the
    // mobile bottom-nav bar folds it behind a disclosure.
    ['Knowledge', 'Operator-configured reference docs, one click from cited decisions'],
  ]) {
    assert.match(html, new RegExp(`opsui-rail__title">${title}<`));
    assert.match(html, new RegExp(`opsui-rail__purpose">${purpose.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<`));
  }
});

test('page shell: the active view carries aria-current="page" on exactly one rail link', () => {
  const html = renderMissions(fold([]), NOW);
  const matches = html.match(/class="opsui-rail__item[^"]*"[^>]*aria-current="page"/g) ?? [];
  assert.equal(matches.length, 1);
  assert.match(html, /href="\/missions"[^>]*aria-current="page"/);
});

test('page shell: the status strip reports real per-state counts and a real last-event age', () => {
  const events = sampleLedger();
  const html = renderMissions(fold(events), NOW, events);
  assert.match(html, /class="statusstrip"/);
  assert.ok(!html.includes('last event <span class="statusstrip__count">?</span>'));
});

// ---------------------------------------------------------------------------
// Provenance footer — each view passes its own fold metadata + CLI equivalents, not
// the footer's no-argument generic sentence (see html-footer.test.ts for the shared
// footer's own rendering rules).
// ---------------------------------------------------------------------------

test('renderCommand: provenance footer carries this page\'s event/item counts and CLI equivalents', () => {
  const events = sampleLedger();
  const html = renderCommand(fold(events), NOW, events, COMMAND_URL);
  assert.match(html, /opsui-provenance/);
  assert.match(html, new RegExp(`${events.length} ledger event\\(s\\)`));
  assert.match(html, /generated 2026-07-02T00:00:00\.000Z/);
  assert.match(html, /loopctl board/);
  assert.ok(html.indexOf('opsui-provenance') > html.indexOf('opsui-command'));
});

test('renderMissions: provenance footer carries this page\'s event/item counts and CLI equivalents', () => {
  const events = sampleLedger();
  const html = renderMissions(fold(events), NOW, events);
  assert.match(html, /opsui-provenance/);
  assert.match(html, new RegExp(`${events.length} ledger event\\(s\\)`));
  assert.match(html, /loopctl board/);
  assert.match(html, /loopctl state --item/);
});

test('renderItemTimeline: provenance footer scopes counts to this item\'s own events', () => {
  const events = sampleLedger();
  const result = fold(events);
  const html = renderItemTimeline('WI-002', result.items.get('WI-002'), events, NOW, result);
  const itemEventCount = events.filter((e) => e.item === 'WI-002').length;
  assert.match(html, /opsui-provenance/);
  assert.match(html, new RegExp(`${itemEventCount} ledger event\\(s\\)`));
  assert.match(html, /loopctl events --item WI-002/);
  assert.match(html, /loopctl state --item WI-002/);
});

test('renderItemTimeline: a missing item still renders a provenance footer', () => {
  const events = sampleLedger();
  const html = renderItemTimeline('WI-999', undefined, events, NOW, fold(events));
  assert.match(html, /opsui-provenance/);
  assert.match(html, /0 ledger event\(s\)/);
  assert.match(html, /loopctl state --item WI-999/);
});

test('renderAcceptance: provenance footer carries this page\'s event/item counts and CLI equivalents', () => {
  const events = sampleLedger();
  const result = fold(events);
  const html = renderAcceptance(result, BARE_TIER_CFG, LATER_NOW, events);
  assert.match(html, /opsui-provenance/);
  assert.match(html, new RegExp(`${events.length} ledger event\\(s\\)`));
  assert.match(html, new RegExp(`${result.items.size} work item\\(s\\)`));
  assert.match(html, /loopctl accept &lt;WI-NNN&gt;/);
});

test('renderSystem: provenance footer carries this page\'s event count and CLI equivalents', () => {
  const events = sampleLedger();
  const html = renderSystem(events, [], NOW, 5);
  assert.match(html, /opsui-provenance/);
  assert.match(html, new RegExp(`${events.length} ledger event\\(s\\)`));
  assert.match(html, /5 work item\(s\)/);
  assert.match(html, /loopctl doctor/);
});

