// Command projection — the founder's operating picture, composed
// ONLY from shared components: glance metrics, conductor, company
// stream, decision desk, ops health, pipeline, and provenance. The renderer takes a
// typed `ProjectionEnvelope<CommandData>` and returns the workspace HTML the AppShell
// slots in. On a failed envelope it renders `ProjectionFailure`, never stale data.

import { Card } from '../components/Card.ts';
import { EventRow } from '../components/EventRow.ts';
import { MetricTile, type MetricOpen } from '../components/MetricTile.ts';
import { Pagination } from '../components/Pagination.ts';
import { ProjectionFailure } from '../components/ProjectionFailure.ts';
import { StatusBadge } from '../components/StatusBadge.ts';
import { WindowPicker } from '../components/WindowPicker.ts';
import { esc } from '../render/html.ts';
import type { OperationalState } from '../states/operational-state.ts';
import { DEFAULT_GLANCE_WINDOW } from './fold-adapter.ts';
import type { GlancePulse, GlanceWindow } from './fold-adapter.ts';
import type { ProjectionEnvelope } from './projection-types.ts';
import type { ThreadCard } from './threads-adapter.ts';

/** One recent ext:-sourced intent item for the durable capture trail (WI-178). `foldState`
 *  stays the raw fold lifecycle string (the observable contract recent-intents.test.ts
 *  pins) — `opState`/`statusLabel` are the ONE catalog-derived tone+label pair (WI-086/
 *  WI-087 status-catalog.ts), so the strip renders the identical badge Missions/the item
 *  hub render for the same item, instead of the bare foldState string. */
export type RecentIntent = {
  id: string;
  text: string;
  foldState: string;
  opState: OperationalState;
  /** Catalog label (status-catalog.ts) — e.g. 'Queued — routing…', not the bare foldState. */
  statusLabel: string;
  externalRef?: string;
  timestamp?: string;
  timelineHref: string;
  threadHref?: string;
};

/** One glance metric — projection-owned shape. */
export type GlanceMetric = {
  /** Drill target — the tile renders as a link (glance→drill). */
  href?: string;
  label: string;
  value: string | number;
  footnote: string;
  state: OperationalState;
  open: MetricOpen;
};

/** Structured 4-field decision block for parked items (WI-195).
 *  All string values are plain text — the renderer escapes them. */
export type DecisionBlock = {
  /** One-liner describing what the work item does. */
  whatItIs: string;
  /** Plain-language translation of the park-reason class. */
  whyParked: string;
  /** What clicking Approve will do — always deterministic. */
  whatApproves: string;
  /** Derived recommendation, absent when not derivable without LLM. */
  recommendation?: string;
  /** Original raw park reason string — shown in a <details> toggle. */
  rawReason: string;
  /** parkKind-aware "what unblocks this" line — every decision-desk card
   *  reads 'decision' (that's the only kind reaching this desk), but the field is carried
   *  through the shared shape so the same line renders identically on every surface that
   *  shows a parked item (work-adapter.ts unblockNote — one parser, single-reader discipline). */
  unblock: string;
  /**
   * Leader-leader escalation-with-intent payload (item.parked.escalation), when the emitter
   * supplied one. Present only when all four fields were captured (fold-adapter.ts derives
   * this all-or-nothing) — absent renders the block exactly as before (whatItIs/whyParked
   * derived from the raw reason), so old parks never show a half-filled escalation section.
   */
  escalation?: { intent: string; evidence: string; risk: string; recommendation: string };
};

/** One human-readable stream/desk event — projection-owned shape. */
export type CommandEvent = {
  state: OperationalState;
  title: string;
  metadata: string[];
  summary?: string;
  /** Structured decision block — set only on decision desk (parked) items. Rendered
   *  as a 4-field block between meta and actions; replaces the raw summary text. */
  decisionBlock?: DecisionBlock;
  badge?: { state: OperationalState; label: string; emphasis?: 'default' | 'blocking' | 'recommended' };
  /** WI-180 origin chip (target / plane / mixed), derived once at the fold boundary. */
  originChip?: { state: OperationalState; label: string };
  actions?: Array<{ id: string; label: string; emphasis?: 'default' | 'primary' | 'danger'; form?: { action: string; intent: string } }>;
  evidence?: { id: string; label: string; href?: string };
};

/** One pipeline stage count — the conductor's throughput at a glance. */
export type PipelineStage = {
  label: string;
  count: number;
  state: OperationalState;
};

/** Rows for the "Active ops-parks" visibility card (WI-354) — reuses the generic
 *  `CommandEvent` shape (id/age/attempts/retry-state in `metadata`, no `actions`) so it
 *  renders through the same `eventList()`/`EventRow` path as every other Command region.
 *  Visibility only: these parks are plane-owned — never a founder action
 *  target here. */
export type OpsParksCard = CommandEvent[];

/** Command's own flow-ordered picture of the build lane (WI-355), replacing the "Why isn't
 *  this building?" diagnostic. Three stages, left to right in time: `preparing` (captured/
 *  routed, not yet queued), `queued` (dispatch pick order, existing why-not-picked reasons),
 *  `building` (in-flight workers — the same rows Conductor renders, reshaped). Parked items
 *  never appear here — they are plane-owned (ops) or founder-owned (decision), and already
 *  render on the Active ops-parks card / decision desk (ops parks are plane-owned — never a
 *  founder action target) — this pipeline would otherwise duplicate them. */
export type PipelineFlow = {
  preparing: CommandEvent[];
  queued: CommandEvent[];
  building: CommandEvent[];
};

/** The typed payload the command projection renders. */
export type CommandData = {
  glance: GlanceMetric[];
  /** True when the three alarm tiles (Decisions/To test/Stuck) are all zero — Glance collapses
   *  to a single "All clear" line + pulse teaser instead of the five tiles. Derived once at the
   *  fold boundary (fold-adapter.ts buildGlance), never re-derived from `glance` here (one parser,
   *  single-reader discipline). */
  glanceAllClear: boolean;
  /** The compact "what's actually happening" teaser shown under the All-clear line. */
  glancePulse: GlancePulse;
  conductor: { headline: string; state: OperationalState; workers: CommandEvent[] };
  deliveryStream: CommandEvent[];
  decisionDesk: CommandEvent[];
  /** WI-128: shipped slices actually awaiting a works/found-a-problem verdict, oldest first —
   *  Command's own To-test region, distinct from the Glance "To test" tile (a count + link).
   *  Shares fold-adapter.ts's `isAwaitingVerdict` predicate with that tile so the two counts
   *  can never disagree. */
  toTest: CommandEvent[];
  /** WI-354: active ops-parks the STUCK glance tile doesn't (yet) flag — the blind window
   *  between "just parked" and "breaker-tripped or 6h+ stale" (see fold-adapter.ts buildOpsParks). */
  opsParks: OpsParksCard;
  opsHealth: { headline: string; state: OperationalState };
  pipeline: PipelineStage[];
  /** Last ~5 founder-sourced (ext:*) items from the last 24h — the recent-intents strip (WI-178). */
  recentIntents: RecentIntent[];
  /** Nav IA rewire: the former standalone Threads page's conversation history, folded
   *  into Command as a region. The `threads` route keeps serving directly (deep links,
   *  the reply composer) — this is the same data, composed here so the founder doesn't
   *  have to leave Command to see or reply to a thread. */
  threads: ThreadCard[];
  /** WI-355: the Pipeline region's three flow-ordered stages — see {@link PipelineFlow}. */
  pipelineFlow: PipelineFlow;
};

// ─── Decision block renderer ──────────────────────────────────────────────────

/** Command's decision-desk card renders only a truncated WHAT + WHY-PARKED — the
 *  full 5-field block (approving-does / unblock / recommendation / raw reason) lives
 *  in the item hub, reached via the card's "Item detail →" evidence link: Command answers
 *  "what do I need to decide", the hub answers "tell me everything about it". */
const DECISION_WHY_PARKED_TRUNCATE = 140;

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

function renderDecisionBlock(block: DecisionBlock): string {
  const field = (label: string, value: string): string =>
    `<div class="opsui-decisionblock__field">` +
    `<dt class="opsui-decisionblock__label">${esc(label)}</dt>` +
    `<dd class="opsui-decisionblock__value">${esc(value)}</dd>` +
    `</div>`;

  // Leader-leader escalation payload (WI-056): when the park's emitter stated an
  // intent/evidence/risk/recommendation, render those four labeled rows INSTEAD of the
  // derived whatItIs/whyParked pair — the emitter's own words are more precise than a
  // string-classified guess. Absent escalation falls back to the original derived pair
  // unchanged, so a park without an escalation payload renders exactly as before.
  const fields = block.escalation
    ? field('Intent', block.escalation.intent) +
      field('Evidence', block.escalation.evidence) +
      field('Risk', block.escalation.risk) +
      field('Recommendation', block.escalation.recommendation)
    : field('What it is', block.whatItIs) +
      field('Why parked', truncate(block.whyParked, DECISION_WHY_PARKED_TRUNCATE));

  return `<div class="opsui-decisionblock"><dl class="opsui-decisionblock__fields">${fields}</dl></div>`;
}

// ─── Region renderers (each composes shared components only) ──────────────────

/** Human phrase for a shipped window — the pulse row names the window the count covers so it
 *  reads honestly when the picker changes ("last 24h" / "last 7 days"). */
const WINDOW_PHRASE: Record<GlanceWindow, string> = {
  '24h': 'last 24h',
  '7d': 'last 7 days',
  '30d': 'last 30 days',
};

/** One pulse teaser row — a colour-coded StatusBadge chip (from the design system, so the pulse
 *  isn't a wall of plain text) beside a compact body. Deep-links to the item/region it summarizes.
 *  `head` is an optional id/age line above the 2-line-clamped `text`. */
function pulseRow(opts: { href: string; badge: string; head?: string; text: string; clamp?: boolean }): string {
  const head = opts.head ? `<span class="opsui-glance-pulse__head">${opts.head}</span>` : '';
  const textClass = opts.clamp ? 'opsui-glance-pulse__text opsui-glance-pulse__text--clamp' : 'opsui-glance-pulse__text';
  return (
    `<a class="opsui-glance-pulse__row" href="${esc(opts.href)}">` +
    opts.badge +
    `<span class="opsui-glance-pulse__body">${head}<span class="${textClass}">${opts.text}</span></span>` +
    `</a>`
  );
}

function pulseRegion(pulse: GlancePulse): string {
  const rows: string[] = [];
  for (const b of pulse.building) {
    const head =
      `<span class="opsui-glance-pulse__id">${esc(b.id)}</span>` +
      (b.age ? `<span class="opsui-glance-pulse__age">${esc(b.age)}</span>` : '');
    rows.push(pulseRow({
      href: b.href,
      badge: StatusBadge({ state: 'progress', label: 'Building', size: 'sm' }),
      head,
      text: esc(b.title),
      clamp: true,
    }));
  }

  const queueText = pulse.queue.next
    ? `${pulse.queue.depth} queued · next ${esc(pulse.queue.next.title)}`
    : `${pulse.queue.depth} queued`;
  rows.push(pulseRow({
    href: pulse.queue.next?.href ?? '/work',
    badge: StatusBadge({ state: pulse.queue.depth > 0 ? 'info' : 'neutral', label: 'Queue', size: 'sm' }),
    text: queueText,
  }));

  rows.push(pulseRow({
    href: '#recent-activity',
    badge: StatusBadge({ state: 'success', label: 'Shipped', size: 'sm' }),
    text: `${pulse.shipped.count} in the ${esc(WINDOW_PHRASE[pulse.shipped.window])} · median cycle ${esc(pulse.shipped.cycleLabel)}`,
  }));

  return `<div class="opsui-glance-pulse">${rows.join('')}</div>`;
}

function glanceRegion(d: Pick<CommandData, 'glance' | 'glanceAllClear' | 'glancePulse'>, activeWindow: GlanceWindow): string {
  const body = d.glanceAllClear
    ? `<div class="opsui-glance-allclear">` +
      `<span class="opsui-glance-allclear__dot" aria-hidden="true"></span>` +
      `<span class="opsui-glance-allclear__label">All clear — no decisions · nothing to test · none stuck</span>` +
      `</div>${pulseRegion(d.glancePulse)}`
    : `<div class="opsui-glancegrid">${d.glance.map((m) => MetricTile(m)).join('')}</div>`;
  return Card({
    variant: 'glance',
    title: 'Glance',
    subtitle: 'The operating picture at a glance',
    // The window filter lives on the title row (headerAside), never in the body;
    // WindowPicker is the shared component for this.
    headerAside: WindowPicker({ active: activeWindow }),
    body,
  });
}

function eventList(events: CommandEvent[], empty: string): string {
  if (events.length === 0) {
    return `<p class="opsui-empty">${esc(empty)}</p>`;
  }
  return events
    .map((e) =>
      EventRow({
        state: e.state,
        title: e.title,
        metadata: e.metadata,
        ...(e.summary !== undefined ? { summary: e.summary } : {}),
        ...(e.decisionBlock ? { body: renderDecisionBlock(e.decisionBlock) } : {}),
        ...(e.badge ? { badge: e.badge } : {}),
        ...(e.originChip ? { originChip: e.originChip } : {}),
        ...(e.actions ? { actions: e.actions } : {}),
        ...(e.evidence ? { evidence: e.evidence } : {}),
      }),
    )
    .join('');
}

function decisionDeskRegion(events: CommandEvent[]): string {
  return Card({
    title: 'Decision desk',
    subtitle: 'What is blocking the queue',
    headerAside: StatusBadge({
      state: events.length ? 'critical' : 'success',
      label: events.length ? `${events.length} to answer` : 'Clear',
      ...(events.length ? { emphasis: 'blocking' as const } : {}),
    }),
    body: eventList(events, 'Nothing needs you — the queue is unblocked.'),
  });
}

/** WI-128: the actual awaiting-verdict rows (distinct from the Glance "To test" tile, which
 *  is a count + link) — every badge here is `mergedItemBadge` (fold-adapter.ts), the same
 *  deriver the delivery stream uses for the identical merged item. */
function toTestRegion(events: CommandEvent[]): string {
  return Card({
    title: 'To test',
    subtitle: 'Shipped, awaiting your works / found-a-problem verdict',
    headerAside: StatusBadge({
      state: events.length ? 'warning' : 'success',
      label: events.length ? `${events.length} awaiting verdict` : 'All caught up',
      ...(events.length ? { emphasis: 'recommended' as const } : {}),
    }),
    body: eventList(events, 'Nothing shipped is waiting on your verdict.'),
  });
}

/** WI-354: visibility-only card for ops-parks that are neither an operator decision (decision
 *  desk) nor yet flagged Stuck — the blind window that hid WI-348 for 3.5h. No actions
 *  (ops parks are plane-owned — never an operator action target). */
function opsParksRegion(events: OpsParksCard): string {
  // Command-vs-Missions split: this card stays button-less (ops parks are plane-owned —
  // never a founder action target here), but says so explicitly with a link to where they
  // ARE actioned, so an unbuttoned list of parked rows doesn't read as broken.
  const note = events.length
    ? `<p class="opsui-opsparks__note">Auto-retries, escalates on breaker — ` +
      `<a class="opsui-opsparks__note-link" href="/work">manage on Missions →</a></p>`
    : '';
  return Card({
    title: 'Active ops-parks',
    subtitle: 'Mechanical parks too young or not breaker-tripped to show as Stuck',
    headerAside: StatusBadge({
      state: events.length ? 'warning' : 'success',
      label: events.length ? `${events.length} parked` : 'Clear',
    }),
    body: note + eventList(events, 'No ops-parks outside the Stuck tile right now.'),
  });
}

/** WI-128: ONE unified Pipeline card — the former separate "Ops health & pipeline" stage-count
 *  strip and "Pipeline" preparing/queued/building card, merged: the counts strip becomes this
 *  card's header, the three flow stages render underneath, and the Conductor widget folds into
 *  the Building stage (both `conductor.workers` and `flow.building` are the SAME
 *  `buildBuildingEvents` rows — fold-adapter.ts — so folding them costs no information, only a
 *  second header for the identical list). */
function pipelineCardRegion(stages: PipelineStage[], health: CommandData['opsHealth'], flow: PipelineFlow, conductor: CommandData['conductor']): string {
  const countCells = stages
    .map(
      (s) =>
        `<div class="opsui-pipeline__stage" data-state="${s.state}">` +
        `${StatusBadge({ state: s.state, label: s.label })}` +
        `<span class="opsui-pipeline__count">${esc(s.count)}</span></div>`,
    )
    .join('');
  const headerAside =
    `<div class="opsui-pipeline__header">` +
    StatusBadge({ state: health.state, label: health.headline }) +
    `<div class="opsui-pipeline">${countCells}</div>` +
    `</div>`;

  const flowStages: Array<{ label: string; events: CommandEvent[]; empty: string; sub?: { state: OperationalState; label: string } }> = [
    { label: 'Preparing', events: flow.preparing, empty: 'Nothing captured yet.' },
    { label: 'Queued', events: flow.queued, empty: 'Queue is clear.' },
    // Conductor folded in here (WI-128) — its headline becomes this stage's sub-badge.
    { label: 'Building', events: flow.building, empty: 'No workers running.', sub: { state: conductor.state, label: conductor.headline } },
  ];
  const body = flowStages
    .map(
      (s) =>
        `<div class="opsui-pipelineflow__stage">` +
        `<h3 class="opsui-pipelineflow__stage-title">${esc(s.label)}` +
        `<span class="opsui-pipelineflow__stage-count">${s.events.length}</span>` +
        (s.sub ? StatusBadge({ state: s.sub.state, label: s.sub.label, size: 'sm' }) : '') +
        `</h3>` +
        eventList(s.events, s.empty) +
        `</div>`,
    )
    .join('');
  return Card({
    title: 'Pipeline',
    subtitle: 'The build lane, end to end — captured to merged',
    headerAside,
    body: `<div class="opsui-pipelineflow">${body}</div>`,
  });
}

/** WI-177: the delivery stream can be long, so it paginates at DELIVERY_PAGE_SIZE with a
 *  zero-JS prev/next pager. Collapsible day groups are a possible future follow-up, not built here. */
export const DELIVERY_PAGE_SIZE = 20;

/** WI-128: ONE unified recent-activity feed — the former separate "Recent work items" strip
 *  (captured intents) and "Recent deliveries" card (shipped merges), merged into a single
 *  card so a founder scanning "what's been happening" reads one widget, not two. */
function recentActivityRegion(intents: RecentIntent[], events: CommandEvent[], page: number): string {
  const total = events.length;
  const pageCount = Math.max(1, Math.ceil(total / DELIVERY_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
  const start = (safePage - 1) * DELIVERY_PAGE_SIZE;
  const pageItems = events.slice(start, start + DELIVERY_PAGE_SIZE);
  const pager = Pagination({
    page: safePage,
    pageCount,
    total,
    itemNoun: 'shipped',
    label: 'Recent deliveries pages',
    hrefFor: (p) => (p <= 1 ? '/command#recent-activity' : `/command?page=${p}#recent-activity`),
  });
  const shippedHeading = `<p class="opsui-intent-strip__heading">Shipped</p>`;
  return Card({
    title: 'Recent activity',
    subtitle: 'Captured intents and shipped deliveries',
    headerAside: StatusBadge({
      state: total ? 'success' : 'neutral',
      label: total ? `${total} shipped` : 'Nothing shipped yet',
    }),
    body: recentIntentsRegion(intents) + shippedHeading + eventList(pageItems, 'No shipped work in the recent window.') + pager,
  });
}

/** WI-128: Conversations demoted from a full inline list to a link — the standalone
 *  `/threads` route (threads-projection.ts) keeps serving the full page, deep links included;
 *  `threadsPage`, when given, carries the founder's current page over to that link so it
 *  reopens where Command left off, rather than resetting to page 1. */
function conversationsLinkRegion(threads: ThreadCard[], threadsPage?: number): string {
  const total = threads.length;
  const needsYou = threads.filter((t) => t.state === 'needs-you').length;
  const badge = needsYou
    ? StatusBadge({ state: 'critical', label: `${needsYou} needs you`, emphasis: 'blocking' })
    : StatusBadge({
        state: total ? 'neutral' : 'success',
        label: total ? `${total} thread${total === 1 ? '' : 's'}` : 'No threads',
      });
  const href = threadsPage && threadsPage > 1 ? `/threads?page=${threadsPage}` : '/threads';
  return Card({
    title: 'Conversations',
    subtitle: 'Founder conversations with the conductor',
    headerAside: badge,
    body: `<p class="opsui-empty"><a href="${esc(href)}">View all conversations →</a></p>`,
  });
}

/** Compact strip of recent ext:-sourced items — durable answer to "where did my capture go?"
 *  (WI-178). Nested inside {@link recentActivityRegion}'s unified card (WI-128); renders '' when
 *  empty so the unified card never shows a blank "Recent work items" heading with nothing under it. */
function recentIntentsRegion(intents: RecentIntent[]): string {
  if (intents.length === 0) return '';
  const rows = intents
    .map((intent) => {
      const links =
        `<a class="opsui-intent-strip__link" href="${esc(intent.timelineHref)}">timeline</a>` +
        (intent.threadHref
          ? `<a class="opsui-intent-strip__link" href="${esc(intent.threadHref)}">thread</a>`
          : '');
      // Primary badge = WI-NNN (board tracking id); secondary = EXT-NNN (origin ref as metadata).
      const primaryId = intent.id;
      const secondaryId = intent.externalRef;
      return (
        `<li class="opsui-intent-strip__item">` +
        `<span class="opsui-intent-strip__id">${esc(primaryId)}</span>` +
        (secondaryId ? `<span class="opsui-intent-strip__id-wi">· ${esc(secondaryId)}</span>` : '') +
        `<span class="opsui-intent-strip__text">${esc(intent.text)}</span>` +
        StatusBadge({ state: intent.opState, label: intent.statusLabel, size: 'sm' }) +
        `<span class="opsui-intent-strip__links">${links}</span>` +
        `</li>`
      );
    })
    .join('');
  return (
    `<div class="opsui-intent-strip">` +
    `<p class="opsui-intent-strip__heading">Recent work items<span class="opsui-intent-strip__caption"> · EXT = originating intent ref</span></p>` +
    `<ul class="opsui-intent-strip__list" role="list">${rows}</ul>` +
    `</div>`
  );
}

/** Provenance strip — every material value is traceable to the fold. */
function provenanceRegion<T>(env: ProjectionEnvelope<T>): string {
  const chips = env.evidence
    .map(
      (e) =>
        `<a class="opsui-provenance__chip" data-opsui-action="evidence:${esc(e.id)}"` +
        (e.href ? ` href="${esc(e.href)}"` : '') +
        `>${esc(e.label)}</a>`,
    )
    .join('');
  const meta =
    `fold ${esc(env.foldVersion)} · seq #${esc(env.ledgerSequence)} · ` +
    `generated ${esc(env.generatedAt)}`;
  return Card({
    variant: 'inset',
    title: 'Provenance',
    subtitle: 'Every value above traces to the ledger',
    body:
      `<p class="opsui-provenance__meta">${meta}</p>` +
      (chips ? `<div class="opsui-provenance__chips">${chips}</div>` : ''),
  });
}

// ─── Entry point ──────────────────────────────────────────────────────────────

/** Render the command projection workspace from its envelope. A `failed` envelope
 *  renders ProjectionFailure and nothing else — stale fallback is never shown. */
export interface CommandProjectionOptions {
  /** Confirmation chip content after a capture round-trip. */
  capturedId?: string;
  /** 1-based page for the "Shipped" half of the recent-activity feed (WI-177); defaults to 1. */
  deliveryPage?: number;
  /** WI-128: Conversations is now a link, not a paginated inline list — when set (>1), the
   *  link carries the founder's prior page over to `/threads?page=N` instead of resetting it. */
  threadsPage?: number;
  /** Glance time-window picker (WI-359). When unset, the picker's displayed active state AND
   *  the underlying tiles both fall back to DEFAULT_GLANCE_WINDOW — one shared default so the
   *  highlighted chip never contradicts a tile's window tag (see fold-adapter.ts buildGlance). */
  window?: GlanceWindow;
}

/** Post-capture confirmation banner. The inline composer that used to render this was
 *  removed from the command page in favour of the global drop-intent modal (WI-262/WI-263);
 *  the "Captured as <id>" confirmation now stands on its own at the top of the workspace so a
 *  fresh capture — whichever door it came through — is never a dead end (WI-178). */
function capturedBannerRegion(capturedId: string | undefined): string {
  if (!capturedId) return '';
  return (
    `<p class="opsui-composer__captured" role="status">Captured as ` +
    `<a class="opsui-composer__captured-link" href="/timeline?item=${esc(capturedId)}">` +
    `<strong>${esc(capturedId)}</strong></a> — routing…</p>`
  );
}

export function CommandProjection(env: ProjectionEnvelope<CommandData>, opts: CommandProjectionOptions = {}): string {
  if (env.state === 'failed') {
    const foldEvidence = env.evidence[0];
    return ProjectionFailure({
      projection: 'Command',
      reason: `fold ${env.foldVersion} did not fold cleanly`,
      lastGoodSequence: env.ledgerSequence,
      lastGoodAt: env.generatedAt,
      retry: 'reactor re-folds on the next beat (30s)',
      ...(foldEvidence ? { evidence: { id: foldEvidence.id, label: foldEvidence.label, ...(foldEvidence.href ? { href: foldEvidence.href } : {}) } } : {}),
    });
  }

  const d = env.data;
  // Operator-attention order (WI-128): decision desk → to test → the unified pipeline card →
  // glance → the unified recent-activity feed (Conversations demoted to a link within it) →
  // active ops-parks → provenance.
  return (
    `<div class="opsui-command" data-projection="command" data-state="${env.state}">` +
    capturedBannerRegion(opts.capturedId) +
    `<section id="decision-desk">${decisionDeskRegion(d.decisionDesk)}</section>` +
    `<section id="to-test">${toTestRegion(d.toTest)}</section>` +
    `<section id="pipeline">${pipelineCardRegion(d.pipeline, d.opsHealth, d.pipelineFlow, d.conductor)}</section>` +
    glanceRegion(d, opts.window ?? DEFAULT_GLANCE_WINDOW) +
    `<section id="recent-activity">${recentActivityRegion(d.recentIntents ?? [], d.deliveryStream, opts.deliveryPage ?? 1)}</section>` +
    `<section id="conversations">${conversationsLinkRegion(d.threads ?? [], opts.threadsPage)}</section>` +
    `<section id="ops-parks">${opsParksRegion(d.opsParks)}</section>` +
    provenanceRegion(env) +
    `</div>`
  );
}
