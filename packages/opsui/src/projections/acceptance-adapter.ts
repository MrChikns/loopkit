// Acceptance fold adapter — the typed boundary between the loopkit fold substrate
// and the acceptance projection. It reads the SAME `loopctl summary --json` shape
// the command adapter reads (validated through the one `isFoldSummary` parser) and
// projects `recentMerged` — slices that shipped in the last 7 days and now await a
// founder verdict — into a typed `ProjectionEnvelope<AcceptanceData>`. Malformed
// input folds to a LOUD failure envelope, never a calm empty
// queue that reads as "all caught up".
//
// The acceptance debt ordering is: blocking → oldest → fastest → queue
// order. The fold does not (yet) carry a blocking flag or a minute estimate, so
// this adapter orders by OLDEST first — the one signal the substrate provides —
// and leaves the richer ordering to a later fold enrichment.

import type { GlanceMetric } from './command-projection.ts';
import { isAutoAcceptTier } from './acceptance-projection.ts';
import type { AcceptanceData, AcceptanceItem, AcceptanceFilter, AcceptanceCounts } from './acceptance-projection.ts';
import { deriveOrigin, isFoldSummary, mergedItemBadge, originBadge, type FoldMergedItem, type FoldSummary, type ItemOrigin } from './fold-adapter.ts';
import type { OperationalState } from '../states/operational-state.ts';
import type { ProjectionEnvelope } from './projection-types.ts';

const SCHEMA_VERSION = '1';
/** Acceptance-debt age past which the oldest tile turns from progress to warning. */
const STALE_ACCEPTANCE_HOURS = 48;

function mergedAtMs(item: FoldMergedItem): number {
  const t = item.mergedAt ? new Date(item.mergedAt).getTime() : NaN;
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY; // unknown age sinks to the end
}

function specLabel(item: FoldMergedItem): string {
  const spec = (item.spec ?? '').trim();
  return spec ? `${item.id} · ${spec}` : item.id;
}

/** Human age of an acceptance item relative to the fold's generation time. */
function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return '< 1h';
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function toItem(item: FoldMergedItem, nowMs: number, windows: { optional?: number; review?: number } | undefined): AcceptanceItem {
  const mergedMs = mergedAtMs(item);
  const ageMs = Number.isFinite(mergedMs) ? nowMs - mergedMs : NaN;
  const metadata = [`shipped ${formatAge(ageMs)}`];
  if (item.mergeCommit) metadata.push(item.mergeCommit.slice(0, 7));
  const origin = deriveOrigin(item.touches);
  return {
    id: item.id,
    title: specLabel(item),
    ...(item.spec && item.spec.trim() ? { captured: item.spec.trim() } : {}),
    metadata,
    ...(item.tier ? { tier: item.tier } : {}),
    // ONE badge deriver (fold-adapter.ts mergedItemBadge): computed here at the fold
    // boundary, not re-derived by the render layer, so the acceptance desk can never say
    // something different than Command's delivery stream for the same merged item.
    badge: mergedItemBadge(item, windows),
    ...(origin ? { origin, originChip: originBadge(origin) } : {}),
    // Every accepted slice traces to its deploy; the acceptance script itself is a
    // projection-level evidence chip (below), not per-item. The chip must carry an
    // href — without one EventRow falls back to a `data-opsui-action` button, and no
    // client dispatcher exists for those (WI-348). The item hub renders the actual
    // deploy receipt, so the chip deep-links there.
    ...(item.mergeCommit
      ? { evidence: { id: `deploy-${item.mergeCommit}`, label: 'Deploy receipt', href: `/item/${item.id}` } }
      : {}),
    // Certify-don't-brief payload — absent renders a visible "no certification provided"
    // line (acceptance-projection.ts certificationBlock), never a silent blank.
    ...(item.certification ? { certification: item.certification } : {}),
  };
}

/** Does an item's origin pass the founder's all/target/plane/other filter (WI-180)? An item
 *  with no derivable origin (no code touches — a question/feedback item) shows under 'all'
 *  and 'other'. 'plane' also matches 'mixed' work (it touches the plane); 'target' also
 *  matches 'mixed' (it touches the target). Every item lands in at least one sub-filter, so the
 *  queue is never hidden between them. */
function passesFilter(origin: ItemOrigin | undefined, filter: AcceptanceFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'other') return origin === undefined;
  if (origin === undefined) return false;
  if (filter === 'plane') return origin === 'plane' || origin === 'mixed';
  return origin === 'target' || origin === 'mixed';
}

// Acceptance-tier tiering (WI-341): the chip must match what the founder actually needs to act on —
// only must/review items are "to test"; optional/auto auto-accept on a timer and are a
// side mention, not part of the headline count (they already have their own collapsed
// "Auto-accepting soon" section below).
function buildGlance(items: AcceptanceItem[], oldestAgeMs: number): GlanceMetric[] {
  const waiting = items.filter((i) => !isAutoAcceptTier(i.tier));
  const autoCount = items.length - waiting.length;
  const oldestHours = Number.isFinite(oldestAgeMs) ? oldestAgeMs / 3_600_000 : 0;
  const oldestState: OperationalState = waiting.length === 0
    ? 'success'
    : oldestHours >= STALE_ACCEPTANCE_HOURS
      ? 'warning'
      : 'progress';
  return [
    {
      label: 'Awaiting your test',
      value: autoCount > 0 ? `${waiting.length} to test · ${autoCount} auto-accepting` : waiting.length,
      footnote: waiting.length ? 'shipped, not yet verified' : 'all caught up',
      state: waiting.length ? 'warning' : 'success',
      open: { kind: 'evidence', id: 'acceptance-queue' },
    },
    {
      label: 'Oldest',
      value: waiting.length ? formatAge(oldestAgeMs) : '—',
      footnote: waiting.length ? 'since it shipped' : 'no debt',
      state: oldestState,
      open: { kind: 'evidence', id: 'acceptance-queue' },
    },
  ];
}

/** Build the acceptance projection envelope from a raw fold summary. Unknown or
 *  malformed input yields a `failed` envelope (loud fold failure). */
export function acceptanceProjectionFromFold(
  raw: unknown,
  opts: {
    ledgerSequence: number;
    foldVersion?: string;
    staleAfterSeconds?: number;
    filter?: AcceptanceFilter;
  } = { ledgerSequence: 0 },
): ProjectionEnvelope<AcceptanceData> {
  const foldVersion = opts.foldVersion ?? 'loopkit';
  const staleAfter = opts.staleAfterSeconds ?? 45;
  const filter: AcceptanceFilter = opts.filter ?? 'all';

  if (!isFoldSummary(raw)) {
    return {
      projectionId: 'acceptance',
      schemaVersion: SCHEMA_VERSION,
      foldVersion,
      ledgerSequence: opts.ledgerSequence,
      generatedAt: new Date().toISOString(),
      freshUntil: new Date().toISOString(),
      state: 'failed',
      data: { glance: [], queue: [] },
      evidence: [{ id: 'fold-summary', kind: 'fold-definition', label: 'loopctl summary --json' }],
    };
  }

  const fold: FoldSummary = raw;
  const generatedAt = fold.generatedAt;
  const nowMs = new Date(generatedAt).getTime();
  const freshUntil = new Date(nowMs + staleAfter * 1000).toISOString();

  // Oldest first: the longest-waiting acceptance debt sits at the top.
  const ordered = fold.recentMerged
    .filter((m) => !m.accepted)
    .sort((a, b) => mergedAtMs(a) - mergedAtMs(b));
  // WI-180: the origin toggle filters the queue by where each slice's changes land. The
  // glance + oldest tile reflect the FILTERED set so the counts match what's on screen.
  // Origin is derived once per item and reused for both the count tally and the filter.
  const origins = ordered.map((m) => deriveOrigin(m.touches));
  const counts: AcceptanceCounts = {
    all: ordered.length,
    target: origins.filter((o) => passesFilter(o, 'target')).length,
    plane: origins.filter((o) => passesFilter(o, 'plane')).length,
    other: origins.filter((o) => passesFilter(o, 'other')).length,
  };
  const orderedFiltered = ordered.filter((_m, i) => passesFilter(origins[i], filter));
  const queue = orderedFiltered.map((m) => toItem(m, nowMs, fold.tierWindows));
  // The glance's "Oldest" tile mirrors the "Waiting on your test" section (acceptance-tier
  // tiering, WI-341): an old optional/auto item that's about to auto-accept isn't founder debt, so
  // it must not be reported as the oldest thing waiting on the founder.
  const waitingFiltered = orderedFiltered.filter((m) => !isAutoAcceptTier(m.tier));
  const oldestAgeMs = waitingFiltered.length ? nowMs - mergedAtMs(waitingFiltered[0]!) : NaN;

  return {
    projectionId: 'acceptance',
    schemaVersion: SCHEMA_VERSION,
    foldVersion,
    ledgerSequence: opts.ledgerSequence,
    generatedAt,
    freshUntil,
    state: 'fresh',
    data: {
      glance: buildGlance(queue, oldestAgeMs), queue, filter, counts,
      ...(fold.tierWindows ? { tierWindows: fold.tierWindows } : {}),
    },
    evidence: [
      { id: 'fold-summary', kind: 'fold-definition', label: 'loopctl summary --json' },
      { id: 'acceptance-script', kind: 'artifact', label: 'Acceptance script' },
    ],
  };
}
