// Timeline projection — WI-176. EventRow chronology inside the projectionShell:
// per-item ledger history (WI-NNN drill from the work board) or all-items recent
// activity (no filter). Composed from shared components only.
// A failed envelope renders ProjectionFailure and nothing else.

import { Card } from '../components/Card.ts';
import { EventRow } from '../components/EventRow.ts';
import { ProjectionFailure } from '../components/ProjectionFailure.ts';
import { StatusBadge } from '../components/StatusBadge.ts';
import { esc } from '../render/html.ts';
import type { ProjectionEnvelope } from './projection-types.ts';
import type { TimelineData, TimelineRow } from './timeline-adapter.ts';

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

function captureRegion(itemId: string, capturedText: string): string {
  return Card({
    variant: 'inset',
    title: itemId,
    subtitle: 'Captured intent',
    body: `<p class="opsui-timeline__captured">${esc(capturedText)}</p>`,
  });
}

// Exported (item-hub link sweep, WI-349) so `item-hub-projection.ts` reuses the SAME
// EventRow chronology rendering for the hub's Timeline region — one renderer, never a
// second copy that could drift from this page's row markup.
export function timelineRegion(rows: TimelineRow[], showItemId: boolean): string {
  const count = rows.length;
  const headerAside = StatusBadge({
    state: count ? 'neutral' : 'success',
    label: count ? `${count} event${count !== 1 ? 's' : ''}` : 'no events',
  });

  const emptyMsg = `<p class="opsui-empty">No ledger events found.</p>`;

  const body = count === 0
    ? emptyMsg
    : rows.map((row) => {
        // Item-hub link sweep (WI-349): the all-items view showed each row's WI-NNN as
        // plain text — now a link to its hub page (`EventRow` accepts `{label,href}` chips).
        const metadata: import('../components/EventRow.ts').EventRowMetaItem[] = [];
        if (showItemId && row.itemId) {
          metadata.push({ label: row.itemId, href: `/item/${row.itemId}` });
        } else if (showItemId) {
          metadata.push(row.itemId);
        }
        metadata.push(row.actor, row.tsLabel);

        const summary = row.fields.length
          ? row.fields.map((f) => `${f.key}: ${f.value}`).join(' · ')
          : undefined;

        return EventRow({
          state: row.operationalState,
          title: row.type,
          metadata,
          ...(summary ? { summary } : {}),
          badge: { state: row.operationalState, label: row.type },
        });
      }).join('');

  return Card({
    title: showItemId ? 'Recent activity' : 'Events',
    subtitle: showItemId ? 'Latest ledger events across all work items' : 'Chronological ledger history',
    headerAside,
    body,
  });
}

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
    `fold ${esc(env.foldVersion)} · seq #${esc(String(env.ledgerSequence))} · ` +
    `generated ${esc(env.generatedAt)}`;
  return Card({
    variant: 'inset',
    title: 'Provenance',
    subtitle: 'Every event above traces to the ledger JSONL',
    body:
      `<p class="opsui-provenance__meta">${meta}</p>` +
      (chips ? `<div class="opsui-provenance__chips">${chips}</div>` : ''),
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Render the timeline projection workspace from its envelope.
 *  A `failed` envelope renders ProjectionFailure and nothing else. */
export function TimelineProjection(env: ProjectionEnvelope<TimelineData>): string {
  if (env.state === 'failed') {
    const ev = env.evidence[0];
    return ProjectionFailure({
      projection: 'Timeline',
      reason: 'ledger events could not be read',
      lastGoodSequence: env.ledgerSequence,
      lastGoodAt: env.generatedAt,
      retry: 'check .ai/ledger/ for JSONL files',
      ...(ev ? { evidence: { id: ev.id, label: ev.label, ...(ev.href ? { href: ev.href } : {}) } } : {}),
    });
  }

  const d = env.data;
  const showItemId = !d.itemId;

  return (
    `<div class="opsui-timeline" data-projection="timeline" data-state="${env.state}">` +
    (d.itemId && d.capturedText ? captureRegion(d.itemId, d.capturedText) : '') +
    timelineRegion(d.rows, showItemId) +
    provenanceRegion(env) +
    `</div>`
  );
}
