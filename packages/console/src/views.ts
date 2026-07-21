/**
 * views.ts — the console's server-rendered views, pure functions from a FoldResult (+ raw
 * events for the timeline/system views) to an HTML string. No writes, no in-place state: every
 * call re-derives its output from whatever `fold()` returns for the events handed in.
 *
 * Reshelled onto `@loopkit/ui` (Command, Missions, Acceptance, System, Analytics) — see
 * html.ts for the AppShell/NavigationRail/TopBar composition. Every region is a Card; every
 * item row is an EventRow; every state colour comes from the ONE `itemStateToOperational`
 * mapping below, mirroring the design system's own `workStateToOperationalState` convention
 * (a colour meaning is chosen exactly once).
 */

import {
  FoldResult,
  ItemRecord,
  ItemState,
  ThreadMessage,
  isDecisionPark,
  isHeldPark,
  isOpsPark,
  planeMode,
  computeAcceptanceDebt,
  classifyAcceptanceTier,
  acceptanceClassifyFiles,
  hasEvidenceGap,
  AcceptanceTier,
  AcceptanceTierClassifyConfig,
  foldCosts,
  touchesConflict,
  fold,
  evaluateSloBoard,
  SloConfig,
  SloRow,
  SloProbes,
  FoldProbeData,
  resolveItemBranch,
} from '@loopkit/core';
import { LedgerEvent } from '@loopkit/core';
import { spawnSync } from 'node:child_process';
import { Card, EventRow, StatusBadge, MetricTile, IntentComposer, WindowPicker, Pagination, Button, parseTimeWindow, windowCutoffMs } from '@loopkit/ui';
import type { OperationalState, EventAction, EventRowMetaItem } from '@loopkit/ui';
import { esc, page, emptyState, NavId } from './html.js';
import { quotaNotice, computeRoutingLatency, ROUTING_TARGET_MIN } from './analytics.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Shared s/m/h/d duration formatter — the ONE place elapsed-time and countdown labels render from. */
function durationLabel(ms: number): string {
  if (isNaN(ms) || ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function ageLabel(ts: string | undefined, now: Date): string {
  if (!ts) return '?';
  const diffMs = now.getTime() - new Date(ts).getTime();
  if (isNaN(diffMs)) return '?';
  return durationLabel(diffMs);
}

/** THE item-state → operational-state mapping — chosen once, used by
 *  every card/badge/EventRow in the console. */
function itemStateToOperational(state: ItemState): OperationalState {
  switch (state) {
    case 'merged':
    case 'accepted':
    case 'done':
      return 'success';
    case 'parked':
    case 'rejected':
      return 'critical';
    case 'building':
    case 'gated':
    case 'approved':
      return 'progress';
    default:
      return 'neutral';
  }
}

function tierToOperational(tier: AcceptanceTier): OperationalState {
  switch (tier) {
    case 'must':
      return 'critical';
    case 'review':
      return 'warning';
    case 'optional':
      return 'info';
    case 'auto':
    default:
      return 'success';
  }
}

function shortText(rec: Pick<ItemRecord, 'sourceText' | 'spec' | 'title'>): string {
  const raw = rec.title || rec.sourceText || rec.spec || '';
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > 100 ? oneLine.slice(0, 100) + '…' : oneLine;
}

/** Priority rank shared by the missions sort — mirrors the dispatch beat's pick order. */
const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 2, low: 3 };

/** What unblocks a parked item, by parkKind — the ONE place this copy lives; every card that
 *  surfaces parked items (ops-parks, Missions parked lane, why-not-building) gets it via
 *  itemMetadata below rather than carrying its own note. For 'decomposition', the successor
 *  planning item is parsed once from parkReason (the canonical "...as WI-NNN" template written
 *  by beats/reactor.ts's stepDecompositionUnpark). */
export function unblockNote(parkKind: string | undefined, parkReason: string | undefined): string | undefined {
  switch (parkKind) {
    case 'decision':
      return 'Approve or reject below';
    case 'hold':
      return 'Resume when ready';
    case 'ops':
      return 'Auto-retries; escalates on breaker';
    case 'decomposition': {
      const successor = /\bas (WI-\d+)\b/.exec(parkReason ?? '')?.[1];
      return successor ? `Waiting on planner → ${successor}` : 'Waiting on planner';
    }
    default:
      return undefined;
  }
}

/** Extra metadata chips shown on an item row: priority, model, sensitivity + target, unblock
 *  note when parked, when present — the operator must see WHY the queue drains in the order it
 *  does. */
function itemMetadata(r: ItemRecord, now: Date): string[] {
  const meta: string[] = [];
  const at = r.transitions[r.state] ?? r.createdAt;
  meta.push(`${ageLabel(at, now)} ago`);
  // Priority/model are assigned at ROUTING — a captured item has neither yet. Say so,
  // or the missing chip reads as a bug rather than a pipeline stage.
  if (r.state === 'captured') meta.push('routing…');
  if (r.priority) meta.push(r.priority);
  if (r.model) meta.push(r.model);
  if (r.attempts > 1) meta.push(`attempt ${r.attempts}`);
  if (r.sensitivity) meta.push(r.sensitivity);
  if (r.target) meta.push(r.target);
  const note = unblockNote(r.parkKind, r.parkReason);
  if (note) meta.push(note);
  return meta;
}

/** The approve button must say what approving will actually DO — the shared verb's behavior
 *  forks on whether a build already exists (@loopkit/core verbs.ts): with a built branch on
 *  record, approving tells the reactor to merge that branch; with no build at all, approving
 *  unparks + requeues the item for a fresh build. A build on record that carried no branch
 *  signal keeps the neutral label — the render cannot promise either outcome (the verb's own
 *  branch-existence git check decides at append time). */
function approveLabel(rec: ItemRecord): string {
  const branch = rec.currentBuild?.branch ?? rec.builds[rec.builds.length - 1]?.branch;
  if (branch) return 'Approve — merge built branch';
  const hasBuilds = rec.currentBuild !== undefined || rec.builds.length > 0;
  if (!hasBuilds) return 'Approve — requeue for build';
  return 'Approve';
}

/** Approve + reject actions for a decision-park EventRow. `returnTo` rides the action URL's
 *  query string (EventAction.form has no separate returnTo slot) — server.ts's readReturnTo
 *  checks the query string first, the POST body second, so this round-trips through the verb
 *  and back to whichever view rendered the row. */
function decisionActions(rec: ItemRecord, returnTo: string): EventAction[] {
  const itemId = rec.id;
  const rt = encodeURIComponent(returnTo);
  return [
    {
      id: `approve:${itemId}`,
      label: approveLabel(rec),
      emphasis: 'primary',
      form: { action: `/item/${encodeURIComponent(itemId)}/approve?returnTo=${rt}`, intent: 'approve' },
    },
    {
      id: `reject:${itemId}`,
      label: 'Reject',
      emphasis: 'danger',
      form: {
        action: `/item/${encodeURIComponent(itemId)}/reject?returnTo=${rt}`,
        intent: 'reject',
        confirm: 'Reject this item? This closes it — it will not be requeued.',
      },
    },
  ];
}

/** Accept action for a merged-awaiting-acceptance EventRow. */
function acceptAction(itemId: string, returnTo: string): EventAction {
  return {
    id: `accept:${itemId}`,
    label: 'Accept',
    emphasis: 'primary',
    form: {
      action: `/item/${encodeURIComponent(itemId)}/accept?returnTo=${encodeURIComponent(returnTo)}`,
      intent: 'accept',
    },
  };
}

// ---------------------------------------------------------------------------
// Run-control verbs (console parity, Missions per-state verb set) — stop / hold /
// resume / requeue / escalate / dismiss. Mirror decisionActions/acceptAction above: pure
// functions building EventAction[]s over the shared @loopkit/core verbs.ts POST routes.
// ---------------------------------------------------------------------------

/** Other items building in the SAME worktree as `rec` (see beats/dispatch.ts batch
 *  co-location) — every co-located item shares one worker process, so stopping any one of
 *  them interrupts them all. Read-only projection of ItemRecord.currentBuild.worktree; no
 *  batch id exists on the fold, this IS the one place that association is derived. */
function coBatchedSiblingIds(rec: ItemRecord, allItems: ItemRecord[]): string[] {
  const worktree = rec.currentBuild?.worktree;
  if (!worktree) return [];
  return allItems
    .filter((r) => r.id !== rec.id && r.state === 'building' && r.currentBuild?.worktree === worktree)
    .map((r) => r.id);
}

function stopConfirmMessage(rec: ItemRecord, allItems: ItemRecord[]): string {
  const siblings = coBatchedSiblingIds(rec, allItems);
  return siblings.length
    ? `Stop this build? It shares a worktree with ${siblings.join(', ')} — stopping ${rec.id} will interrupt them too.`
    : `Stop this build? ${rec.id} will be parked and will not auto-requeue.`;
}

/** Stop + Escalate actions for a `building` EventRow. `allItems` is the full fold's item list
 *  (needed only to name co-batched siblings in the Stop confirm — see coBatchedSiblingIds). */
function buildingActions(rec: ItemRecord, returnTo: string, allItems: ItemRecord[]): EventAction[] {
  const itemId = rec.id;
  const rt = encodeURIComponent(returnTo);
  return [
    {
      id: `stop:${itemId}`,
      label: 'Stop',
      emphasis: 'danger',
      form: {
        action: `/item/${encodeURIComponent(itemId)}/stop?returnTo=${rt}`,
        intent: 'stop',
        confirm: stopConfirmMessage(rec, allItems),
      },
    },
    {
      id: `escalate:${itemId}`,
      label: 'Escalate',
      form: { action: `/item/${encodeURIComponent(itemId)}/escalate?returnTo=${rt}`, intent: 'escalate' },
    },
  ];
}

/** Hold + Escalate actions for a `queued` EventRow. */
function queuedActions(rec: ItemRecord, returnTo: string): EventAction[] {
  const itemId = rec.id;
  const rt = encodeURIComponent(returnTo);
  return [
    {
      id: `hold:${itemId}`,
      label: 'Hold',
      form: { action: `/item/${encodeURIComponent(itemId)}/hold?returnTo=${rt}`, intent: 'hold' },
    },
    {
      id: `escalate:${itemId}`,
      label: 'Escalate',
      form: { action: `/item/${encodeURIComponent(itemId)}/escalate?returnTo=${rt}`, intent: 'escalate' },
    },
  ];
}

/** Resume action for a held (parkKind 'hold') EventRow. */
function resumeAction(itemId: string, returnTo: string): EventAction {
  return {
    id: `resume:${itemId}`,
    label: 'Resume',
    emphasis: 'primary',
    form: { action: `/item/${encodeURIComponent(itemId)}/resume?returnTo=${encodeURIComponent(returnTo)}`, intent: 'resume' },
  };
}

/** Requeue-now + Dismiss actions for an ops-parked (isOpsPark) EventRow. */
function opsParkActions(rec: ItemRecord, returnTo: string): EventAction[] {
  const itemId = rec.id;
  const rt = encodeURIComponent(returnTo);
  return [
    {
      id: `requeue:${itemId}`,
      label: 'Requeue now',
      emphasis: 'primary',
      form: { action: `/item/${encodeURIComponent(itemId)}/requeue?returnTo=${rt}`, intent: 'requeue' },
    },
    {
      id: `dismiss:${itemId}`,
      label: 'Dismiss',
      emphasis: 'danger',
      form: {
        action: `/item/${encodeURIComponent(itemId)}/dismiss?returnTo=${rt}`,
        intent: 'dismiss',
        confirm: 'Dismiss this item? This closes it permanently — it will not be requeued.',
      },
    },
  ];
}

/** THE run-control action set for one item (one home — Missions lanes and the item page both
 *  call this so the two surfaces never drift). Falls through decision/merged first (existing
 *  verb sets keep first claim), then the four run-control states this WI adds. */
function runControlActions(rec: ItemRecord, returnTo: string, allItems: ItemRecord[]): EventAction[] | undefined {
  if (isDecisionPark(rec)) return decisionActions(rec, returnTo);
  if (rec.state === 'merged') return [acceptAction(rec.id, returnTo)];
  if (rec.state === 'building') return buildingActions(rec, returnTo, allItems);
  if (rec.state === 'queued') return queuedActions(rec, returnTo);
  if (isHeldPark(rec)) return [resumeAction(rec.id, returnTo)];
  if (isOpsPark(rec)) return opsParkActions(rec, returnTo);
  return undefined;
}

/** The park classes the decision desk explains in plain language — mirrors the exact reason
 *  strings the beats emit (beats/dispatch.ts: touches-overstep, spine, push-to-origin,
 *  merge-conflict, no-commit). A reason that matches none of these (an armed-trigger park,
 *  free-text operator escalation, ...) falls through to 'other', where the raw reason is
 *  shown verbatim rather than guessed at. */
type ParkClass = 'out-of-scope' | 'protected-path' | 'push-failed' | 'merge-conflict' | 'no-commit' | 'other';

function classifyParkReason(reason: string): { kind: ParkClass; files: string[] } {
  let m = /^needs-decision: files outside declared Touches \([^)]*\): (.+)$/.exec(reason);
  if (m) return { kind: 'out-of-scope', files: m[1]!.split(',').map((s) => s.trim()).filter(Boolean) };
  m = /^needs-decision: touches spine \(([^)]*)\)/.exec(reason);
  if (m) return { kind: 'protected-path', files: m[1]!.split(',').map((s) => s.trim()).filter(Boolean) };
  if (/^push to origin failed/i.test(reason)) return { kind: 'push-failed', files: [] };
  if (/merge conflict/i.test(reason)) return { kind: 'merge-conflict', files: [] };
  if (/^no-commit:/i.test(reason)) return { kind: 'no-commit', files: [] };
  return { kind: 'other', files: [] };
}

/** One recommendation per park class the operator can act on without reading the raw reason —
 *  absent entirely for 'other', where there's no plain-language class to recommend from. */
const PARK_RECOMMENDATION: Partial<Record<ParkClass, string>> = {
  'push-failed': 'Transient — usually safe to approve.',
  'merge-conflict': 'Transient — usually safe to approve once the target has settled.',
  'out-of-scope': 'Review the file list before approving.',
  'protected-path': 'Always review — a protected path changed.',
  'no-commit': 'No usable build exists — approving requeues a fresh attempt.',
};

function whyParkedLine(reason: string, cls: { kind: ParkClass; files: string[] }): string {
  switch (cls.kind) {
    case 'out-of-scope':
      return `${cls.files.length} file${cls.files.length === 1 ? '' : 's'} outside the declared scope: ${cls.files.join(', ')}`;
    case 'protected-path':
      return cls.files.length ? `Touches a protected path: ${cls.files.join(', ')}` : reason;
    case 'push-failed':
      return 'Pushing the built branch to the target repo failed.';
    case 'merge-conflict':
      return 'The built branch conflicts with the target branch and could not be merged automatically.';
    case 'no-commit':
      return 'The build produced no commit to merge.';
    default:
      return reason;
  }
}

/** Branch-liveness check — mirrors the exact git call `approveOrReject`'s branch-gone requeue
 *  path runs in @loopkit/core's verbs.ts (`git rev-parse --verify <branch>`), so this render
 *  never promises "merges branch X" when the approve verb itself would find that branch gone
 *  and requeue instead. */
function branchExists(branch: string, repoRoot: string): boolean {
  const check = spawnSync('git', ['rev-parse', '--verify', branch], { cwd: repoRoot, stdio: 'pipe' });
  return check.status === 0;
}

/** "What approving does" — resolves the branch through the SAME chain the approve verb
 *  resolves it (resolveItemBranch) and, when one is on record, checks it is still live in
 *  `repoRoot` (branchExists above). Without the live check a deleted/GC'd branch would keep
 *  reading "merges branch X" here right up until the approve verb itself found it gone. */
function approvalOutcomeLine(rec: ItemRecord, repoRoot: string): string {
  const branch = resolveItemBranch(rec);
  if (!branch) return 'Requeues fresh — no build is on record.';
  if (!branchExists(branch, repoRoot)) return `Requeues fresh — branch ${branch} no longer exists.`;
  return `Merges branch ${branch}.`;
}

/** The decision-desk's structured park explanation, replacing the old raw "Parked: <reason>"
 *  summary suffix: four labeled facts — what the item is, why it parked in plain language,
 *  what approving will actually do, and a class-keyed recommendation — an operator can act
 *  on without reading dispatch's internal reason string. */
function parkExplainBlock(rec: ItemRecord, repoRoot: string): string {
  if (!rec.parkReason) return '';
  const cls = classifyParkReason(rec.parkReason);
  const rows: [string, string][] = [
    ['What it is', shortText(rec)],
    ['Why parked', whyParkedLine(rec.parkReason, cls)],
    ['What approving does', approvalOutcomeLine(rec, repoRoot)],
  ];
  const recommendation = PARK_RECOMMENDATION[cls.kind];
  if (recommendation) rows.push(['Recommendation', recommendation]);
  const rowsHtml = rows
    .map(([k, v]) => `<div class="evidence__row"><span class="evidence__key">${esc(k)}</span><span class="evidence__val">${esc(v)}</span></div>`)
    .join('');
  return `<div class="evidence">${rowsHtml}</div>`;
}

function itemRow(
  r: ItemRecord,
  now: Date,
  opts: { returnTo: string; actions?: EventAction[]; body?: string; repoRoot?: string },
): string {
  const state = itemStateToOperational(r.state);
  const parkBlock = r.parkReason ? parkExplainBlock(r, opts.repoRoot ?? process.cwd()) : '';
  return EventRow({
    state,
    title: r.id,
    metadata: itemMetadata(r, now),
    summary: shortText(r),
    badge: { state, label: r.state },
    body: [parkBlock, opts.body].filter(Boolean).join(''),
    actions: opts.actions,
    evidence: { id: r.id, label: 'Timeline', href: `/item/${esc(r.id)}` },
  });
}

// ---------------------------------------------------------------------------
// Per-item message threads — inline reply, shared by Command's decision desk (a compact
// thread per parked item, so an operator can reply without leaving the operating picture)
// and the item timeline (the full thread). One source of truth: `ItemRecord.messages` plus
// any `ConversationRecord` that spawned the item (conv.promoted stamps `spawnedItems`) —
// so an item captured out of an operator conversation keeps that lead-in visible on its
// own thread, not just on the (separate) conversation record.
// ---------------------------------------------------------------------------

/** The one shared page-slicer for every ?-paginated feed in the console — a second slicing
 *  implementation for another feed would be exactly the kind of duplicate logic AGENTS.md's
 *  "one parser / one predicate per behavior" rule forbids. 1-based `page`, clamped into range.
 *  Exported so opsPages.ts's renderActivity (WI-055) reuses the same slicer rather than a copy. */
export function paginate<T>(items: T[], page: number, pageSize: number): { pageItems: T[]; page: number; pageCount: number; total: number } {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const clamped = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
  const start = (clamped - 1) * pageSize;
  return { pageItems: items.slice(start, start + pageSize), page: clamped, pageCount, total };
}

/** Newest-reply-first messages for an item's thread: its own `messages` plus any conversation
 *  that spawned it. `result` is optional — callers with only a single item's events (no fold
 *  of the whole ledger) still get the item's own thread, just without the conversation lead-in. */
function threadMessagesFor(rec: ItemRecord, result: FoldResult | undefined): ThreadMessage[] {
  const spawning: ThreadMessage[] = [];
  if (result) {
    for (const conv of result.conversations.values()) {
      if (conv.spawnedItems.includes(rec.id)) spawning.push(...conv.messages);
    }
  }
  return [...spawning, ...rec.messages].sort((a, b) => b.ts.localeCompare(a.ts));
}

/** Rewrite `url`'s query string with a single `pageParam=page`, everything else preserved —
 *  the same "keep every other filter, touch only this one param" shape as `windowQuery`. Shared
 *  by every paginated card (thread pages, Shipped recently) — one href-builder for the one
 *  page-slicer (`paginate`), not a copy per card. Exported for renderActivity (WI-055). */
export function pageHrefFor(url: URL, pageParam: string, page: number): string {
  const params = new URLSearchParams(url.search);
  params.set(pageParam, String(page));
  const qs = params.toString();
  return `${url.pathname}${qs ? `?${qs}` : ''}`;
}

/** Turns a card label (e.g. "Merged (awaiting acceptance)") into a URL-safe page-param suffix
 *  — so every per-card page param (`lanePage_<label>`, `tierPage_<tier>`) is stable and unique
 *  without a per-caller slugging implementation. */
function slugForParam(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function renderThreadMessages(messages: ThreadMessage[]): string {
  if (!messages.length) return `<p class="thread__empty">No messages yet.</p>`;
  return messages
    .map(
      (m) => `<div class="thread-message thread-message--${esc(m.direction)}">
<span class="thread-message__meta">${esc(m.ts)} · ${m.direction === 'out' ? 'plane' : 'operator'}</span>
<p class="thread-message__text">${esc(m.text)}</p>
</div>`,
    )
    .join('');
}

/** The plain no-JS reply box: POSTs straight to the shared `replyToItem` verb's route,
 *  303-redirects back to `returnTo` (POST-redirect-GET, same shape as every other verb form).
 *  `enctype="multipart/form-data"` + the `attachment` file input mirror the intent composer
 *  (@loopkit/ui's `IntentComposer`) — server.ts's `/item/<id>/reply` route parses either
 *  encoding the same way it parses `/intent`. */
function replyForm(itemId: string, returnTo: string): string {
  const action = `/item/${encodeURIComponent(itemId)}/reply?returnTo=${encodeURIComponent(returnTo)}`;
  return `<form method="post" action="${esc(action)}" enctype="multipart/form-data" class="thread-reply-form">
<textarea name="text" class="thread-reply-form__input" rows="2" placeholder="Reply to ${esc(itemId)}…" required></textarea>
<input type="file" name="attachment" class="thread-reply-form__file" accept="image/*,.pdf,.txt,.md,.csv" multiple>
<button type="submit" class="opsui-btn opsui-btn--primary opsui-btn--sm">Reply</button>
</form>`;
}

/** The "Found a problem" capture box on a merged item: posts straight to the shared
 *  `captureFeedback` verb's route, 303-redirects back to `returnTo` — same no-JS shape as
 *  `replyForm`, sitting alongside the accept action on both the acceptance desk and the item
 *  timeline's Accept card. `enctype="multipart/form-data"` + the `attachment` file input mirror
 *  `replyForm`'s — server.ts's `/item/<id>/feedback` route parses either encoding the same way
 *  it parses `/reply`. */
/** Collapsed by default: the desk's resting state is one compact verb row per item — the
 *  textarea + file input only unfold when the operator actually has a problem to report.
 *  Native <details>, zero-JS. */
function feedbackForm(itemId: string, returnTo: string): string {
  const action = `/item/${encodeURIComponent(itemId)}/feedback?returnTo=${encodeURIComponent(returnTo)}`;
  return `<details class="found-problem"><summary class="opsui-btn opsui-btn--danger opsui-btn--sm found-problem__summary">Found a problem</summary>
<form method="post" action="${esc(action)}" enctype="multipart/form-data" class="thread-reply-form">
<textarea name="text" class="thread-reply-form__input" rows="2" placeholder="Found a problem with ${esc(itemId)}? Describe it…" required></textarea>
<label class="thread-reply-form__filewrap">Attach screenshots or files<input type="file" name="attachment" class="thread-reply-form__file" accept="image/*,.pdf,.txt,.md,.csv" multiple></label>
<button type="submit" class="opsui-btn opsui-btn--danger opsui-btn--sm">Send problem report</button>
</form></details>`;
}

/** A thread card: newest-reply-first messages (paginated), then the reply box. Used both as a
 *  compact EventRow `body` (Command's decision desk) and as `renderItemTimeline`'s full thread
 *  section — same renderer, different `pageSize`/`pageParam` so the two surfaces' pagination
 *  never collides when a decision-desk item's thread and the item's own timeline page are both
 *  open in different tabs. */
function threadCard(
  rec: ItemRecord,
  result: FoldResult | undefined,
  opts: { url: URL; returnTo: string; pageParam: string; pageSize: number; title?: string },
): string {
  const all = threadMessagesFor(rec, result);
  const requestedPage = Number(opts.url.searchParams.get(opts.pageParam)) || 1;
  const { pageItems, page, pageCount, total } = paginate(all, requestedPage, opts.pageSize);
  const pager = Pagination({
    page,
    pageCount,
    total,
    itemNoun: 'messages',
    hrefFor: (p) => pageHrefFor(opts.url, opts.pageParam, p),
    label: `${rec.id} thread pages`,
  });
  const heading = opts.title ? `<h4 class="thread__title">${esc(opts.title)}</h4>` : '';
  return `<div class="thread-card">${heading}<div class="thread">${renderThreadMessages(pageItems)}</div>${pager}${replyForm(rec.id, opts.returnTo)}</div>`;
}

/** Status-strip counts by state, plus the age of the most recent event — rendered under the top bar on every view. */
export function renderStatusStrip(result: FoldResult, events: LedgerEvent[], now: Date): string {
  const counts = new Map<string, number>();
  for (const r of result.items.values()) {
    counts.set(r.state, (counts.get(r.state) ?? 0) + 1);
  }
  let lastTs: string | undefined;
  for (const e of events) {
    if (!lastTs || e.ts > lastTs) lastTs = e.ts;
  }
  const order: ItemState[] = ['captured', 'routed', 'queued', 'building', 'gated', 'parked', 'approved', 'merged', 'accepted'];
  const items = order
    .filter((s) => counts.get(s))
    .map((s) => `<span class="statusstrip__item"><span class="statusstrip__count">${esc(counts.get(s))}</span> ${esc(s)}</span>`)
    .join('');
  const lastEvent = `<span class="statusstrip__item">last event <span class="statusstrip__count">${esc(ageLabel(lastTs, now))}</span> ago</span>`;
  // Execution-mode pill (attended vs. away): attended ⇒ an operator session is live and CLI intents are built
  // immediately by the conductor; away ⇒ the background beats own the queue. Derived from the fold
  // (planeMode), so it flips the instant a session starts/ends or its heartbeat goes stale.
  const mode = planeMode(result.sessions, now.getTime());
  const modeBadge = mode === 'attended'
    ? `<span class="statusstrip__mode statusstrip__mode--attended" title="An operator session is live — CLI intents are picked up and built immediately by the attended conductor, not the background beats.">● Attended · session</span>`
    : `<span class="statusstrip__mode statusstrip__mode--away" title="No live operator session — the background reactor/dispatch beats handle the queue autonomously.">○ Away · beats</span>`;
  return `${modeBadge}${items}${lastEvent}`;
}

/** Query-string helper for a page's `?window=` reload — every other query param on `url` is
 *  preserved so multiple filters can coexist. */
function windowQuery(url: URL, exclude: string[] = []): string {
  const params = new URLSearchParams(url.search);
  for (const k of exclude) params.delete(k);
  params.delete('window');
  return params.toString();
}

// ---------------------------------------------------------------------------
// View 1 — Command (/command)
// ---------------------------------------------------------------------------

/** The intent-capture composer (POST /intent): IntentComposer plus, when more than one target
 *  is registered, a <select> to name which one — mirrors `loopctl new "<text>" [--target
 *  <name>]`. With zero or exactly one registered target, capture is untargeted/auto-targeted
 *  and no selector is shown (the server stamps the sole target the same way the CLI does). */
function renderIntentCard(result: FoldResult, capturedId?: string): string {
  // The targets map is keyed by opaque targetId; the selector shows and submits the
  // display NAME (captureIntent accepts either, and names are what operators recognize).
  const targets = [...result.targets.values()].map((t) => t.name);
  const composer = IntentComposer({
    action: '/intent',
    capturedId,
    capturedHref: capturedId ? `/item/${encodeURIComponent(capturedId)}` : undefined,
  });
  const targetField = targets.length > 1
    ? `<label class="opsui-composer__target-label">Target
  <select name="target" form="opsui-intent-form" required>
    <option value="" disabled selected>choose a target…</option>
    ${targets.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('\n    ')}
  </select>
</label>`
    : '';
  // IntentComposer's <form> has no id of its own to hook the target <select>'s `form`
  // attribute to — inject one via a light string replace rather than forking the component.
  const withFormId = composer.replace('<form class="opsui-composer"', '<form id="opsui-intent-form" class="opsui-composer"');
  return `<div id="opsui-intent">${withFormId}${targetField}</div>`;
}

/** Recent-work-items strip page size — a glanceable slice at the very top of Command, not a
 *  full board (the full history is Shipped recently / Missions, one click away). */
const RECENT_WORK_STRIP_SIZE = 5;

/** One row on the "Recent work items" strip: id (+ origin ref, when the ledger actually carries
 *  one), truncated title, state badge, and timeline/thread links. Origin ref derivation mirrors
 *  the ONE place `externalRef` is resolved elsewhere in this codebase (core/cli.ts's `activeItems`
 *  building) — a legacy `ext:`-prefixed `source` counts too, never re-derived a second way. */
function recentWorkItemRow(rec: ItemRecord, now: Date): string {
  const state = itemStateToOperational(rec.state);
  const externalRef = rec.externalRef ?? (rec.source?.startsWith('ext:') ? rec.source.slice(4) : undefined);
  const metadata: EventRowMetaItem[] = [
    { href: `/item/${esc(rec.id)}`, label: 'timeline' },
    ...(rec.messages.length > 0 ? [{ href: `/item/${esc(rec.id)}`, label: 'thread' } as EventRowMetaItem] : []),
  ];
  return EventRow({
    state,
    title: externalRef ? `${rec.id} · ${externalRef}` : rec.id,
    metadata,
    summary: shortText(rec),
    badge: { state, label: rec.state },
    evidence: { id: rec.id, label: 'Timeline', href: `/item/${esc(rec.id)}` },
  });
}

/** "Recent work items" strip — the last ~5 recently-worked items (merged or accepted,
 *  newest-first), at the very top of Command so "what did the plane just do" is the first
 *  thing an operator sees, mirroring the old ops-ui recent-intents strip. Hidden entirely
 *  (never an empty card) when nothing has shipped yet. */
function recentWorkItemsStrip(result: FoldResult, now: Date): string {
  const recent = [...result.items.values()]
    .filter((r) => r.mergedAt || r.acceptedAt)
    .sort((a, b) => (b.mergedAt ?? b.acceptedAt ?? '').localeCompare(a.mergedAt ?? a.acceptedAt ?? ''))
    .slice(0, RECENT_WORK_STRIP_SIZE);

  if (recent.length === 0) return '';

  const rows = recent.map((rec) => recentWorkItemRow(rec, now)).join('');
  return `<div class="opsui-recentwork">
<p class="opsui-recentwork__heading">Recent work items<span class="opsui-recentwork__caption"> · origin ref shown when the ledger carries one</span></p>
${rows}
</div>`;
}

/** Median of a numeric array (ascending or not) — the standard "middle value, average the
 *  middle two on even length" definition. Returns undefined for an empty array so callers can
 *  render a "no data yet" tile instead of a misleading zero. */
function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function glanceCard(result: FoldResult, now: Date, url: URL, quotaChip?: string): string {
  const decisions = [...result.items.values()].filter((r) => isDecisionPark(r)).length;
  const { acceptanceCount } = computeAcceptanceDebt(result, now.getTime(), Number.MAX_SAFE_INTEGER);
  const stuck = [...result.items.values()].filter((r) => r.state === 'building' && r.attempts > 2).length;
  const queued = [...result.items.values()].filter((r) => ['captured', 'routed', 'queued'].includes(r.state)).length;

  // ONE window grammar for the whole console (parseTimeWindow) — the glance picker keeps its
  // curated three presets, but any Nm/Nh/Nd typed into the URL parses through the same parser.
  const windowSpec = parseTimeWindow(url.searchParams.get('window'), '24h');
  const cutoff = windowCutoffMs(windowSpec, now.getTime());
  const windowMerged = [...result.items.values()].filter((r) => {
    if (!r.mergedAt) return false;
    return cutoff === null || new Date(r.mergedAt).getTime() >= cutoff;
  });
  const shipped = windowMerged.length;

  // Flow: N-in (captured this window) vs N-out (merged this window) plus the median time a
  // window merge spent between capture and merge, folding in the live queue depth — a growing
  // in/out gap (or a growing queue) is the leading signal that the lane is backing up before
  // "Stuck" would ever fire.
  const windowInCount = [...result.items.values()].filter((r) => {
    if (!r.capturedAt) return false;
    return cutoff === null || new Date(r.capturedAt).getTime() >= cutoff;
  }).length;
  const cycleTimesMs = windowMerged
    .filter((r) => r.capturedAt)
    .map((r) => new Date(r.mergedAt!).getTime() - new Date(r.capturedAt!).getTime())
    .filter((ms) => ms >= 0);
  const medianCycleMs = median(cycleTimesMs);
  const flowTile = MetricTile({
    href: '/missions',
    label: 'Flow',
    value: medianCycleMs === undefined ? '—' : durationLabel(medianCycleMs),
    footnote: `median cycle · ${windowInCount} in / ${shipped} out (${windowSpec.label}) · ${queued} queued`,
    state: medianCycleMs === undefined ? 'neutral' : 'info',
    open: { kind: 'projection', id: 'missions' },
  });

  // Reliability: share of this window's merges that landed on the first attempt — the
  // complement of "Stuck" (retried > 2) at a softer threshold, visible even when nothing is
  // stuck enough to alarm.
  const firstTryCount = windowMerged.filter((r) => r.attempts === 1).length;
  const reliabilityPct = shipped === 0 ? undefined : Math.round((firstTryCount / shipped) * 100);
  const reliabilityTile = MetricTile({
    href: '/missions',
    label: 'Reliability',
    value: reliabilityPct === undefined ? '—' : `${reliabilityPct}%`,
    footnote: `${firstTryCount}/${shipped} merged first try (${windowSpec.label})`,
    state: reliabilityPct === undefined ? 'neutral' : reliabilityPct === 100 ? 'success' : 'warning',
    open: { kind: 'projection', id: 'missions' },
  });

  const allClear = decisions === 0 && acceptanceCount === 0 && stuck === 0;
  const glanceBody = allClear
    ? `<div class="opsui-glance-allclear">
<span class="opsui-glance-allclear__dot" aria-hidden="true"></span>
<span class="opsui-glance-allclear__label">All clear — no decisions · nothing to test · none stuck</span>
</div>`
    : `<div class="opsui-glancegrid opsui-command-glance">
${MetricTile({ href: '/command', label: 'Decisions', value: decisions, footnote: 'awaiting your call', state: decisions ? 'critical' : 'success', open: { kind: 'projection', id: 'command' } })}
${MetricTile({ href: '/acceptance', label: 'To test', value: acceptanceCount, footnote: 'merged, awaiting acceptance', state: acceptanceCount ? 'warning' : 'success', open: { kind: 'projection', id: 'acceptance' } })}
${MetricTile({ href: '/missions', label: 'Stuck', value: stuck, footnote: 'retried more than twice', state: stuck ? 'critical' : 'success', open: { kind: 'projection', id: 'missions' } })}
${flowTile}
${reliabilityTile}
</div>`;

  // Quota stays OFF this card below the warning threshold — the chip only exists when a
  // provider:window needs attention (the full panel lives on /analytics#quota).
  const quotaRow = quotaChip ? `<div class="opsui-glance-quota">${quotaChip}</div>` : '';

  const body = `${glanceBody}${quotaRow}`;

  return Card({
    variant: 'glance',
    title: 'Glance',
    subtitle: 'The operating picture at a glance',
    headerAside: WindowPicker({ active: windowSpec.key, options: ['24h', '7d', '30d'], extraQuery: windowQuery(url) }),
    body,
  });
}

/** Compact thread card page size for Command's decision desk — a preview, not the full
 *  history; the full thread lives one click away on the item's own timeline. */
const COMMAND_THREAD_PAGE_SIZE = 3;

function decisionDeskCard(result: FoldResult, now: Date, returnTo: string, url: URL, repoRoot: string): string {
  const parked = [...result.items.values()]
    .filter((r) => isDecisionPark(r))
    .sort((a, b) => (a.parkedAt ?? '').localeCompare(b.parkedAt ?? ''));

  const body = parked.length
    ? parked
        .map((r) =>
          itemRow(r, now, {
            returnTo,
            repoRoot,
            actions: decisionActions(r, returnTo),
            // Namespaced per item (`threadsPage_<id>`) — more than one decision-desk thread can
            // paginate independently on the same /command page, unlike the single-item timeline.
            body: `${briefDetails(r)}${threadCard(r, result, {
              url,
              returnTo,
              pageParam: `threadsPage_${r.id}`,
              pageSize: COMMAND_THREAD_PAGE_SIZE,
              title: 'Thread',
            })}`,
          }),
        )
        .join('')
    : emptyState('Nothing needs you — the queue is unblocked.');

  return Card({ title: 'Decision desk', subtitle: 'What is blocking the queue', body });
}

function conductorCard(result: FoldResult, now: Date): string {
  const building = [...result.items.values()]
    .filter((r) => r.state === 'building')
    .sort((a, b) => (b.buildingAt ?? '').localeCompare(a.buildingAt ?? ''));

  const body = building.length
    ? building.map((r) => itemRow(r, now, { returnTo: '/command' })).join('')
    : emptyState('No workers building right now.');

  return Card({ title: 'Conductor', subtitle: 'The AI workforce, right now', body });
}

function opsParksCard(result: FoldResult, now: Date, returnTo: string, repoRoot: string): string {
  const parked = [...result.items.values()]
    .filter((r) => r.state === 'parked' && !isDecisionPark(r))
    .sort((a, b) => (a.parkedAt ?? '').localeCompare(b.parkedAt ?? ''));

  const body = parked.length
    ? parked.map((r) => itemRow(r, now, { returnTo, repoRoot })).join('')
    : emptyState('Nothing parked', 'Mechanical/infra parks the plane owns itself land here.');

  return Card({ title: 'Active ops-parks', subtitle: 'What the plane is holding on its own', body });
}

/** Shipped-recently page size — a glanceable slice; older merges are one `?shippedPage=` click
 *  away rather than paginated inline like the decision-desk threads. */
const SHIPPED_PAGE_SIZE = 5;

/** One row on the Shipped-recently card: short merge commit + age since merge, an Accept
 *  action for items still awaiting acceptance (state `merged`, not yet `accepted`), and a link
 *  to the item's own timeline — same evidence-link shape as every other EventRow in the console. */
function shippedRow(rec: ItemRecord, now: Date, returnTo: string): string {
  const state = itemStateToOperational(rec.state);
  const commit = rec.mergeCommit ? rec.mergeCommit.slice(0, 8) : '—';
  return EventRow({
    state,
    title: rec.id,
    metadata: [`merged ${ageLabel(rec.mergedAt, now)} ago`, `commit ${commit}`],
    summary: shortText(rec),
    badge: { state, label: rec.state },
    actions: rec.state === 'merged' ? [acceptAction(rec.id, returnTo)] : undefined,
    evidence: { id: rec.id, label: 'Timeline', href: `/item/${esc(rec.id)}` },
  });
}

/** Shipped recently: every item that has merged or been accepted, newest-first, paginated with
 *  the one shared `paginate`/`pageHrefFor` pair the thread cards already use. */
function shippedCard(result: FoldResult, now: Date, url: URL, returnTo: string): string {
  const shipped = [...result.items.values()]
    .filter((r) => r.mergedAt || r.acceptedAt)
    .sort((a, b) => (b.mergedAt ?? b.acceptedAt ?? '').localeCompare(a.mergedAt ?? a.acceptedAt ?? ''));

  const requestedPage = Number(url.searchParams.get('shippedPage')) || 1;
  const { pageItems, page, pageCount, total } = paginate(shipped, requestedPage, SHIPPED_PAGE_SIZE);

  const pager = Pagination({
    page,
    pageCount,
    total,
    itemNoun: 'shipped',
    hrefFor: (p) => pageHrefFor(url, 'shippedPage', p),
    label: 'Shipped recently pages',
  });

  const body = pageItems.length
    ? pageItems.map((rec) => shippedRow(rec, now, returnTo)).join('') + pager
    : emptyState('Nothing shipped yet', 'Merged and accepted work lands here, newest first.');

  return Card({ title: 'Shipped recently', subtitle: 'Newest merges and acceptances', body });
}

// ---------------------------------------------------------------------------
// Conversations card (Command) — active threads across items and operator conversations,
// plus a compact strip of recent captures. Pure projection: FoldResult.conversations
// (ConversationRecord.spawnedItems) and ItemRecord.messages are already folded — no new
// ledger events, no fold changes, this is a rendering slice only.
// ---------------------------------------------------------------------------

/** Compact thread page size inside a Conversations <details> block — same preview depth as
 *  the decision desk's inline threads (COMMAND_THREAD_PAGE_SIZE). */
const CONVERSATIONS_THREAD_PAGE_SIZE = 3;

/** Recent-captures strip page size — a glanceable chronological slice, not a full board. */
const CAPTURES_STRIP_PAGE_SIZE = 8;

/** Every item worth surfacing as an "active thread": one with messages of its own, unioned
 *  with every item spawned by a still-`active` operator conversation (ConversationRecord —
 *  a conversation stays active even after promoting an item, until conv.closed). De-duplicated
 *  by item id so a thread that qualifies both ways renders exactly once. */
function activeThreadItems(result: FoldResult): ItemRecord[] {
  const ids = new Set<string>();
  for (const rec of result.items.values()) {
    if (rec.messages.length > 0) ids.add(rec.id);
  }
  for (const conv of result.conversations.values()) {
    if (conv.state !== 'active') continue;
    for (const itemId of conv.spawnedItems) ids.add(itemId);
  }
  const items: ItemRecord[] = [];
  for (const id of ids) {
    const rec = result.items.get(id);
    if (rec) items.push(rec);
  }
  return items;
}

/** One <details> entry on the Conversations card: summary = id + title + state badge +
 *  last-reply age, body = the same `threadCard` component the decision desk and item timeline
 *  already use (paginated, inline zero-JS reply form) — merged messages via `threadMessagesFor`
 *  so an item's own thread and any spawning conversation's lead-in render as one. */
function conversationThreadEntry(rec: ItemRecord, result: FoldResult, now: Date, url: URL, returnTo: string): { lastTs?: string; html: string } {
  const messages = threadMessagesFor(rec, result);
  const lastTs = messages[0]?.ts;
  const state = itemStateToOperational(rec.state);
  const summary = `<summary class="opsui-conversations__summary">
<span class="opsui-conversations__id">${esc(rec.id)}</span>
<span class="opsui-conversations__title">${esc(shortText(rec))}</span>
${StatusBadge({ state, label: rec.state, size: 'sm' })}
<span class="opsui-conversations__age">${esc(ageLabel(lastTs, now))} ago</span>
</summary>`;
  const body = threadCard(rec, result, {
    url,
    returnTo,
    pageParam: `convThreadPage_${rec.id}`,
    pageSize: CONVERSATIONS_THREAD_PAGE_SIZE,
  });
  return { lastTs, html: `<details class="opsui-conversations__thread">${summary}${body}</details>` };
}

/** The Conversations card: every active item-thread and operator conversation, newest-activity
 *  first, each a collapsed native <details> so the card stays scannable with many threads open
 *  across the plane. */
function conversationsCard(result: FoldResult, now: Date, url: URL, returnTo: string): string {
  const entries = activeThreadItems(result)
    .map((rec) => conversationThreadEntry(rec, result, now, url, returnTo))
    .sort((a, b) => (b.lastTs ?? '').localeCompare(a.lastTs ?? ''));

  const body = entries.length
    ? entries.map((e) => e.html).join('')
    : emptyState('No active conversations', 'Item threads and operator conversations show up here as soon as they get a reply.');

  return Card({ title: 'Conversations', subtitle: 'Active threads across items and operator conversations', body });
}

/** One row on the recent-captures strip: state badge, id linking to the item's timeline/thread,
 *  a one-line summary, and age since capture. */
function captureReceiptRow(rec: ItemRecord, now: Date): string {
  const state = itemStateToOperational(rec.state);
  const at = rec.capturedAt ?? rec.createdAt;
  return `<li class="opsui-captures-strip__row">
${StatusBadge({ state, label: rec.state, size: 'sm' })}
<a class="opsui-captures-strip__id" href="/item/${esc(rec.id)}">${esc(rec.id)}</a>
<span class="opsui-captures-strip__summary">${esc(shortText(rec))}</span>
<span class="opsui-captures-strip__age">${esc(ageLabel(at, now))} ago</span>
</li>`;
}

/** Recent captures: a compact receipt strip, every item newest-captured-first, paginated with
 *  the one shared `paginate`/`pageHrefFor` pair every other paginated card on Command uses. */
function recentCapturesCard(result: FoldResult, now: Date, url: URL): string {
  const captures = [...result.items.values()].sort((a, b) =>
    (b.capturedAt ?? b.createdAt ?? '').localeCompare(a.capturedAt ?? a.createdAt ?? ''),
  );

  const requestedPage = Number(url.searchParams.get('capturesPage')) || 1;
  const { pageItems, page, pageCount, total } = paginate(captures, requestedPage, CAPTURES_STRIP_PAGE_SIZE);

  const pager = Pagination({
    page,
    pageCount,
    total,
    itemNoun: 'captures',
    hrefFor: (p) => pageHrefFor(url, 'capturesPage', p),
    label: 'Recent captures pages',
  });

  const body = pageItems.length
    ? `<ul class="opsui-captures-strip">${pageItems.map((rec) => captureReceiptRow(rec, now)).join('')}</ul>${pager}`
    : emptyState('Nothing captured yet', 'Every intent lands here, newest first, the moment it is captured.');

  return Card({ title: 'Recent captures', subtitle: 'Every capture, newest first', body });
}

export function renderCommand(
  result: FoldResult,
  now: Date = new Date(),
  events: LedgerEvent[] = [],
  url: URL = new URL('http://localhost/command'),
  capturedId?: string,
  theme?: string,
  quotaPauseThresholdPct?: number,
  repoRoot: string = process.cwd(),
): string {
  const decisions = [...result.items.values()].filter((r) => isDecisionPark(r)).length;
  const lane = decisions > 0 ? 'Lane needs you' : 'Lane healthy';

  // Conditional quota surfacing: nothing below the warning threshold, a compact chip in the
  // glance card at warning, a critical banner above the fold at critical (see quotaNotice).
  const quota = quotaNotice(foldCosts(events, { now: now.toISOString() }).quotaCapacity, quotaPauseThresholdPct);

  const body = `<h1 class="opsui-page-title">Command<span class="opsui-page-status ${decisions ? 'opsui-page-status--attn' : 'opsui-page-status--ok'}">${esc(lane)}</span></h1>
<p class="opsui-page-updated">Updated ${esc(ageLabel(now.toISOString(), now)) === '0s' ? 'just now' : esc(now.toISOString())}</p>
${quota.banner ?? ''}
<div class="opsui-command">
${recentWorkItemsStrip(result, now)}
${glanceCard(result, now, url, quota.chip)}
${conversationsCard(result, now, url, '/command')}
${recentCapturesCard(result, now, url)}
${renderIntentCard(result, capturedId)}
${decisionDeskCard(result, now, '/command', url, repoRoot)}
${conductorCard(result, now)}
${opsParksCard(result, now, '/command', repoRoot)}
${shippedCard(result, now, url, '/command')}
</div>`;

  return page(
    {
      title: 'Command — loopkit console',
      activeNav: 'command',
      statusStrip: renderStatusStrip(result, events, now),
      theme,
      provenance: {
        generatedAt: now.toISOString(),
        eventCount: events.length,
        itemCount: result.items.size,
        cliEquivalents: [
          { label: 'Glance / conductor / ops parks / shipped', command: 'loopctl board' },
          { label: 'Decisions / recent captures', command: 'loopctl summary' },
          { label: 'Conversations / intent thread', command: 'loopctl events --recent 50' },
        ],
      },
    },
    body,
  );
}

// ---------------------------------------------------------------------------
// View 2 — Missions (/missions)
// ---------------------------------------------------------------------------

// The parked lane is split by parkKind so an operator never sees a mechanical park framed as
// "needs you": only DECISION parks block on the operator; everything else (merge conflicts,
// no-commit, breaker — parkKind !== 'decision') is the plane self-healing and lands in its own
// lane. Same split the /command page draws (decisionDeskCard vs opsParksCard) — one taxonomy,
// two surfaces. `filter` narrows a state-matched lane further; absent ⇒ the whole state.
const MISSION_GROUPS: { label: string; states: ItemState[]; filter?: (r: ItemRecord) => boolean }[] = [
  { label: 'Captured / routed / queued', states: ['captured', 'routed', 'queued'] },
  { label: 'Building', states: ['building'] },
  { label: 'Gated', states: ['gated'] },
  { label: 'Needs you (parked)', states: ['parked'], filter: isDecisionPark },
  { label: 'Self-healing (ops-parks)', states: ['parked'], filter: (r) => !isDecisionPark(r) },
  { label: 'Approved', states: ['approved'] },
  { label: 'Merged (awaiting acceptance)', states: ['merged'] },
  { label: 'Accepted / terminal', states: ['accepted', 'done', 'rejected', 'answered'] },
];

/** Rows per Missions lane page, before the shared `paginate`/`pageHrefFor`/`Pagination` trio
 *  kicks in — a lane like "Merged (awaiting acceptance)" grows unbounded while items wait on
 *  the operator, same shape as the acceptance tiers below. */
const MISSIONS_LANE_PAGE_SIZE = 10;

/**
 * Diagnosis for one queued item, computed read-only from `FoldResult.items` — never a state
 * transition, purely explaining what dispatch's own picker (beats/dispatch.ts) would see:
 * - `lane-serialized`: the item declared no Touches of its own (or the wildcard `'*'`), so it
 *   conflicts with EVERY in-flight build by definition and waits behind the whole shared lane.
 * - `conflict`: it declared Touches that overlap a specific in-flight (building) item's.
 * - `runnable`: no conflict against anything currently building — it just hasn't been picked
 *   yet (empty queue slot, breaker, priority order, or another queued item ahead of it).
 * Uses `touchesConflict` from @loopkit/core — the SAME predicate the picker gates dispatch
 * with — so this projection can never silently drift from the beat's real behavior.
 */
type QueueDiagnosis =
  | { kind: 'runnable' }
  | { kind: 'lane-serialized' }
  | { kind: 'conflict'; blocker: ItemRecord };

/** In-flight pool a queued item is diagnosed against: currently 'building', excluding the
 *  planning lane — a planning build never writes a file, so (mirroring dispatch.ts) it can
 *  never conflict with anything. */
function diagnoseQueued(rec: ItemRecord, inflight: ItemRecord[]): QueueDiagnosis {
  if (inflight.length === 0) return { kind: 'runnable' };
  if (!rec.touches || rec.touches === '*') return { kind: 'lane-serialized' };
  const blocker = inflight.find((b) => touchesConflict(rec.touches, b.touches));
  return blocker ? { kind: 'conflict', blocker } : { kind: 'runnable' };
}

function whyNotBuildingQueuedRow(rec: ItemRecord, now: Date, diag: QueueDiagnosis): string {
  const state = itemStateToOperational(rec.state);
  let summary: string;
  let body: string | undefined;
  if (diag.kind === 'lane-serialized') {
    summary = 'Lane-serialized — no declared touches, so it waits behind every in-flight build.';
  } else if (diag.kind === 'conflict') {
    summary = `Touches conflict with in-flight ${diag.blocker.id} — ${shortText(diag.blocker)}`;
    body = `<div class="evidence"><div class="evidence__row"><span class="evidence__key">Blocker touches</span><span class="evidence__val">${esc(diag.blocker.touches || '*')}</span></div></div>`;
  } else {
    summary = 'Runnable — no touches conflict, waiting for a free dispatch slot.';
  }
  return EventRow({
    state,
    title: rec.id,
    metadata: itemMetadata(rec, now),
    summary,
    body,
    badge: { state, label: rec.state },
    evidence: { id: rec.id, label: 'Timeline', href: `/item/${esc(rec.id)}` },
  });
}

/** Parked items get no diagnosis — their reason is already recorded on the fold; this just
 *  surfaces it (parkReason/parkKind/parkFingerprint/parkNovelty) rather than re-deriving it. */
function whyNotBuildingParkedRow(rec: ItemRecord, now: Date): string {
  const state = itemStateToOperational(rec.state);
  const fields: [string, string | undefined][] = [
    ['Kind', rec.parkKind],
    ['Fingerprint', rec.parkFingerprint],
    ['Novelty', rec.parkNovelty],
  ];
  const rows = fields
    .filter((f): f is [string, string] => Boolean(f[1]))
    .map(([k, v]) => `<div class="evidence__row"><span class="evidence__key">${esc(k)}</span><span class="evidence__val">${esc(v)}</span></div>`)
    .join('');
  return EventRow({
    state,
    title: rec.id,
    metadata: itemMetadata(rec, now),
    summary: rec.parkReason ? `Parked: ${rec.parkReason}` : 'Parked',
    body: rows ? `<div class="evidence">${rows}</div>` : undefined,
    badge: { state, label: rec.state },
    evidence: { id: rec.id, label: 'Timeline', href: `/item/${esc(rec.id)}` },
  });
}

/** The "Why isn't this building?" card: a read-only dispatch diagnosis for every queued item
 *  plus the raw park fields for every parked item. Pure projection of FoldResult.items — no
 *  new state, no client JS. Empty (returns '') when there is nothing queued or parked, so an
 *  otherwise-healthy board doesn't grow a permanently-empty card. */
function renderWhyNotBuilding(items: ItemRecord[], now: Date): string {
  const queued = items.filter((r) => r.state === 'queued');
  const parked = items.filter((r) => r.state === 'parked');
  if (queued.length === 0 && parked.length === 0) return '';

  const inflight = items.filter((r) => r.state === 'building' && r.lane !== 'planning');

  const queuedBody = queued.length
    ? queued.map((r) => whyNotBuildingQueuedRow(r, now, diagnoseQueued(r, inflight))).join('')
    : emptyState('Nothing queued', 'Queued items show a dispatch diagnosis here.');
  const parkedBody = parked.length
    ? parked.map((r) => whyNotBuildingParkedRow(r, now)).join('')
    : emptyState('Nothing parked', 'Parked items show their park reason here.');

  const body = `<h4 class="thread__title">Queued (${esc(queued.length)})</h4>${queuedBody}<h4 class="thread__title">Parked (${esc(parked.length)})</h4>${parkedBody}`;
  return Card({ title: "Why isn't this building?", body });
}

export function renderMissions(
  result: FoldResult,
  now: Date = new Date(),
  events: LedgerEvent[] = [],
  url: URL = new URL('http://localhost/missions'),
  theme?: string,
  repoRoot: string = process.cwd(),
): string {
  const items = [...result.items.values()];

  const groupsHtml = MISSION_GROUPS.map(({ label, states, filter }) => {
    const stateSet = new Set(states);
    const recs = items
      .filter((r) => stateSet.has(r.state) && (!filter || filter(r)))
      .sort((a, b) => {
        // Visual order must match dispatch's actual pick order: priority rank first
        // (high → medium → low), then recency. One rank map, mirroring the beat's.
        const rank = (r: ItemRecord): number => PRIORITY_RANK[r.priority ?? 'medium'] ?? 2;
        if (rank(a) !== rank(b)) return rank(a) - rank(b);
        const ta = a.transitions[a.state] ?? a.createdAt ?? '';
        const tb = b.transitions[b.state] ?? b.createdAt ?? '';
        return tb.localeCompare(ta);
      });

    const pageParam = `lanePage_${slugForParam(label)}`;
    const requestedPage = Number(url.searchParams.get(pageParam)) || 1;
    const { pageItems, page, pageCount, total } = paginate(recs, requestedPage, MISSIONS_LANE_PAGE_SIZE);
    const pager = Pagination({
      page,
      pageCount,
      total,
      itemNoun: 'items',
      hrefFor: (p) => pageHrefFor(url, pageParam, p),
      label: `${label} pages`,
    });

    const body = recs.length
      ? pageItems
          .map((r) => {
            const actions = runControlActions(r, '/missions', items);
            return itemRow(r, now, { returnTo: '/missions', actions, repoRoot });
          })
          .join('') + pager
      : emptyState('Nothing here', 'Items land in this lane as they move through the plane.');

    return Card({ title: `${label} (${recs.length})`, body });
  }).join('');

  const body = `<h1 class="opsui-page-title">Missions</h1>
<p class="opsui-page-updated">${esc(items.length)} item(s) total</p>
<div class="opsui-work">
${items.length === 0 ? Card({ title: 'The ledger is empty', body: emptyState('Nothing here yet', 'Capture your first intent on Command — the board fills in as work moves through captured → queued → building → merged.') }) : groupsHtml + renderWhyNotBuilding(items, now)}
</div>`;

  return page(
    {
      title: 'Missions — loopkit console',
      activeNav: 'missions',
      statusStrip: renderStatusStrip(result, events, now),
      theme,
      provenance: {
        generatedAt: now.toISOString(),
        eventCount: events.length,
        itemCount: result.items.size,
        cliEquivalents: [
          { label: 'Missions board, grouped by state', command: 'loopctl board' },
          { label: 'Item detail', command: 'loopctl state --item <WI-NNN>' },
        ],
      },
    },
    body,
  );
}

// ---------------------------------------------------------------------------
// View 3 — Item timeline (/item/<id>)
// ---------------------------------------------------------------------------

/** Payload fields an operator actually reads as prose, checked in this priority order so the
 *  first one present wins — e.g. an item.routed event shows the router's own `reply` sentence
 *  rather than its terser `route` tag. Rendered as a labeled phrase with generous truncation;
 *  only when NONE of these are present does the row fall back to a raw key=value dump. */
const HUMAN_SUMMARY_FIELDS: Array<[key: string, label: string]> = [
  ['text', 'Text'],
  ['reply', 'Reply'],
  ['reason', 'Reason'],
  ['spec', 'Spec'],
  ['priority', 'Priority'],
  ['route', 'Route'],
];

const HUMAN_SUMMARY_TRUNCATE = 200;

function summarizeEventData(data: Record<string, unknown>): string {
  for (const [key, label] of HUMAN_SUMMARY_FIELDS) {
    const v = data[key];
    if (typeof v === 'string' && v.length) {
      const clipped = v.length > HUMAN_SUMMARY_TRUNCATE ? v.slice(0, HUMAN_SUMMARY_TRUNCATE) + '…' : v;
      return `${label}: ${clipped}`;
    }
  }
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null || v === '') continue;
    const str = typeof v === 'string' ? v : JSON.stringify(v);
    const clipped = str.length > 60 ? str.slice(0, 60) + '…' : str;
    parts.push(`${k}=${clipped}`);
    if (parts.length >= 6) break;
  }
  return parts.join(' · ');
}

/** THE event-family → operational-colour mapping, mirroring
 *  `itemStateToOperational` above: captures/routing are neutral pipeline steps, messages are
 *  progress (conversation activity), gate/merge/deploy colour by their own outcome, and a park
 *  is always critical — the one family that always wants operator attention. Everything outside
 *  these named families (heal.*, session.*, cost.usage, …) renders neutral, the safe default. */
function eventFamilyToOperational(type: string): OperationalState {
  switch (type) {
    case 'item.captured':
    case 'item.routed':
    case 'item.queued':
    case 'item.claimed':
    case 'item.released':
    case 'conv.started':
    case 'conv.promoted':
    case 'conv.closed':
    case 'target.registered':
    case 'target.manifest-updated':
      return 'neutral';
    case 'msg.in':
    case 'msg.out':
    case 'item.feedback':
    case 'item.respec':
    case 'item.briefed':
      return 'progress';
    case 'gate.passed':
    case 'item.merged':
    case 'deploy.succeeded':
    case 'build.finished':
      return 'success';
    case 'gate.failed':
    case 'deploy.failed':
    case 'build.crashed':
      return 'critical';
    case 'gate.parked':
    case 'build.stalled':
    case 'build.cancelled':
      return 'warning';
    case 'item.parked':
      return 'critical';
    default:
      return 'neutral';
  }
}

/** ts (an event's own envelope timestamp, always UTC ISO-8601) rendered in the console host's
 *  local timezone — this is a single-operator, locally-run console (AGENTS.md), so "local" means
 *  the machine actually serving the page, computed at render time with zero client JS. */
function localTimestamp(ts: string): string {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? ts : d.toLocaleString();
}

/** One raw-ledger-event row, rendered through the shared EventRow component: type as title,
 *  actor + local timestamp as metadata, and a humanized data summary — coloured by
 *  `eventFamilyToOperational` so the same rail/badge convention that colours every other row in
 *  the console applies to raw ledger events too. The item timeline's own event feed (scoped to
 *  one item, so the item id is implicit) and the cross-item Activity feed (`/activity`, where it
 *  isn't) share this one renderer — pass `itemHref` to prefix the row's metadata with a link
 *  back to the item it belongs to. Exported for renderActivity (WI-055) — @loopkit/ui's
 *  EventRow and @loopkit/opsui's EventRow render identical `opsui-eventrow__*` markup, so this
 *  row is visually compatible with the shared opsui shell without a second implementation. */
export function timelineEntryRow(e: LedgerEvent, opts: { itemHref?: string } = {}): string {
  const metadata: EventRowMetaItem[] = [];
  if (opts.itemHref) metadata.push({ label: e.item, href: opts.itemHref });
  metadata.push(e.actor, localTimestamp(e.ts));
  return EventRow({
    state: eventFamilyToOperational(e.type),
    title: e.type,
    metadata,
    summary: summarizeEventData(e.data as Record<string, unknown>),
  });
}

/**
 * The deploy receipt: resolved from the item's own deploy.succeeded/deploy.failed events
 * (latest wins — a re-deploy after a failure supersedes it), falling back to the folded
 * ItemRecord.deployed/mergeCommit for callers that only have the record's own merge evidence
 * on hand. Shared by the item summary card and the acceptance desk's evidence block so the
 * two views can never disagree about whether — and what — shipped.
 */
function deployReceipt(rec: ItemRecord, itemEvents: LedgerEvent[]): { label: string; ok: boolean } | undefined {
  const deployEvents = itemEvents
    .filter((e) => e.item === rec.id && (e.type === 'deploy.succeeded' || e.type === 'deploy.failed'))
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));
  const last = deployEvents[deployEvents.length - 1];
  if (last) {
    const d = last.data as Record<string, unknown>;
    if (last.type === 'deploy.succeeded') {
      const commit = typeof d['commit'] === 'string' ? d['commit'] : rec.mergeCommit;
      return { label: commit ? `deployed ${commit}` : 'deployed', ok: true };
    }
    const reason = typeof d['reason'] === 'string' ? d['reason'] : undefined;
    return { label: reason ? `deploy failed — ${reason}` : 'deploy failed', ok: false };
  }
  if (rec.deployed === true) return { label: rec.mergeCommit ? `deployed ${rec.mergeCommit}` : 'deployed', ok: true };
  if (rec.deployed === false) return { label: 'deploy failed', ok: false };
  return undefined;
}

/** The deploy receipt row, rendered identically wherever it appears (item summary, acceptance
 *  evidence) — one markup shape for one piece of evidence. */
function deployReceiptRow(rec: ItemRecord, itemEvents: LedgerEvent[]): string {
  const receipt = deployReceipt(rec, itemEvents);
  const val = receipt ? receipt.label : 'not deployed';
  return `<div class="evidence__row"><span class="evidence__key">Deploy</span><span class="evidence__val">${esc(val)}</span></div>`;
}

/** The scout's brief (item.briefed → ItemRecord.brief): a read-only disclosure of the context
 *  pack a build agent had at branch point. Native <details>/<summary> — no JS, collapsed by
 *  default so it never crowds the row/card it sits on. Empty when the item was built cold. */
function briefDetails(rec: ItemRecord): string {
  if (!rec.brief) return '';
  return `<details class="evidence__details"><summary>Scout brief — ${esc(rec.brief.at)}</summary><div class="evidence__row"><span class="evidence__val">${esc(rec.brief.text)}</span></div></details>`;
}

// ---------------------------------------------------------------------------
// Build-artifact browser (System's "Recent artifacts" + the item page's "Evidence" card)
// ---------------------------------------------------------------------------

/**
 * WI-NNN-attempt-N.<kind> — the on-disk artifact naming convention dispatch/salvage write to
 * the plane's runs directory (see beats/dispatch.ts persistWorkerLog/persistGateLog/persistDiff
 * and salvage.ts captureSalvage). The ONE pattern for recognizing an artifact file — reused by
 * both this view's rendering and the download route's path validation (server.ts), so a file is
 * never servable that this browser didn't also enumerate.
 */
export const ARTIFACT_FILENAME_RE =
  /^(WI-\d+)-attempt-(\d+)\.(gate\.log|manifest\.json|salvage\.patch|salvage\.note|diff|log)$/;

/** Suffix → human label for each recognized artifact kind. */
export const ARTIFACT_KIND_LABELS: Record<string, string> = {
  log: 'Build log',
  'manifest.json': 'Context manifest',
  diff: 'Diff',
  'gate.log': 'Gate log',
  'salvage.patch': 'Salvage patch',
  'salvage.note': 'Salvage note',
};

/** One on-disk artifact, as enumerated by server.ts's read-only scan of the plane's runs dir. */
export interface ArtifactEntry {
  itemId: string;
  attempt: number;
  /** Human label (ARTIFACT_KIND_LABELS value). */
  kind: string;
  filename: string;
  /** '_' for the runs-root (untargeted lane); else the target id path segment. */
  targetSeg: string;
  mtimeMs: number;
}

/** Newest-first list of safe download links for a set of artifacts. `cap` truncates the
 *  DISPLAYED list (not the count reported); server.ts already filters this list to files the
 *  download route itself would agree to serve, so every link here resolves. */
function artifactList(entries: ArtifactEntry[], cap?: number): string {
  const sorted = [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!sorted.length) {
    return emptyState('No artifacts yet', 'Build attempts leave evidence files here once dispatch runs.');
  }
  const shown = cap ? sorted.slice(0, cap) : sorted;
  const rows = shown
    .map(
      (a) =>
        `<li><a href="/artifact/${esc(a.targetSeg)}/${esc(a.filename)}" download>${esc(a.itemId)} attempt ${esc(a.attempt)} — ${esc(a.kind)}</a></li>`,
    )
    .join('');
  const truncated = cap && sorted.length > cap
    ? `<div class="meta">…and ${esc(sorted.length - cap)} more</div>`
    : '';
  return `<ul class="filelist">${rows}</ul>${truncated}`;
}

/** The at-a-glance summary card that opens the item page, above the raw timeline — state, park
 *  kind, lane, target, touches, model, attempt count, created/updated timestamps and the deploy
 *  receipt, all fields already folded onto ItemRecord (or its own events for the deploy row). */
function renderItemSummary(rec: ItemRecord, itemEvents: LedgerEvent[]): string {
  const updatedAt = rec.transitions[rec.state] ?? rec.createdAt;
  const rows = [
    ['State', rec.state],
    ['Park kind', rec.parkKind ?? '—'],
    ['Lane', rec.lane],
    ['Target', rec.target ?? '(default)'],
    ['Touches', rec.touches ?? '—'],
    ['Model', rec.model ?? '—'],
    ['Attempts', String(rec.attempts)],
    ['Created', rec.createdAt ?? '—'],
    ['Updated', updatedAt ?? '—'],
  ]
    .map(([k, v]) => `<div class="evidence__row"><span class="evidence__key">${esc(k)}</span><span class="evidence__val">${esc(v)}</span></div>`)
    .join('\n');
  return `<div class="evidence">${rows}\n${deployReceiptRow(rec, itemEvents)}</div>${briefDetails(rec)}`;
}

/** Full-thread page size on the item's own timeline — the whole point of this view is to see
 *  the history, so it's far more generous than Command's compact preview. */
const ITEM_THREAD_PAGE_SIZE = 10;

export function renderItemTimeline(
  itemId: string,
  rec: ItemRecord | undefined,
  events: LedgerEvent[],
  now: Date = new Date(),
  result?: FoldResult,
  theme?: string,
  url: URL = new URL(`http://localhost/item/${encodeURIComponent(itemId)}`),
  artifacts: ArtifactEntry[] = [],
): string {
  const statusStrip = result ? renderStatusStrip(result, events, now) : undefined;

  if (!rec) {
    const body = `<h1 class="opsui-page-title">${esc(itemId)}</h1>${Card({ title: 'No such item', body: emptyState('No such item', `Nothing in the ledger is keyed ${esc(itemId)}.`) })}`;
    return page(
      {
        title: `${itemId} — loopkit console`,
        activeNav: 'missions',
        statusStrip,
        theme,
        provenance: {
          generatedAt: now.toISOString(),
          eventCount: 0,
          itemCount: result ? result.items.size : undefined,
          cliEquivalents: [{ label: 'Item lookup', command: `loopctl state --item ${itemId}` }],
        },
      },
      body,
    );
  }

  const itemEvents = events
    .filter((e) => e.item === itemId)
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));

  const rows = itemEvents.length
    ? itemEvents.map((e) => timelineEntryRow(e)).join('\n')
    : emptyState('No events yet');

  const returnTo = `/item/${encodeURIComponent(itemId)}`;
  const allItems = result ? [...result.items.values()] : [rec];
  const verbsCard = isDecisionPark(rec)
    ? Card({ title: 'Decide', body: EventRow({
        state: itemStateToOperational(rec.state),
        title: rec.id,
        metadata: itemMetadata(rec, now),
        actions: decisionActions(rec, returnTo),
      }) })
    : rec.state === 'merged'
    ? Card({ title: 'Accept', body: EventRow({
        state: itemStateToOperational(rec.state),
        title: rec.id,
        metadata: itemMetadata(rec, now),
        body: feedbackForm(rec.id, returnTo),
        actions: [acceptAction(rec.id, returnTo)],
      }) })
    : rec.state === 'building' || rec.state === 'queued' || isHeldPark(rec) || isOpsPark(rec)
    ? Card({ title: 'Run controls', body: EventRow({
        state: itemStateToOperational(rec.state),
        title: rec.id,
        metadata: itemMetadata(rec, now),
        actions: runControlActions(rec, returnTo, allItems),
      }) })
    : '';

  const threadSection = Card({
    title: 'Thread',
    body: threadCard(rec, result, {
      url,
      returnTo,
      pageParam: 'threadsPage',
      pageSize: ITEM_THREAD_PAGE_SIZE,
    }),
  });

  const state = itemStateToOperational(rec.state);
  const body = `<h1 class="opsui-page-title">${esc(rec.id)} ${StatusBadge({ state, label: rec.state })}</h1>
<p class="opsui-page-updated">${esc(itemEvents.length)} event(s)${rec.title ? ` · ${esc(rec.title)}` : ''}</p>
${verbsCard}
${Card({ title: 'Summary', body: renderItemSummary(rec, itemEvents) })}
${Card({ title: 'Evidence', body: artifactList(artifacts.filter((a) => a.itemId === itemId)) })}
${Card({ title: 'Timeline', body: rows })}
${threadSection}`;

  return page(
    {
      title: `${itemId} — loopkit console`,
      activeNav: 'missions',
      statusStrip,
      theme,
      provenance: {
        generatedAt: now.toISOString(),
        eventCount: itemEvents.length,
        itemCount: result ? result.items.size : allItems.length,
        cliEquivalents: [
          { label: 'Timeline', command: `loopctl events --item ${itemId}` },
          { label: 'Summary / evidence', command: `loopctl state --item ${itemId}` },
        ],
      },
    },
    body,
  );
}

// ---------------------------------------------------------------------------
// View 4 — Acceptance desk (/acceptance)
// ---------------------------------------------------------------------------

const TIER_ORDER: AcceptanceTier[] = ['must', 'review', 'optional', 'auto'];

/** Abbreviate a sha for display; the full value rides the title attribute (hover/long-press). */
function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 8) : '?';
}

/** must/review vs optional/auto — the only split the attended acceptance desk cares about.
 *  Attended mode has no auto-accept, so there is no timer to name; the split exists purely to
 *  keep the founder's attention on what actually needs a verdict. */
function isWaitingTier(tier: AcceptanceTier): boolean {
  return tier === 'must' || tier === 'review';
}

function renderEvidence(r: ItemRecord, events: LedgerEvent[] = []): string {
  const rows: string[] = [];
  if (r.mergeBaseSha || r.mergeHeadSha) {
    rows.push(
      `<div class="evidence__row"><span class="evidence__key">Range</span><span class="evidence__val" title="${esc(r.mergeBaseSha ?? '')}..${esc(r.mergeHeadSha ?? '')}">${esc(shortSha(r.mergeBaseSha))}..${esc(shortSha(r.mergeHeadSha))}</span></div>`,
    );
  }
  if (r.mergeGateCommand) {
    rows.push(
      `<div class="evidence__row"><span class="evidence__key">Gate</span><span class="evidence__val">${esc(r.mergeGateCommand)}</span></div>`,
    );
  }
  if (r.mergeCommit) {
    rows.push(
      `<div class="evidence__row"><span class="evidence__key">Commit</span><span class="evidence__val" title="${esc(r.mergeCommit)}">${esc(shortSha(r.mergeCommit))}</span></div>`,
    );
  }
  const files = r.mergeChangedFiles ?? [];
  if (files.length) {
    const listed = files.slice(0, 25).map((f) => `<li>${esc(f)}</li>`).join('');
    const truncated = r.mergeChangedFilesTruncated || files.length > 25
      ? `<div class="meta">…and ${esc(Math.max(0, files.length - 25))} more${r.mergeChangedFilesTruncated ? ' (list truncated at capture time)' : ''}</div>`
      : '';
    rows.push(
      `<div class="evidence__row"><span class="evidence__key">Files (${esc(files.length)})</span></div><ul class="filelist">${listed}</ul>${truncated}`,
    );
  } else {
    rows.push(`<div class="evidence__row"><span class="evidence__key">Files</span><span class="evidence__val">no code changed</span></div>`);
  }
  rows.push(deployReceiptRow(r, events));
  const fileCount = (r.mergeChangedFiles ?? []).length;
  const summary = `Evidence · ${shortSha(r.mergeCommit)} · ${fileCount} file${fileCount === 1 ? '' : 's'}`;
  // Collapsed by default: the desk's row shows one line; the receipts unfold on demand.
  return `<details class="evidence-details"><summary class="evidence-details__summary">${esc(summary)}</summary><div class="evidence">${rows.join('\n')}</div></details>`;
}

/** The tier classification config, derived from the plane's own LoopkitConfig — reuses core's classifier, never reimplements it. */
export function tierConfigFromLoopkitConfig(cfg: {
  autoApprove: { planePrefixes: string[]; escalationPatterns: string[] };
  acceptance?: {
    tiers?: {
      surfacePrefixes?: string[];
      confidenceFloor?: number;
    };
  };
}): AcceptanceTierClassifyConfig {
  return {
    surfacePrefixes: cfg.acceptance?.tiers?.surfacePrefixes ?? [],
    planePrefixes: cfg.autoApprove.planePrefixes,
    riskPatterns: cfg.autoApprove.escalationPatterns,
    confidenceFloor: cfg.acceptance?.tiers?.confidenceFloor,
  };
}

/** Zero-JS target filter chips — query-param links (All + one per registered target, plus an
 *  "Other" bucket for merged items whose target went unresolved). Attended mode is single-
 *  operator/multi-target (loopkit itself + every adopting repo), so the desk's default view
 *  mixes targets; a chip narrows to one repo's slices without hiding the rest. Progressive-
 *  enhancement free — it's just navigation, matching the shape of every other query-param
 *  filter in this file (windowQuery, pageHrefFor). */
function targetFilterChips(
  url: URL,
  targetNames: string[],
  active: string | undefined,
  counts: Map<string | undefined, number>,
  otherCount: number,
): string {
  const allCount = [...counts.values()].reduce((sum, n) => sum + n, 0) + otherCount;
  const chips: string[] = [
    renderTargetChip('All', undefined, active === undefined, allCount, url),
    ...targetNames.map((name) => renderTargetChip(name, name, active === name, counts.get(name) ?? 0, url)),
  ];
  if (otherCount > 0) chips.push(renderTargetChip('Other', '__other__', active === '__other__', otherCount, url));
  return `<div class="opsui-acceptance__filter" role="group" aria-label="Filter by target">${chips.join('')}</div>`;
}

function renderTargetChip(label: string, value: string | undefined, isActive: boolean, count: number, url: URL): string {
  const href = value === undefined ? url.pathname : `${url.pathname}?target=${encodeURIComponent(value)}`;
  const cls = `opsui-acceptance__filter-btn${isActive ? ' opsui-acceptance__filter-btn--active' : ''}`;
  return (
    `<a class="${cls}" href="${esc(href)}"` +
    (isActive ? ` aria-current="true"` : '') +
    `>${esc(label)}<span class="opsui-acceptance__filter-count">${esc(count)}</span></a>`
  );
}

/** One merged item's row: title, shipped-line (no countdown — attended mode has nothing that
 *  auto-accepts), tier badge, accept + "found a problem" actions, evidence. Shared by the
 *  waiting region and the collapsed lower-priority region so the two never drift. */
function acceptanceRow(rec: ItemRecord, tier: AcceptanceTier, now: Date, events: LedgerEvent[]): string {
  const state = tierToOperational(tier);
  return EventRow({
    state,
    title: `${rec.id} · ${shortText(rec)}`,
    metadata: [`shipped ${ageLabel(rec.mergedAt, now)} · ${rec.mergeCommit ? rec.mergeCommit.slice(0, 8) : '?'}`],
    badge: { state, label: tier },
    body: feedbackForm(rec.id, '/acceptance') + renderEvidence(rec, events),
    actions: [{ ...acceptAction(rec.id, '/acceptance'), label: 'Works — accept' }],
    evidence: { id: rec.id, label: 'Timeline', href: `/item/${esc(rec.id)}` },
  });
}

export function renderAcceptance(
  result: FoldResult,
  tierCfg: AcceptanceTierClassifyConfig,
  now: Date = new Date(),
  events: LedgerEvent[] = [],
  url: URL = new URL('http://localhost/acceptance'),
  theme?: string,
): string {
  const allMerged = [...result.items.values()].filter((r) => r.state === 'merged' && r.mergedAt);

  // Target filter (attended, multi-target desk): narrow to one registered target's slices
  // before tier classification, so the glance/waiting/lower-priority regions all agree with
  // the active chip. 'Other' catches merged items whose target never resolved to a name.
  const targetNames = [...result.targets.values()].map((t) => t.name);
  const activeTarget = url.searchParams.get('target') ?? undefined;
  const merged =
    activeTarget === undefined
      ? allMerged
      : activeTarget === '__other__'
        ? allMerged.filter((r) => r.target === undefined)
        : allMerged.filter((r) => r.target === activeTarget);

  const byTier = new Map<AcceptanceTier, { rec: ItemRecord; reason: string }[]>();
  for (const rec of merged) {
    const files = acceptanceClassifyFiles(rec.mergeChangedFiles, rec.touches);
    const { tier, reason } = classifyAcceptanceTier(
      files,
      rec.judgeVerdict,
      tierCfg,
      hasEvidenceGap(rec.mergeChangedFiles, rec.touches, {
        gateCommand: rec.mergeGateCommand,
        baseSha: rec.mergeBaseSha,
        headSha: rec.mergeHeadSha,
      }),
    );
    if (!byTier.has(tier)) byTier.set(tier, []);
    byTier.get(tier)!.push({ rec, reason });
  }
  for (const group of byTier.values()) {
    group.sort((a, b) => (a.rec.mergedAt ?? '').localeCompare(b.rec.mergedAt ?? ''));
  }

  const waiting = TIER_ORDER
    .filter(isWaitingTier)
    .flatMap((tier) => (byTier.get(tier) ?? []).map(({ rec }) => ({ rec, tier })))
    .sort((a, b) => (a.rec.mergedAt ?? '').localeCompare(b.rec.mergedAt ?? ''));
  const lowerPriority = TIER_ORDER
    .filter((t) => !isWaitingTier(t))
    .flatMap((tier) => (byTier.get(tier) ?? []).map(({ rec }) => ({ rec, tier })));

  let oldestWaitingAt: string | undefined;
  for (const { rec } of waiting) {
    if (rec.mergedAt && (!oldestWaitingAt || rec.mergedAt < oldestWaitingAt)) oldestWaitingAt = rec.mergedAt;
  }

  // Glance strip: what needs the founder now, what doesn't, how stale the oldest test is.
  const glanceTiles = [
    MetricTile({
      href: '/acceptance',
      label: 'To test',
      value: waiting.length,
      footnote: 'must + review',
      state: waiting.length ? 'warning' : 'success',
      open: { kind: 'projection', id: 'acceptance' },
    }),
    MetricTile({
      href: '/acceptance',
      label: 'Low-priority',
      value: lowerPriority.length,
      footnote: 'optional + auto',
      state: 'neutral',
      open: { kind: 'projection', id: 'acceptance' },
    }),
    MetricTile({
      href: '/acceptance',
      label: 'Oldest waiting',
      value: waiting.length ? ageLabel(oldestWaitingAt, now) : '—',
      footnote: waiting.length ? 'since it shipped' : 'nothing waiting',
      state: waiting.length ? 'warning' : 'success',
      open: { kind: 'projection', id: 'acceptance' },
    }),
  ];
  const glanceRegion = Card({
    variant: 'glance',
    title: 'Acceptance',
    subtitle: 'What is waiting on your verdict',
    body: `<div class="opsui-glancegrid">${glanceTiles.join('')}</div>`,
  });

  // "Waiting on your test" — must + review only, oldest first, always visible (no pagination:
  // this is the one region the founder must not have to click past).
  const waitingBody = waiting.length
    ? waiting.map(({ rec, tier }) => acceptanceRow(rec, tier, now, events)).join('')
    : `<p class="opsui-empty">Nothing waiting on your test.</p>`;
  const waitingRegion = Card({
    title: 'Waiting on your test',
    subtitle: 'Oldest first — test it, then record your verdict',
    headerAside: StatusBadge({
      state: waiting.length ? 'warning' : 'success',
      label: waiting.length ? `${waiting.length} to test` : 'Clear',
      ...(waiting.length ? { emphasis: 'recommended' as const } : {}),
    }),
    body: waitingBody,
  });

  // "Lower priority" — optional + auto, folded into one collapsed <details>. Attended mode has
  // no auto-accept timer, so this is purely "nothing to do here right now", not a countdown.
  const lowerPriorityRegion = lowerPriority.length
    ? `<details class="opsui-acceptance__collapse"><summary>Lower priority — ${esc(lowerPriority.length)} · no auto-accept while attended</summary>${lowerPriority
        .map(({ rec, tier }) => acceptanceRow(rec, tier, now, events))
        .join('')}</details>`
    : '';

  // Target filter chips: All + one per registered target, counted against the UNFILTERED
  // merged set (a chip's own count never changes when you're standing on it).
  const countsByTarget = new Map<string | undefined, number>();
  let otherCount = 0;
  for (const rec of allMerged) {
    if (rec.target === undefined) {
      otherCount += 1;
      continue;
    }
    countsByTarget.set(rec.target, (countsByTarget.get(rec.target) ?? 0) + 1);
  }
  const filterChips = targetFilterChips(url, targetNames, activeTarget, countsByTarget, otherCount);

  const awaitingLine = waiting.length
    ? `${esc(waiting.length)} awaiting your verdict · oldest ${esc(ageLabel(oldestWaitingAt, now))}`
    : 'nothing awaiting your verdict';

  const body = `<h1 class="opsui-page-title">Acceptance</h1>
<p class="opsui-page-updated">${awaitingLine}</p>
<div class="opsui-acceptance" data-projection="acceptance">
${glanceRegion}
${filterChips}
${merged.length ? waitingRegion + lowerPriorityRegion : Card({ title: 'Nothing awaiting acceptance', body: emptyState('Nothing awaiting acceptance', 'Merged slices land here as soon as they ship.') })}
</div>`;

  return page(
    {
      title: 'Acceptance — loopkit console',
      activeNav: 'acceptance',
      statusStrip: renderStatusStrip(result, events, now),
      theme,
      provenance: {
        generatedAt: now.toISOString(),
        eventCount: events.length,
        itemCount: result.items.size,
        cliEquivalents: [
          { label: 'Acceptance queue, grouped by tier', command: 'loopctl summary' },
          { label: 'Accept a merged item', command: 'loopctl accept <WI-NNN>' },
        ],
      },
    },
    body,
  );
}

// ---------------------------------------------------------------------------
// View 5 — System (/system)
// ---------------------------------------------------------------------------

export interface SegmentInfo {
  name: string;
  bytes: number;
}

function stateForAge(hours: number | undefined): OperationalState {
  if (hours === undefined) return 'critical';
  if (hours > 24) return 'warning';
  return 'success';
}

/** Cap on the "Recent artifacts" list on /system — a long-running plane can accumulate
 *  thousands of attempt files; the item page's Evidence card has no such cap since it's
 *  already scoped to one item's handful of attempts. */
const SYSTEM_ARTIFACT_LIST_CAP = 50;

/**
 * SLO-status → badge colour for every SLO-shaped status these views render (a colour
 * meaning is chosen exactly once per module surface). analytics.ts holds
 * an identical PRIVATE mapping for its own panes — integrator remainder: export it there and
 * delete this copy so the whole console is back to literally one function.
 */
function sloStatusState(status: SloRow['status']): OperationalState {
  switch (status) {
    case 'met': return 'success';
    case 'at-risk': return 'warning';
    case 'breached': return 'critical';
    default: return 'neutral';
  }
}

/** Compact minutes formatter for SLO row values (m → h → d, same shape everywhere). */
function fmtMin(min: number): string {
  if (!Number.isFinite(min)) return '—';
  if (min >= 1440) return `${(min / 1440).toFixed(1)}d`;
  if (min >= 60) return `${(min / 60).toFixed(1)}h`;
  return `${Math.round(min)}m`;
}

/** SLO rows pulled from evaluateSloBoard's full board into the /system rollup — the pipeline
 *  keys the ledger alone can feed probes for. The other board rows (deploy, backup, launchd,
 *  watch, provider, …) need live OS/HTTP probes this pure ledger→HTML view never shells out
 *  for, so they're left off rather than rendered as a permanent false 'unknown'. */
const SLO_ROLLUP_KEYS: readonly SloRow['key'][] = ['loop-reactor', 'loop-dispatch', 'unrouted', 'acceptance', 'decisions'];

/**
 * SLO rollup leading /system: intent-routing latency (analytics.ts's own SLO, no
 * evaluateSloBoard row exists for it) plus the ledger-derivable rows of evaluateSloBoard's
 * board (reactor/dispatch beat heartbeat freshness from the latest reactor/dispatch-actor
 * event timestamps, unrouted backlog, acceptance backlog age, decisions-waiting age).
 * Status colours come from the ONE sloStatusState mapping above — no second
 * met/at-risk/breached → colour translation per row.
 */
function sloRollupCard(events: LedgerEvent[], result: FoldResult, sloConfig: SloConfig, now: Date): string {
  const nowMs = now.getTime();

  let reactorLastMs: number | undefined;
  let dispatchLastMs: number | undefined;
  for (const e of events) {
    const ts = Date.parse(e.ts);
    if (!Number.isFinite(ts)) continue;
    if (e.actor === 'reactor' && (reactorLastMs === undefined || ts > reactorLastMs)) reactorLastMs = ts;
    if (e.actor === 'dispatch' && (dispatchLastMs === undefined || ts > dispatchLastMs)) dispatchLastMs = ts;
  }

  const items = Array.from(result.items.values());
  const unroutedItems = items.filter((r) => r.state === 'captured');
  let oldestUnroutedMin: number | undefined;
  for (const rec of unroutedItems) {
    const capAt = rec.capturedAt ?? rec.createdAt;
    if (capAt) {
      const ageMin = (nowMs - new Date(capAt).getTime()) / 60_000;
      oldestUnroutedMin = oldestUnroutedMin === undefined ? ageMin : Math.max(oldestUnroutedMin, ageMin);
    }
  }

  const decisionItems = items.filter(isDecisionPark);
  let oldestDecisionHours: number | undefined;
  for (const rec of decisionItems) {
    if (rec.parkedAt) {
      const ageH = (nowMs - new Date(rec.parkedAt).getTime()) / 3_600_000;
      oldestDecisionHours = oldestDecisionHours === undefined ? ageH : Math.max(oldestDecisionHours, ageH);
    }
  }

  const { acceptanceCount, oldestAcceptanceHours } = computeAcceptanceDebt(result, nowMs);

  const probes: SloProbes = {
    now: () => nowMs,
    reactorLastrun: () => (reactorLastMs !== undefined ? reactorLastMs / 1000 : undefined),
    dispatchLastrun: () => (dispatchLastMs !== undefined ? dispatchLastMs / 1000 : undefined),
    fold: (): FoldProbeData => ({
      unrouted: { count: unroutedItems.length, oldestMin: oldestUnroutedMin },
      oldestAcceptanceHours,
      acceptanceCount,
      oldestDecisionHours,
      decisionCount: decisionItems.length,
    }),
  };

  const board = evaluateSloBoard(sloConfig, probes, events);
  const boardByKey = new Map(board.map((r) => [r.key, r]));

  const routing = computeRoutingLatency(events, nowMs);
  const routingValue = routing.sampled === 0
    ? (routing.pending > 0 ? `${routing.pending} awaiting first reply` : 'no traffic')
    : `median ${fmtMin(routing.medianMin!)} · worst ${fmtMin(routing.worstMin!)} (7d)`;

  const rows: { label: string; value: string; target: string; status: SloRow['status'] }[] = [
    { label: 'Intent routing latency', value: routingValue, target: `worst ≤ ${ROUTING_TARGET_MIN}m (24h)`, status: routing.status },
  ];
  for (const key of SLO_ROLLUP_KEYS) {
    const row = boardByKey.get(key);
    if (row) rows.push({ label: row.label, value: row.value, target: row.target, status: row.status });
  }

  const breached = rows.filter((r) => r.status === 'breached').length;
  const atRisk = rows.filter((r) => r.status === 'at-risk').length;
  const rollupState: OperationalState = breached > 0 ? 'critical' : atRisk > 0 ? 'warning' : 'success';

  const rowsHtml = rows
    .map((r) =>
      `<tr><td>${esc(r.label)}</td><td>${esc(r.value)}</td><td>${esc(r.target)}</td>` +
      `<td>${StatusBadge({ state: sloStatusState(r.status), label: r.status, size: 'sm' })}</td></tr>`)
    .join('\n');

  const summary =
    `<div class="analytics-slo-row">` +
    StatusBadge({ state: rollupState, label: `${breached} breached · ${atRisk} at-risk`, size: 'md' }) +
    `</div>`;

  return Card({
    title: 'SLO rollup',
    subtitle: 'Routing, backlog age, and beat heartbeat — derived from the ledger, no live probes',
    body: `${summary}<table><thead><tr><th>SLO</th><th>Value</th><th>Target</th><th>Status</th></tr></thead>` +
      `<tbody>${rowsHtml}</tbody></table>`,
  });
}

// ---------------------------------------------------------------------------
// Self-heal activity feed (System) — the doctor's audit trail
// ---------------------------------------------------------------------------

/** The six heal.* ledger event types (schema.ts) — the ONE list this feed filters on. */
const HEAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'heal.proposed',
  'heal.executed',
  'heal.verified',
  'heal.escalated',
  'heal.graduated',
  'heal.shadowed',
]);

/** Outcome text + badge colour for one heal.* event, from its schema.ts payload shape.
 *  Badge colours reuse the console's shared OperationalState vocabulary — no heal-local
 *  colour scheme. */
function healOutcome(e: LedgerEvent): { outcome: string; state: OperationalState } {
  const d = e.data as Record<string, unknown>;
  const s = (k: string): string => (typeof d[k] === 'string' ? (d[k] as string) : '');
  switch (e.type) {
    case 'heal.proposed':
      return { outcome: `proposed${s('tier') ? ` (${s('tier')})` : ''}${s('detail') ? ` — ${s('detail')}` : ''}`, state: 'progress' };
    case 'heal.executed':
      return { outcome: s('evidence') ? `executed — ${s('evidence')}` : 'executed', state: 'info' };
    case 'heal.verified':
      return { outcome: 'verified — breach cleared', state: 'success' };
    case 'heal.escalated':
      return { outcome: `escalated — ${s('reason') || 'unresolved'}${typeof d['count'] === 'number' ? ` (×${d['count']})` : ''}`, state: 'critical' };
    case 'heal.graduated':
      return { outcome: 'graduated — shadow burn-in complete', state: 'success' };
    case 'heal.shadowed':
      return { outcome: `shadow — would have: ${s('wouldHave') || s('action') || '?'}`, state: 'neutral' };
    default:
      return { outcome: e.type, state: 'neutral' };
  }
}

/** Rule key for a heal.* event — every heal payload shape carries `key` (runbooks.ts keys). */
function healRuleKey(e: LedgerEvent): string {
  const key = (e.data as Record<string, unknown>)['key'];
  return typeof key === 'string' ? key : '?';
}

/** Action taken (or considered) — heal.escalated/graduated payloads carry no action. */
function healAction(e: LedgerEvent): string {
  const action = (e.data as Record<string, unknown>)['action'];
  return typeof action === 'string' && action ? action : '—';
}

/**
 * Self-heal activity feed: everything the doctor did to (or observed about) the plane —
 * the six heal.* types, newest first, with rule key, action taken, and outcome, scoped by
 * the shared 24h/7d/30d window grammar (parseTimeWindow — the ONE window parser; the picker
 * chips are plain GET links). Without this card the heal domain is invisible to the operator.
 */
function healActivityCard(events: LedgerEvent[], url: URL, now: Date): string {
  const windowSpec = parseTimeWindow(url.searchParams.get('window'), '24h');
  const cutoff = windowCutoffMs(windowSpec, now.getTime());
  const heals = events
    .filter((e) => HEAL_EVENT_TYPES.has(e.type))
    .filter((e) => cutoff === null || new Date(e.ts).getTime() >= cutoff)
    .sort((a, b) => b.ts.localeCompare(a.ts) || b.id.localeCompare(a.id));

  const rowsHtml = heals
    .map((e) => {
      const { outcome, state } = healOutcome(e);
      return `<tr><td><span class="meta">${esc(ageLabel(e.ts, now))} ago</span></td>` +
        `<td><code>${esc(healRuleKey(e))}</code></td>` +
        `<td>${esc(healAction(e))}</td>` +
        `<td>${StatusBadge({ state, label: e.type.slice('heal.'.length), size: 'sm' })} ${esc(outcome)}</td></tr>`;
    })
    .join('\n');

  const body = heals.length
    ? `<p class="analytics-caption">${esc(heals.length)} heal event(s) · ${esc(windowSpec.label)}</p>` +
      `<table><thead><tr><th>When</th><th>Rule</th><th>Action</th><th>Outcome</th></tr></thead><tbody>${rowsHtml}</tbody></table>`
    : emptyState(
        `No self-heal activity (${windowSpec.label})`,
        'When the plane heals itself, the heal.* trail — proposals, executions, verifications, escalations, shadow runs — lands here.',
      );

  return Card({
    title: 'Self-heal activity',
    subtitle: "What the plane did to itself — the doctor's audit trail, newest first",
    headerAside: WindowPicker({ active: windowSpec.key, options: ['24h', '7d', '30d'], extraQuery: windowQuery(url) }),
    body,
  });
}

export function renderSystem(
  events: LedgerEvent[],
  segments: SegmentInfo[],
  now: Date = new Date(),
  itemCount?: number,
  theme?: string,
  artifacts: ArtifactEntry[] = [],
  url: URL = new URL('http://localhost/system'),
  sloConfig: SloConfig = {},
): string {
  let lastTs: string | undefined;
  const countsByType = new Map<string, number>();
  let eventsThisMonth = 0;
  const monthPrefix = now.toISOString().slice(0, 7); // YYYY-MM
  for (const e of events) {
    if (!lastTs || e.ts > lastTs) lastTs = e.ts;
    countsByType.set(e.type, (countsByType.get(e.type) ?? 0) + 1);
    if (e.ts.startsWith(monthPrefix)) eventsThisMonth += 1;
  }

  const lastEventAgeHours = lastTs ? (now.getTime() - new Date(lastTs).getTime()) / 3_600_000 : undefined;
  const lastEventAge = lastTs ? ageLabel(lastTs, now) : 'never';
  const totalBytes = segments.reduce((sum, s) => sum + s.bytes, 0);

  const tiles: string[] = [
    MetricTile({
      href: '/system',
      label: 'Last event',
      value: lastEventAge,
      footnote: lastTs ?? 'no events yet',
      state: stateForAge(lastEventAgeHours),
      open: { kind: 'projection', id: 'system' },
    }),
    MetricTile({
      href: '/system',
      label: 'Events this month',
      value: String(eventsThisMonth),
      footnote: monthPrefix,
      open: { kind: 'projection', id: 'system' },
    }),
    MetricTile({
      href: '/system',
      label: 'Total events',
      value: String(events.length),
      footnote: `${segments.length} segment(s)`,
      open: { kind: 'projection', id: 'system' },
    }),
    MetricTile({
      href: '/system',
      label: 'Ledger size',
      value: `${(totalBytes / 1024).toFixed(1)} KB`,
      footnote: `${segments.length} file(s)`,
      open: { kind: 'projection', id: 'system' },
    }),
  ];
  if (itemCount !== undefined) {
    tiles.splice(
      2,
      0,
      MetricTile({
        href: '/missions',
        label: 'Items tracked',
        value: String(itemCount),
        footnote: 'across every state',
        open: { kind: 'projection', id: 'missions' },
      }),
    );
  }

  const tilesHtml = `<div class="opsui-glancegrid">${tiles.join('')}</div>`;

  const segRows = segments.length
    ? segments
        .map((s) => `<tr><td><code>${esc(s.name)}</code></td><td>${esc(s.bytes.toLocaleString())} bytes</td></tr>`)
        .join('\n')
    : `<tr><td colspan="2" class="empty">no segments</td></tr>`;

  const typeRows = [...countsByType.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `<tr><td><code>${esc(type)}</code></td><td>${esc(count)}</td></tr>`)
    .join('\n');

  const body = events.length === 0
    ? `<h1 class="opsui-page-title">System</h1>
${Card({ title: 'No ledger activity yet', body: emptyState('No ledger activity yet', 'System tiles fill in once the first event lands — capture an intent on Command to get started.') })}`
    : `<h1 class="opsui-page-title">System</h1>
${sloRollupCard(events, fold(events), sloConfig, now)}
${tilesHtml}
${healActivityCard(events, url, now)}
${Card({ title: 'Activity feed', subtitle: 'The newest ledger events across every item, newest first', body: Button({ label: 'Open activity feed', href: '/activity', variant: 'secondary' }) })}
${Card({ title: `Segments (${segments.length})`, body: `<table>${segRows}</table>` })}
${Card({ title: 'Event counts by type', body: `<table>${typeRows || '<tr><td colspan="2" class="empty">no events</td></tr>'}</table>` })}
${Card({ title: `Recent artifacts (${artifacts.length})`, body: artifactList(artifacts, SYSTEM_ARTIFACT_LIST_CAP) })}`;

  return page(
    {
      title: 'System — loopkit console',
      activeNav: 'system',
      refreshSeconds: 30,
      theme,
      provenance: {
        generatedAt: now.toISOString(),
        eventCount: events.length,
        itemCount,
        cliEquivalents: [
          { label: 'SLO rollup / segments / event counts', command: 'loopctl doctor' },
          { label: 'Recent events', command: 'loopctl events --recent 50' },
        ],
      },
    },
    body,
  );
}

// ---------------------------------------------------------------------------
// View — Activity (/activity)
// ---------------------------------------------------------------------------

/** Rows per Activity page — "the newest ~50 ledger events" is the page size, not a hard cap;
 *  the shared pager below carries an operator to older pages the same way it does everywhere
 *  else in the console. */
const ACTIVITY_PAGE_SIZE = 50;

/**
 * Cross-item activity feed: the whole ledger's events, newest first, one row per event via the
 * same `timelineEntryRow` renderer the per-item timeline uses — reachable from System, read-only.
 * Rows link back to their item when it's a real, folded item (system-scoped events like heal.*
 * carry a sentinel `item` that resolves to nothing, so they render with no link).
 *
 * SUPERSEDED (WI-055 item 1): the live `/activity` route now renders through opsPages.ts's
 * `renderActivityPage` (the shared opsui shell, same chrome as every other page) — this
 * function still renders through html.ts's pre-WI-053 `page()` shell and is no longer called
 * from server.ts. Kept exported (not part of index.ts's public API) rather than deleted, since
 * pruning views.ts's now-dead legacy renderer surface is the separate API decision the header
 * comment above already flags, not this convergence.
 */
export function renderActivity(
  events: LedgerEvent[],
  result: FoldResult,
  now: Date = new Date(),
  theme?: string,
  url: URL = new URL('http://localhost/activity'),
): string {
  const sorted = [...events].sort((a, b) => b.ts.localeCompare(a.ts) || b.id.localeCompare(a.id));
  const requestedPage = Number(url.searchParams.get('page')) || 1;
  const { pageItems, page: currentPage, pageCount, total } = paginate(sorted, requestedPage, ACTIVITY_PAGE_SIZE);
  const pager = Pagination({
    page: currentPage,
    pageCount,
    total,
    itemNoun: 'events',
    hrefFor: (p) => pageHrefFor(url, 'page', p),
    label: 'Activity pages',
  });

  const feed = pageItems.length
    ? pageItems
        .map((e) =>
          timelineEntryRow(e, { itemHref: result.items.has(e.item) ? `/item/${encodeURIComponent(e.item)}` : undefined }),
        )
        .join('\n') + pager
    : emptyState('No ledger activity yet', 'Events land here the moment the first item is captured.');

  const body = `<h1 class="opsui-page-title">Activity</h1>
<p class="opsui-page-updated">${esc(total)} event(s) across the ledger, newest first</p>
${Card({ title: 'Activity', body: feed })}`;

  return page(
    {
      title: 'Activity — loopkit console',
      activeNav: 'system',
      theme,
      provenance: {
        generatedAt: now.toISOString(),
        eventCount: events.length,
        itemCount: result.items.size,
        cliEquivalents: [{ label: 'Recent events across every item', command: 'loopctl events --recent 50' }],
      },
    },
    body,
  );
}

// WI-054: the legacy operator-configured markdown page (renderKnowledge +
// KnowledgeSection/KnowledgeDoc + their card helpers) is retired. Its role — surfacing
// operator-declared reference docs — moved onto the /company page, which now
// renders knowledge sources (markdown cards + parsed decision logs) via opsPages.ts's
// renderCompanyPage over the same `knowledge` config, upgraded to source objects.

// ---------------------------------------------------------------------------
// View 6 — Analytics (/analytics) — lives in analytics.ts, re-exported here so every view
// keeps one import point.
// ---------------------------------------------------------------------------

export { renderAnalytics } from './analytics.js';
export type { AnalyticsExtras } from './analytics.js';
