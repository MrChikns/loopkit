// Acceptance projection — AcceptanceCard. The operator's
// acceptance desk: every shipped slice awaiting a "works" / "found a problem"
// verdict, oldest first (debt ordering), each carrying the captured
// intent it delivered and links to its evidence. Composed ONLY from shared
// components: glance metrics, an event list, and provenance. On a
// failed envelope it renders `ProjectionFailure` and nothing else — never a
// falsely-calm "all caught up" over a broken fold.

import { Card } from '../components/Card.ts';
import { EventRow } from '../components/EventRow.ts';
import { MetricTile } from '../components/MetricTile.ts';
import { ProjectionFailure } from '../components/ProjectionFailure.ts';
import { StatusBadge } from '../components/StatusBadge.ts';
import { esc } from '../render/html.ts';
import type { GlanceMetric } from './command-projection.ts';
import { mergedItemBadge } from './fold-adapter.ts';
import type { ItemOrigin } from './fold-adapter.ts';
import type { DeployEvidence } from './deploy-evidence.ts';
import type { OperationalState } from '../states/operational-state.ts';
import type { ProjectionEnvelope } from './projection-types.ts';

/** The origin filter on the acceptance desk (WI-180): all shipped slices, only those whose
 *  changes land in the target vs the plane, or 'other' — items with no code origin
 *  (operator questions/feedback that shipped no touches). 'other' gives those a findable home
 *  so nothing is hidden between the sub-filters (they used to appear under 'all' only). */
export type AcceptanceFilter = 'all' | 'target' | 'plane' | 'other';

/** Per-bucket queue sizes, shown on the filter chips so the split is transparent (the 'other'
 *  bucket answers "where are the items that show under All but neither Target nor Plane").
 *  'mixed'-origin items count under both target and plane, so the buckets need not sum to `all`. */
export type AcceptanceCounts = { all: number; target: number; plane: number; other: number };

/** One slice awaiting the operator's verdict — AcceptanceItem, narrowed
 *  to what the loopkit fold carries (no test script / minute estimate yet). */
export type AcceptanceItem = {
  id: string;
  title: string;
  /** The captured intent this slice delivered — shown so the operator tests the right thing. */
  captured?: string;
  metadata: string[];
  /** Acceptance tier ('must'|'review'|'optional'|'auto') — drives the row's verdict badge. */
  tier?: string;
  /** The row's verdict badge, derived once at the fold boundary by fold-adapter.ts's
   *  {@link import('./fold-adapter.ts').mergedItemBadge} — the SAME deriver Command's
   *  delivery stream uses for the same merged item (one-deriver rule, WI-086/WI-087's
   *  cross-projection-identity fix applied to the acceptance-tier axis). */
  badge: { state: OperationalState; label: string; emphasis?: 'recommended' };
  /** WI-180 origin classification, derived once at the fold boundary. */
  origin?: ItemOrigin;
  /** WI-180 origin chip (rendered form of `origin`). */
  originChip?: { state: OperationalState; label: string };
  evidence?: { id: string; label: string; href?: string };
  commit?: string;
  touches?: string[];
  touchesTruncated?: boolean;
  deploy: DeployEvidence;
  /** Whether this row is genuinely timer-eligible under the reactor's deploy prerequisite,
   * or needs operator attention while deploy truth is unresolved/unhealthy. */
  acceptanceMode: 'manual' | 'timer' | 'waiting-deploy' | 'deploy-attention';
  /** Explicitly configured product URL; never inferred from a checkout path. */
  surfaceUrl?: string;
  /** Certify-don't-brief payload (item.merged.certification), when present — see
   *  {@link FoldMergedItem.certification}. Absent renders a visible "no certification
   *  provided" line (acceptanceRow), never a silent blank (leader-leader doctrine). */
  certification?: { couldBreak: string; detection: string; rollback: string };
  /** Acceptance criteria (WI-193) — see {@link FoldMergedItem.criteria}. Absent renders a
   *  visible absence line (criteriaBlock), never a silent blank. */
  criteria?: string[];
  /** Whether the absence of criteria is a recorded exemption rather than a gap. */
  criteriaExempt?: boolean;
};

/** The typed payload the acceptance projection renders. */
export type AcceptanceData = {
  glance: GlanceMetric[];
  queue: AcceptanceItem[];
  /** The active origin filter — drives the toggle's selected state (WI-180). */
  filter?: AcceptanceFilter;
  /** Queue size per origin bucket — rendered as counts on the filter chips. */
  counts?: AcceptanceCounts;
  /** Acceptance-tier effective auto-accept windows (hours) for optional/review — the fold
   *  value each row's `badge` was already derived from (fold-adapter.ts mergedItemBadge),
   *  passed through for provenance/inspection rather than re-derivation. */
  tierWindows?: { optional?: number; review?: number };
};

// ─── Region renderers (each composes shared components only) ──────────────────

function glanceRegion(metrics: GlanceMetric[]): string {
  const tiles = metrics.map((m) => MetricTile(m)).join('');
  return Card({
    variant: 'glance',
    title: 'Acceptance',
    subtitle: 'What is waiting on your verdict',
    body: `<div class="opsui-glancegrid">${tiles}</div>`,
  });
}

/** Zero-JS origin filter toggle (WI-180): query-param links (all / target / plane / other),
 *  the active one marked aria-current, each showing its bucket count so the split is legible
 *  (the 'other' chip is where no-code-origin items live — questions/feedback that shipped no
 *  touches — so nothing is hidden between Target and Plane). Progressive-enhancement
 *  free — it's just navigation. The 'other' chip is omitted when that bucket is empty. */
function filterToggle(active: AcceptanceFilter, counts?: AcceptanceCounts): string {
  const options: Array<{ value: AcceptanceFilter; label: string; count: number | undefined }> = [
    { value: 'all', label: 'All', count: counts?.all },
    { value: 'target', label: 'Target', count: counts?.target },
    { value: 'plane', label: 'Plane', count: counts?.plane },
    { value: 'other', label: 'Other', count: counts?.other },
  ];
  const links = options
    // Hide the 'other' chip entirely when there is nothing unclassified to show.
    .filter((o) => !(o.value === 'other' && (counts ? counts.other === 0 : false)))
    .map((o) => {
      const isActive = o.value === active;
      const href = o.value === 'all' ? '?' : `?filter=${o.value}`;
      const cls = `opsui-acceptance__filter-btn${isActive ? ' opsui-acceptance__filter-btn--active' : ''}`;
      const count =
        typeof o.count === 'number'
          ? `<span class="opsui-acceptance__filter-count">${esc(o.count)}</span>`
          : '';
      return (
        `<a class="${cls}" href="${href}"` +
        (isActive ? ` aria-current="true"` : '') +
        `>${esc(o.label)}${count}</a>`
      );
    })
    .join('');
  return (
    `<div class="opsui-acceptance__filter" role="group" aria-label="Filter by origin">` +
    `<span class="opsui-acceptance__filter-label">Origin</span>${links}</div>`
  );
}

/** Acceptance-tier 'optional'/'auto' tiers auto-accept on a timer (or immediately, for 'auto') without an
 *  operator verdict — they belong in the collapsed "Auto-accepting soon" section, not mixed in
 *  with the 'must'/'review' items that actually need the operator's test. */
export function isAutoAcceptTier(tier: string | undefined): boolean {
  return tier === 'optional' || tier === 'auto';
}

/** The two verdicts, wired to the ledger through the SAME zero-JS POST-form verb path
 *  the command board's Accept uses (fold-adapter buildDeliveryStream): `✅ accept <id>`
 *  matches the host app's ACCEPT_VERB_RE and runs `loopctl accept`. No client
 *  dispatcher needed — progressive enhancement, works without JS. `nextPath` returns the
 *  operator to wherever they verdict'd from (defaults to this acceptance desk). 'auto'-tier
 *  items never had anything to test (no code, or plane-internal only) — no verdict actions.
 *  Exported (item-hub link sweep, WI-349) so `item-hub-adapter.ts` reuses this SAME builder
 *  for a merged/accepted item's action region — one source, never a second copy that could
 *  drift from the host app's ACCEPT_VERB_RE. */
export function buildAcceptanceVerbActions(
  id: string,
  title: string,
  tier: string | undefined,
  accepted: boolean = false,
  nextPath: string = '/acceptance',
  manualOverride: boolean = false,
): NonNullable<import('../components/EventRow.ts').EventRowProps['actions']> {
  // Already-verdict'd items need no further action — the state transition itself is the
  // record; re-showing "Works — accept" after acceptance is the stale-actions bug (WI-387).
  if (accepted) return [];
  if (tier === 'auto' && !manualOverride) return [];
  // nextPath is always a same-origin /command/... path (never user text), so it is used
  // literally — matching the original literal `next=/acceptance` byte for byte
  // when the default applies (pinned by acceptance-projection.test.ts).
  const action = `/intent?next=${nextPath}`;
  return [
    {
      id: `acceptance.accept:${id}`,
      label: 'Works — accept',
      emphasis: 'primary' as const,
      form: { action, intent: `✅ accept ${id}` },
    },
    {
      id: `acceptance.fail:${id}`,
      label: 'Found a problem',
      emphasis: 'danger' as const,
      // No dedicated fail verb exists — a problem is free-text feedback. Open the
      // composer pre-filled so the operator describes what's wrong; on submit it is
      // captured as a new item the reactor routes as a repair (feedback loop).
      composer: { prefill: `Problem with ${id} (${title}): ` },
    },
  ];
}

/**
 * Certify-don't-brief block (leader-leader doctrine: "a certification of understanding, not
 * an assertion of completion" — green tests alone are a brief). Renders the three labeled
 * fields when the merge carries a certification payload; when absent, renders ONE visible
 * "no certification provided" line rather than silently omitting the section — the operator
 * should never mistake missing certification for a clean one.
 */
function certificationBlock(cert: AcceptanceItem['certification']): string {
  if (!cert) {
    return `<p class="opsui-acceptance__nocert">No certification provided.</p>`;
  }
  const field = (label: string, value: string): string =>
    `<div class="opsui-acceptance__certfield">` +
    `<dt class="opsui-acceptance__certlabel">${esc(label)}</dt>` +
    `<dd class="opsui-acceptance__certvalue">${esc(value)}</dd>` +
    `</div>`;
  return `<dl class="opsui-acceptance__cert">` +
    field('Could break', cert.couldBreak) +
    field('Detection', cert.detection) +
    field('Rollback', cert.rollback) +
    `</dl>`;
}

/**
 * Acceptance-criteria block (WI-193 win 3) — the bar beside the delivery.
 *
 * This is the win that pays immediately: the operator is the throughput bottleneck, and
 * seeing what was promised next to what shipped makes the judgement faster with zero new
 * automation. Same doctrine as {@link certificationBlock}: an absent bar renders ONE visible
 * line naming WHY it is absent, because a blank where a promise should be reads like a promise
 * that was kept.
 */
function criteriaBlock(i: AcceptanceItem): string {
  if (!i.criteria || i.criteria.length === 0) {
    const why = i.criteriaExempt
      ? 'No acceptance criteria — this item predates the requirement.'
      : 'No acceptance criteria recorded.';
    return `<p class="opsui-acceptance__nocriteria">${esc(why)}</p>`;
  }
  return `<div class="opsui-acceptance__criteria">` +
    `<p class="opsui-acceptance__criterialabel">Promised before the work started:</p>` +
    `<ul class="opsui-acceptance__criterialist">` +
    i.criteria.map((c) => `<li class="opsui-acceptance__criterion">${esc(c)}</li>`).join('') +
    `</ul></div>`;
}

function deliveryEvidenceBlock(i: AcceptanceItem): string {
  const facts = [
    i.commit ? `Commit ${i.commit.slice(0, 7)}` : 'Commit unavailable',
    `Origin ${i.origin ?? 'other'}`,
    i.touches?.length
      ? `Touches ${i.touches.slice(0, 3).join(', ')}${i.touches.length > 3 || i.touchesTruncated ? '…' : ''}`
      : 'Touches not recorded',
    `Deploy ${i.deploy.label.toLowerCase()}`,
  ];
  const surface = i.surfaceUrl
    ? `<a class="opsui-provenance__chip" href="${esc(i.surfaceUrl)}" rel="noopener noreferrer">Open changed surface</a>`
    : '';
  return (
    `<div class="opsui-acceptance__delivery-evidence">` +
    `<p class="opsui-provenance__meta">${facts.map(esc).join(' · ')}</p>` +
    (i.deploy.reason ? `<p class="opsui-acceptance__nocert">${esc(i.deploy.reason)}</p>` : '') +
    surface +
    `</div>`
  );
}

function acceptanceRow(i: AcceptanceItem): string {
  const actions = buildAcceptanceVerbActions(
    i.id,
    i.title,
    i.tier,
    false,
    '/acceptance',
    i.acceptanceMode === 'deploy-attention' || i.acceptanceMode === 'waiting-deploy',
  );
  return EventRow({
    state: i.badge.state,
    title: i.title,
    metadata: i.metadata,
    ...(i.captured ? { summary: i.captured } : {}),
    // The bar first, then the certification: the operator reads "what was promised" before
    // "what could break", which is the order the judgement actually happens in.
    body: deliveryEvidenceBlock(i) + criteriaBlock(i) + certificationBlock(i.certification),
    badge: i.badge,
    ...(i.originChip ? { originChip: i.originChip } : {}),
    ...(actions.length ? { actions } : {}),
    ...(i.evidence ? { evidence: i.evidence } : {}),
  });
}

/** Every item that is not truly timer-eligible stays visible: must/review work plus
 * optional/auto work waiting on or blocked by deployment truth. */
function waitingRegion(items: AcceptanceItem[]): string {
  const waiting = items.filter((i) => i.acceptanceMode !== 'timer');
  const body =
    waiting.length === 0
      ? `<p class="opsui-empty">Nothing waiting on your test.</p>`
      : waiting.map((i) => acceptanceRow(i)).join('');
  return Card({
    title: 'Waiting on your test',
    subtitle: 'Oldest first — test it, then record your verdict',
    headerAside: StatusBadge({
      state: waiting.length ? 'warning' : 'success',
      label: waiting.length ? `${waiting.length} to test` : 'Clear',
      ...(waiting.length ? { emphasis: 'recommended' as const } : {}),
    }),
    body,
  });
}

/** Only deploy-safe optional/auto items belong in the collapsed timer section. */
function autoAcceptingRegion(items: AcceptanceItem[]): string {
  const autoItems = items.filter((i) => i.acceptanceMode === 'timer');
  if (autoItems.length === 0) return '';
  const rows = autoItems.map((i) => acceptanceRow(i)).join('');
  return (
    `<details class="opsui-card opsui-acceptance__auto">` +
    `<summary class="opsui-card__header opsui-acceptance__auto-summary">` +
    `<div class="opsui-card__titles">` +
    `<h2 class="opsui-card__title">Auto-accepting soon</h2>` +
    `<p class="opsui-card__subtitle">No action needed — click to expand</p>` +
    `</div>` +
    `<div class="opsui-card__aside">${StatusBadge({ state: 'neutral', label: `${autoItems.length}` })}</div>` +
    `</summary>` +
    `<div class="opsui-card__body">${rows}</div>` +
    `</details>`
  );
}

/** Provenance strip — every value above traces to the fold. */
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

/** Render the acceptance projection workspace from its envelope. A `failed`
 *  envelope renders ProjectionFailure and nothing else — stale fallback is never
 *  shown (a calm empty queue over a broken fold would read as "all caught up"). */
export function AcceptanceProjection(env: ProjectionEnvelope<AcceptanceData>): string {
  if (env.state === 'failed') {
    const foldEvidence = env.evidence[0];
    return ProjectionFailure({
      projection: 'Acceptance',
      reason: `fold ${env.foldVersion} did not fold cleanly`,
      lastGoodSequence: env.ledgerSequence,
      lastGoodAt: env.generatedAt,
      retry: 'reactor re-folds on the next beat (30s)',
      ...(foldEvidence ? { evidence: { id: foldEvidence.id, label: foldEvidence.label, ...(foldEvidence.href ? { href: foldEvidence.href } : {}) } } : {}),
    });
  }

  const d = env.data;
  return (
    `<div class="opsui-acceptance" data-projection="acceptance" data-state="${env.state}">` +
    glanceRegion(d.glance) +
    filterToggle(d.filter ?? 'all', d.counts) +
    waitingRegion(d.queue) +
    autoAcceptingRegion(d.queue) +
    provenanceRegion(env) +
    `</div>`
  );
}
