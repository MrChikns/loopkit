// Planner projection. The founder's planning picture: open
// gate-map waves and the groomable backlog (read-only v1; grooming actions come
// with the dispatcher). Composed ONLY from shared components. A failed envelope
// renders ProjectionFailure and nothing else.

import { Card } from '../components/Card.ts';
import { EventRow } from '../components/EventRow.ts';
import { MetricTile } from '../components/MetricTile.ts';
import { ProjectionFailure } from '../components/ProjectionFailure.ts';
import { StatusBadge } from '../components/StatusBadge.ts';
import { esc } from '../render/html.ts';
import type { ProjectionEnvelope } from './projection-types.ts';
import { gateStatusToOp, backlogStateToOp } from './planner-adapter.ts';
import type { PlannerData, GateRow, BacklogRow } from './planner-adapter.ts';

// ─── Region renderers ────────────────────────────────────────────────────────

function glanceRegion(metrics: PlannerData['glance']): string {
  const tiles = metrics.map((m) => MetricTile(m)).join('');
  return Card({
    variant: 'glance',
    title: 'Planner',
    subtitle: 'Gate-map waves and groomable backlog',
    body: `<div class="opsui-glancegrid">${tiles}</div>`,
  });
}

function gateLabel(row: GateRow): string {
  return row.opens
    ? `${esc(row.id)} — ${esc(row.title)} (opens: ${esc(row.opens)})`
    : `${esc(row.id)} — ${esc(row.title)}`;
}

function gatesRegion(gates: GateRow[]): string {
  const openCount = gates.filter((g) => g.status === 'open' || g.status === 'active').length;
  const headerAside = StatusBadge({
    state:  openCount ? 'success' : 'neutral',
    label:  openCount ? `${openCount} open` : 'None open',
  });
  const body = gates.length === 0
    ? `<p class="opsui-empty">No gates in the map.</p>`
    : gates.map((gate) => {
        const op = gateStatusToOp(gate.status);
        return EventRow({
          state:    op,
          title:    gateLabel(gate),
          metadata: [gate.stage, gate.status],
          badge:    { state: op, label: gate.status },
        });
      }).join('');
  return (
    `<div class="opsui-planner__gates">` +
    Card({
      title:       'Gate map',
      subtitle:    'Wave gates — open unlocks groomable work',
      headerAside,
      body,
    }) +
    `</div>`
  );
}

function backlogStateLabel(state: string): string {
  if (state === 'queued' || state === 'routed') return state;
  return state;
}

function backlogRegion(backlog: BacklogRow[]): string {
  const groomable = backlog.filter((r) => r.state === 'queued' || r.state === 'routed').length;
  const headerAside = StatusBadge({
    state: groomable ? 'neutral' : 'success',
    label: groomable ? `${groomable} groomable` : 'Clear',
  });
  const body = backlog.length === 0
    ? `<p class="opsui-empty">Backlog is empty.</p>`
    : backlog.map((row) => {
        const op = backlogStateToOp(row.state);
        return EventRow({
          state:    op,
          title:    `${esc(row.id)} — ${esc(row.title)}`,
          metadata: [row.priority, backlogStateLabel(row.state)],
          badge:    { state: op, label: backlogStateLabel(row.state) },
        });
      }).join('');
  return (
    `<div class="opsui-planner__backlog">` +
    Card({
      title:       'Backlog',
      subtitle:    'Groomable items within open gates',
      headerAside,
      body,
    }) +
    `</div>`
  );
}

function provenanceRegion(env: ProjectionEnvelope<PlannerData>): string {
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

/** Render the planner projection workspace from its envelope. A `failed` envelope
 *  renders ProjectionFailure and nothing else. */
export function PlannerProjection(env: ProjectionEnvelope<PlannerData>): string {
  if (env.state === 'failed') {
    const foldEvidence = env.evidence[0];
    return ProjectionFailure({
      projection:       'Planner',
      reason:           `fold ${env.foldVersion} did not fold cleanly`,
      lastGoodSequence: env.ledgerSequence,
      lastGoodAt:       env.generatedAt,
      retry:            'reactor re-folds on the next beat (30s)',
      ...(foldEvidence
        ? { evidence: { id: foldEvidence.id, label: foldEvidence.label, ...(foldEvidence.href ? { href: foldEvidence.href } : {}) } }
        : {}),
    });
  }

  const d = env.data;
  return (
    `<div class="opsui-planner" data-projection="planner" data-state="${env.state}">` +
    glanceRegion(d.glance) +
    gatesRegion(d.gates) +
    backlogRegion(d.backlog) +
    provenanceRegion(env) +
    `</div>`
  );
}
