// Health projection — WI-160. The founder's SLO board: a glance rollup, one Card
// per pane with an inline SloTable, and a provenance strip. Composed from shared
// components only. A failed envelope renders ProjectionFailure
// and nothing else — never a calm empty board.
//
// Nav collapse 9→5 (WI-350): System gains an Analytics top strip (4 MetricTiles —
// quota utilization, spend, first-pass rate, acceptance split — each linking to
// /observability) and an Artifacts region (`id="artifacts"`), reusing
// artifacts-projection.ts's exported `artifactsSystemRegion` (relocation by import).

import { Card } from '../components/Card.ts';
import { MetricTile } from '../components/MetricTile.ts';
import { ProjectionFailure } from '../components/ProjectionFailure.ts';
import { StatusBadge } from '../components/StatusBadge.ts';
import { EventRow } from '../components/EventRow.ts';
import { WindowPicker, type TimeWindow } from '../components/WindowPicker.ts';
import { esc } from '../render/html.ts';
import type { OperationalState } from '../states/operational-state.ts';
import type { ProjectionEnvelope } from './projection-types.ts';
import { trustedSurfaceUrl } from './surface-url.ts';
import type { DeployTargetLiveness, HealActivityEntry, HealthData, HealthPane, HealthSloRow, OpsAutonomyMode, SloStatus, SystemAxis } from './health-adapter.ts';
import { artifactsSystemRegion } from './artifacts-projection.ts';
import type { GlanceMetric } from './command-projection.ts';

// SloStatus → dot CSS class suffix (decides the colour via health.css).
const STATUS_DOT: Record<SloStatus, string> = {
  met:       'met',
  'at-risk': 'at-risk',
  breached:  'breached',
  unknown:   'unknown',
  paused:    'paused',
};

// ─── SloTable (projection-local renderer, not a shared component) ─────────────

function sloRow(row: HealthSloRow): string {
  const dot = `<span class="opsui-health__dot opsui-health__dot--${STATUS_DOT[row.state]}" title="${esc(row.state)}"></span>`;
  const label = row.evidence
    ? `<a class="opsui-health__label" href="${esc(row.evidence)}">${esc(row.label)}</a>`
    : `<span class="opsui-health__label">${esc(row.label)}</span>`;
  const gradNote =
    row.graduation?.eligible
      ? `<span class="opsui-health__grad" title="Stable — ${esc(row.graduation.cleanDays)} clean days">↑</span>`
      : '';
  return (
    `<li class="opsui-health__row opsui-health__row--${row.state}">` +
    dot + label +
    `<span class="opsui-health__value">${esc(row.value)}</span>` +
    `<span class="opsui-health__target">${esc(row.target)}</span>` +
    gradNote +
    `</li>`
  );
}

function sloTable(pane: HealthPane): string {
  if (pane.rows.length === 0) {
    return `<p class="opsui-empty">No SLO rows in this pane.</p>`;
  }
  return `<ul class="opsui-health__table" role="list">${pane.rows.map(sloRow).join('')}</ul>`;
}

// ─── Region renderers ─────────────────────────────────────────────────────────

function glanceRegion(data: HealthData): string {
  const tiles = data.glance.map((m) => MetricTile(m)).join('');
  return Card({
    variant: 'glance',
    title: 'System health',
    subtitle: 'SLO rollup across the plane pipeline and platform',
    body: `<div class="opsui-glancegrid">${tiles}</div>`,
  });
}

/** Analytics top strip (nav collapse 9→5, WI-350) — 4 MetricTiles (quota utilization,
 *  spend, first-pass rate, acceptance split), each a link to /observability
 *  (Analytics keeps its own route for the deep tables). Tiles carry `href` already —
 *  MetricTile renders the link itself, same as every other glance tile. */
function analyticsStripRegion(tiles: GlanceMetric[]): string {
  const rendered = tiles.map((m) => MetricTile(m)).join('');
  return Card({
    variant: 'glance',
    title: 'Analytics',
    subtitle: 'Quota, spend, first-pass rate and acceptance split — full detail on Analytics',
    body: `<div class="opsui-glancegrid">${rendered}</div>`,
  });
}

function panesRegion(panes: HealthPane[]): string {
  if (panes.length === 0) {
    return Card({
      title: 'SLO board',
      body: `<p class="opsui-empty">No SLO panes — board unavailable.</p>`,
    });
  }
  return panes.map((pane) => Card({ title: pane.title, body: sloTable(pane) })).join('');
}

function systemAxesRegion(axes: SystemAxis[]): string {
  const body = axes.map((axis) => EventRow({
    state: axis.state,
    title: axis.label,
    metadata: [axis.detail],
    badge: { state: axis.state, label: axis.value },
  })).join('');
  return Card({
    title: 'Operating state',
    subtitle: 'Service, autonomy and flow are independent signals',
    body,
  });
}

function deployTargetsRegion(targets: DeployTargetLiveness[]): string {
  const body = targets.length
    ? targets.map((target) => {
        const surfaceUrl = trustedSurfaceUrl(target.surfaceUrl);
        return EventRow({
          state: target.state,
          title: target.target,
          metadata: [
            ...(typeof target.configured === 'boolean'
              ? [target.configured ? 'Deploy configured now' : 'No deploy command configured now']
              : []),
            target.detail,
            ...(target.itemId ? [{ label: target.itemId, href: `/item/${target.itemId}` }] : []),
          ],
          badge: { state: target.state, label: target.label },
          ...(surfaceUrl
            ? { evidence: { id: `surface-${target.target}`, label: 'Open surface', href: surfaceUrl } }
            : {}),
        });
      }).join('')
    : `<p class="opsui-empty">No plane or target deployment configuration found.</p>`;
  return Card({
    title: 'Deployments by target',
    subtitle: 'Latest durable receipt for each explicit deployment boundary',
    body,
  });
}

// ─── Self-heal activity feed ───────────────────────────────────────────────────
// Reactor heal.proposed / heal.executed / heal.escalated events (the reactor's self-heal step),
// most-recent-first, with a mode badge for the founder to judge readiness to raise
// OPS_AUTONOMY from propose to heal. Guarded by the caller on `data.healActivity`.

const HEAL_KIND_LABEL: Record<HealActivityEntry['kind'], string> = {
  proposed: 'proposed',
  executed: 'executed',
  escalated: 'escalated',
};

// Reuses the SLO status dot palette: proposed reads as "needs a look" (at-risk),
// executed as resolved (met), escalated as needs operator attention (breached).
const HEAL_KIND_DOT: Record<HealActivityEntry['kind'], SloStatus> = {
  proposed: 'at-risk',
  executed: 'met',
  escalated: 'breached',
};

/**
 * NAME COLLISION, disambiguated in the copy (WI-204). `OPS_AUTONOMY` is the SELF-HEAL mode —
 * how far the plane may go in repairing itself (watch / propose / heal). It is NOT
 * `LOOPKIT_AUTONOMY`, the plane kill switch that decides whether the beats run at all; that one
 * is reported on the observability page's "Autonomy (kill switch)" card and warned about beside
 * the intent box. Two different switches sharing the word "autonomy" on adjacent ops surfaces is
 * the same wrong-map trap the old `conductor` name set, so every label here says "self-heal" out
 * loud, and none of them says "autonomous" — a reader must never take this badge for the
 * kill switch. (The identifiers keep their names; the operator-facing strings carry the fix.)
 */
const OPS_AUTONOMY_LABEL: Record<OpsAutonomyMode, string> = {
  watch: 'self-heal: watch · repairs disabled',
  propose: 'self-heal: propose · dry-run',
  heal: 'self-heal: repair automatically',
};

const OPS_AUTONOMY_STATE: Record<OpsAutonomyMode, OperationalState> = {
  watch: 'neutral',
  propose: 'warning',
  heal: 'success',
};

function healDetail(e: HealActivityEntry): string | undefined {
  if (e.kind === 'proposed') return e.tier ? `tier: ${e.tier}${e.detail ? ` · ${e.detail}` : ''}` : e.detail;
  if (e.kind === 'executed') return e.evidence;
  return e.count !== undefined ? `count: ${e.count}` : undefined;
}

function healRow(e: HealActivityEntry): string {
  const dot = `<span class="opsui-health__dot opsui-health__dot--${STATUS_DOT[HEAL_KIND_DOT[e.kind]]}" title="${esc(HEAL_KIND_LABEL[e.kind])}"></span>`;
  const detail = healDetail(e);
  return (
    `<li class="opsui-health__healrow opsui-health__healrow--${e.kind}">` +
    dot +
    `<span class="opsui-health__healkind">${esc(HEAL_KIND_LABEL[e.kind])}</span>` +
    `<span class="opsui-health__label">${esc(e.key)}</span>` +
    `<span class="opsui-health__value">${esc(e.action)}</span>` +
    (detail ? `<span class="opsui-health__target">${esc(detail)}</span>` : '') +
    `<span class="opsui-health__healts">${esc(e.ts)}</span>` +
    `</li>`
  );
}

function healActivityRegion(
  entries: HealActivityEntry[],
  mode: OpsAutonomyMode | undefined,
  window?: TimeWindow,
  truncated = false,
): string {
  const badge = mode ? StatusBadge({ state: OPS_AUTONOMY_STATE[mode], label: OPS_AUTONOMY_LABEL[mode], size: 'sm' }) : '';
  const picker = window ? WindowPicker({ active: window }) : '';
  // The mode is durable collapsed-state context, so it stays in the header. The time filter
  // changes only the expanded feed and therefore lives immediately above that feed.
  const filters = picker ? `<div class="opsui-health__healfilters">${picker}</div>` : '';
  const truncation = truncated
    ? `<p class="opsui-health__healtruncated">Showing the newest ${entries.length} events; more exist in this window.</p>`
    : '';
  const feed = entries.length
    ? `<ul class="opsui-health__healfeed" role="list">${entries.map(healRow).join('')}</ul>${truncation}`
    : `<p class="opsui-empty">No self-heal activity in this window.</p>`;
  return Card({
    title: 'Self-heal activity',
    subtitle: 'heal.proposed / heal.executed / heal.escalated — most recent first',
    ...(badge ? { headerAside: badge } : {}),
    body: filters + feed,
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

/** Render the health projection from its envelope. A `failed` envelope renders
 *  ProjectionFailure and nothing else. */
export function HealthProjection(env: ProjectionEnvelope<HealthData>): string {
  if (env.state === 'failed') {
    const foldEvidence = env.evidence[0];
    return ProjectionFailure({
      projection: 'Health',
      reason: 'SLO board data unavailable',
      lastGoodSequence: env.ledgerSequence,
      lastGoodAt: env.generatedAt,
      retry: 'board re-probes on the next health cycle',
      ...(foldEvidence
        ? {
            evidence: {
              id: foldEvidence.id,
              label: foldEvidence.label,
              ...(foldEvidence.href ? { href: foldEvidence.href } : {}),
            },
          }
        : {}),
    });
  }

  const d = env.data;
  return (
    `<div class="opsui-health" data-projection="health" data-state="${env.state}">` +
    (d.systemAxes?.length ? systemAxesRegion(d.systemAxes) : '') +
    glanceRegion(d) +
    (d.deployTargets ? deployTargetsRegion(d.deployTargets) : '') +
    (d.analyticsStrip?.length ? analyticsStripRegion(d.analyticsStrip) : '') +
    panesRegion(d.panes) +
    (d.healActivity !== undefined
      ? healActivityRegion(d.healActivity, d.opsAutonomy, d.healWindow, d.healActivityTruncated)
      : '') +
    (d.artifacts ? artifactsSystemRegion(d.artifacts) : '') +
    provenanceRegion(env) +
    `</div>`
  );
}
