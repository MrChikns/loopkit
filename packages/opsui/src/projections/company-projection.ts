// Knowledge projection. The operator's knowledge picture: active decisions from the
// configured decision log, with used-by provenance. Composed ONLY from shared
// components. A failed envelope renders ProjectionFailure and
// nothing else.

import { Card } from '../components/Card.ts';
import { Button } from '../components/Button.ts';
import { EventRow } from '../components/EventRow.ts';
import { MetricTile } from '../components/MetricTile.ts';
import { ProjectionFailure } from '../components/ProjectionFailure.ts';
import { Pagination } from '../components/Pagination.ts';
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
    title: 'Decisions & docs',
    subtitle: 'Current operating decisions and their supporting sources',
    body: `<div class="opsui-glancegrid">${tiles}</div>`,
  });
}

// Each decision row carries provenance — id, title, date, status, and a used-by count
// when non-zero. `usedByCount` is omitted (never a fabricated "0 uses") when nothing in
// the already-loaded ledger corpus cites it.
function filterLinks(label: string, links: CompanyData['statusLinks']): string {
  return (
    `<div class="opsui-acceptance__filter" role="group" aria-label="${esc(label)}">` +
    `<span class="opsui-acceptance__filter-label">${esc(label)}</span>` +
    links.map((link) => {
      const cls = `opsui-acceptance__filter-btn${link.active ? ' opsui-acceptance__filter-btn--active' : ''}`;
      return `<a class="${cls}" href="${esc(link.href)}"${link.active ? ' aria-current="true"' : ''}>${esc(link.label)}</a>`;
    }).join('') +
    `</div>`
  );
}

function decisionsRegion(data: CompanyData): string {
  const decisions = data.decisions;
  const activeCount = decisions.filter((d) => d.status.toLowerCase().startsWith('active')).length;
  const headerAside = StatusBadge({
    state: activeCount ? 'success' : 'neutral',
    label: activeCount ? `${activeCount} active` : 'None active',
  });
  const body = decisions.length === 0
    ? `<p class="opsui-empty">No decisions match these filters.</p>`
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
  const search =
    `<form class="opsui-company__search" method="get" action="/company">` +
    `<label for="company-query">Search decisions and docs</label>` +
    `<input id="company-query" name="q" type="search" value="${esc(data.query)}" placeholder="ID, title, status, target, or document text">` +
    (data.statusFilter !== 'active' ? `<input type="hidden" name="status" value="${esc(data.statusFilter)}">` : '') +
    (data.targetFilter ? `<input type="hidden" name="target" value="${esc(data.targetFilter)}">` : '') +
    Button({ label: 'Search', type: 'submit', variant: 'primary', size: 'sm' }) +
    (data.query ? Button({ label: 'Clear', href: data.clearQueryHref, variant: 'ghost', size: 'sm' }) : '') +
    `</form>`;
  const pager = Pagination({
    page: data.page,
    pageCount: data.pageCount,
    total: data.decisionTotal,
    itemNoun: 'decisions',
    hrefFor: (page) => page < data.page ? (data.prevHref ?? '/company') : (data.nextHref ?? '/company'),
    label: 'Decision pages',
  });
  return (
    `<div class="opsui-company__decisions">` +
    search +
    filterLinks('Status', data.statusLinks) +
    filterLinks('Target', data.targetLinks) +
    Card({
      title:       'Decisions',
      subtitle:    'Newest first; superseded decisions stay hidden until requested',
      headerAside,
      body: body + pager,
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
      projection:       'Decisions & docs',
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
    decisionsRegion(d) +
    provenanceRegion(env) +
    `</div>`
  );
}
