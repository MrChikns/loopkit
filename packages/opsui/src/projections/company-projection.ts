// Knowledge projection. The operator's knowledge picture: active decisions from the
// configured decision log, with used-by provenance. Composed ONLY from shared
// components. A failed envelope renders ProjectionFailure and
// nothing else.

import { Card } from '../components/Card.ts';
import { EventRow } from '../components/EventRow.ts';
import { MetricTile } from '../components/MetricTile.ts';
import { ProjectionFailure } from '../components/ProjectionFailure.ts';
import { StatusBadge } from '../components/StatusBadge.ts';
import { esc } from '../render/html.ts';
import type { ProjectionEnvelope } from './projection-types.ts';
import type { CompanyData, DecisionCard } from './company-adapter.ts';
import { decisionStatusToOp } from './company-adapter.ts';

// ─── Region renderers ─────────────────────────────────────────────────────────

function glanceRegion(data: CompanyData): string {
  const tiles = data.glance.map((m) => MetricTile(m)).join('');
  return Card({
    variant: 'glance',
    title: 'Knowledge',
    subtitle: 'Active decisions from the configured decision log',
    body: `<div class="opsui-glancegrid">${tiles}</div>`,
  });
}

// Each decision row carries provenance — id, title, date, status, and a used-by count
// when non-zero. `usedByCount` is omitted (never a fabricated "0 uses") when nothing in
// the already-loaded ledger corpus cites it.
function decisionsRegion(decisions: DecisionCard[]): string {
  const activeCount = decisions.filter((d) => d.status === 'Active').length;
  const headerAside = StatusBadge({
    state: activeCount ? 'success' : 'neutral',
    label: activeCount ? `${activeCount} active` : 'None active',
  });
  const body = decisions.length === 0
    ? `<p class="opsui-empty">No decisions loaded.</p>`
    : decisions.map((d) => {
        const op = decisionStatusToOp(d.status);
        const metadata = [d.date, d.status];
        if (d.usedByCount) metadata.push(`used by ${d.usedByCount} item${d.usedByCount === 1 ? '' : 's'}`);
        // A lowercase `id=` anchor per card so decision-id mentions elsewhere in the
        // console (`linkifyDecisionRefs`) resolve to /company#d-nnn.
        const anchorId = `d-${d.id.replace(/^D-/i, '')}`;
        return (
          `<div id="${esc(anchorId)}">` +
          EventRow({
            state:    op,
            title:    `${esc(d.id)} — ${esc(d.title)}`,
            metadata,
            badge:    { state: op, label: d.status },
          }) +
          `</div>`
        );
      }).join('');
  return (
    `<div class="opsui-company__decisions">` +
    Card({
      title:       'Decisions',
      subtitle:    'Active and recently superseded decision entries, with provenance',
      headerAside,
      body,
    }) +
    `</div>`
  );
}

function provenanceRegion(env: ProjectionEnvelope<CompanyData>): string {
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
    title:    'Provenance',
    subtitle: 'Every value above traces to the ledger',
    body:
      `<p class="opsui-provenance__meta">${meta}</p>` +
      (chips ? `<div class="opsui-provenance__chips">${chips}</div>` : ''),
  });
}

// ─── Entry point ──────────────────────────────────────────────────────────────

/** Render the knowledge projection from its envelope. A `failed` envelope renders
 *  ProjectionFailure and nothing else. */
export function CompanyProjection(env: ProjectionEnvelope<CompanyData>): string {
  if (env.state === 'failed') {
    const foldEvidence = env.evidence[0];
    return ProjectionFailure({
      projection:       'Knowledge',
      reason:           `fold ${env.foldVersion} did not fold cleanly`,
      lastGoodSequence: env.ledgerSequence,
      lastGoodAt:       env.generatedAt,
      retry:            'the binding layer re-reads the configured decision log on the next beat',
      ...(foldEvidence
        ? { evidence: { id: foldEvidence.id, label: foldEvidence.label, ...(foldEvidence.href ? { href: foldEvidence.href } : {}) } }
        : {}),
    });
  }

  const d = env.data;
  return (
    `<div class="opsui-company" data-projection="company" data-state="${env.state}">` +
    glanceRegion(d) +
    decisionsRegion(d.decisions) +
    provenanceRegion(env) +
    `</div>`
  );
}
