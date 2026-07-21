// Observability projection — WI-161. The founder's token-cost and transcript-size
// picture: glance metrics, per-loop/provider cost table, server-side SVG sparkline
// (7-day trend), and transcript sizes. Composed from shared components; the
// ChartFrame and cost table are projection-local helpers (not shared
// components). A failed envelope renders ProjectionFailure and nothing else.

import { Card } from '../components/Card.ts';
import { MetricTile } from '../components/MetricTile.ts';
import { ProjectionFailure } from '../components/ProjectionFailure.ts';
import { StatusBadge } from '../components/StatusBadge.ts';
import { esc } from '../render/html.ts';
import type { ProjectionEnvelope } from './projection-types.ts';
import { formatTokens } from './observability-adapter.ts';
import type { ObservabilityData, TokenCostRow, TrendPoint, TranscriptSize } from './observability-adapter.ts';

// ─── Local helpers ────────────────────────────────────────────────────────────

/** Error boundary for region renderers — a thrown region must not crash the page. */
function safeRegion(name: string, fn: () => string): string {
  try {
    return fn();
  } catch {
    return Card({
      title: name,
      body:  `<p class="opsui-plane-obs__unavailable">${esc(name)} region unavailable.</p>`,
    });
  }
}

function formatBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1_024)     return `${Math.round(n / 1_024)} KB`;
  return `${n} B`;
}

// ─── Region renderers ─────────────────────────────────────────────────────────

function glanceRegion(metrics: ObservabilityData['glance']): string {
  return Card({
    variant:  'glance',
    title:    'Observability',
    subtitle: 'Token spend · cost · 7-day trend',
    body:     `<div class="opsui-glancegrid">${metrics.map((m) => MetricTile(m)).join('')}</div>`,
  });
}

function tokenRowsRegion(rows: TokenCostRow[], totalTokens: number, totalUsd: number): string {
  const headerAside = StatusBadge({
    state: rows.length ? 'neutral' : 'success',
    label: `${rows.length} row${rows.length !== 1 ? 's' : ''}`,
  });

  const body =
    rows.length === 0
      ? `<p class="opsui-empty">No token usage rows.</p>`
      : `<table class="opsui-obs__table">` +
        `<thead><tr>` +
        `<th>Loop</th><th>Provider</th>` +
        `<th class="opsui-obs__num">Tokens</th><th class="opsui-obs__num">Cost</th>` +
        `</tr></thead>` +
        `<tbody>` +
        rows
          .map(
            (r) =>
              `<tr>` +
              `<td>${esc(r.loop)}</td>` +
              `<td>${esc(r.provider)}</td>` +
              `<td class="opsui-obs__num">${esc(formatTokens(r.tokens))}</td>` +
              `<td class="opsui-obs__num">$${r.usd.toFixed(3)}</td>` +
              `</tr>`,
          )
          .join('') +
        `</tbody>` +
        (rows.length > 1
          ? `<tfoot><tr>` +
            `<td colspan="2" class="opsui-obs__total">Total</td>` +
            `<td class="opsui-obs__num opsui-obs__total">${esc(formatTokens(totalTokens))}</td>` +
            `<td class="opsui-obs__num opsui-obs__total">$${totalUsd.toFixed(3)}</td>` +
            `</tr></tfoot>`
          : '') +
        `</table>`;

  return Card({
    title:       'Token usage by loop · provider',
    subtitle:    'Per-loop cost breakdown for this window',
    headerAside,
    body,
  });
}

/** ChartFrame — projection-local renderer. Produces a Card wrapping a server-side
 *  SVG sparkline for the 7-day USD spend trend. Date labels sit below the SVG as
 *  HTML (preserveAspectRatio="none" would distort inline SVG text). */
function ChartFrame(points: TrendPoint[]): string {
  const title    = '7-day cost trend';
  const subtitle = 'Daily token spend in USD';

  if (points.length < 2) {
    return Card({
      title,
      subtitle,
      body: `<p class="opsui-empty">Not enough trend data (need ≥ 2 days).</p>`,
    });
  }

  const W = 200, H = 48, PAD = 3;
  const maxUsd = Math.max(...points.map((p) => p.usd), 0.001);
  const n      = points.length;

  const xs = points.map((_, i) => PAD + (i / (n - 1)) * (W - PAD * 2));
  const ys = points.map((p) => PAD + (1 - p.usd / maxUsd) * (H - PAD * 2));

  const linePoints = xs.map((x, i) => `${x.toFixed(1)},${ys[i]!.toFixed(1)}`).join(' ');
  const areaPoints = [
    `${xs[0]!.toFixed(1)},${(H - PAD).toFixed(1)}`,
    ...xs.map((x, i) => `${x.toFixed(1)},${ys[i]!.toFixed(1)}`),
    `${xs[n - 1]!.toFixed(1)},${(H - PAD).toFixed(1)}`,
  ].join(' ');

  const svg =
    `<svg class="opsui-obs__svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">` +
    `<polygon class="opsui-obs__svg-area" points="${areaPoints}"/>` +
    `<polyline class="opsui-obs__svg-line" points="${linePoints}"/>` +
    `</svg>`;

  const firstDate = esc(points[0]!.date.slice(5, 10));
  const lastDate  = esc(points[n - 1]!.date.slice(5, 10));
  const dateRow   =
    `<div class="opsui-obs__chart-dates">` +
    `<span>${firstDate}</span><span>${lastDate}</span>` +
    `</div>`;

  return Card({ title, subtitle, body: `<div class="opsui-obs__chart">${svg}${dateRow}</div>` });
}

function transcriptSizesRegion(sizes: TranscriptSize[]): string {
  const body =
    sizes.length === 0
      ? `<p class="opsui-empty">No transcript size data.</p>`
      : `<ul class="opsui-obs__sizes" role="list">` +
        sizes
          .map(
            (s) =>
              `<li class="opsui-obs__size-row">` +
              `<span class="opsui-obs__size-label">${esc(s.label)}</span>` +
              `<span class="opsui-obs__size-value">${esc(formatBytes(s.bytes))}</span>` +
              `</li>`,
          )
          .join('') +
        `</ul>`;

  return Card({ title: 'Transcript sizes', subtitle: 'Session transcript files', body });
}

function provenanceRegion(env: ProjectionEnvelope<ObservabilityData>): string {
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
    variant:  'inset',
    title:    'Provenance',
    subtitle: 'Every value above traces to the transcript logs',
    body:
      `<p class="opsui-provenance__meta">${meta}</p>` +
      (chips ? `<div class="opsui-provenance__chips">${chips}</div>` : ''),
  });
}

// ─── Entry point ──────────────────────────────────────────────────────────────

/** Render the observability projection from its envelope. A `failed` envelope
 *  renders ProjectionFailure and nothing else. */
export function ObservabilityProjection(env: ProjectionEnvelope<ObservabilityData>): string {
  if (env.state === 'failed') {
    const ev = env.evidence[0];
    return ProjectionFailure({
      projection:       'Observability',
      reason:           'observability input did not parse cleanly',
      lastGoodSequence: env.ledgerSequence,
      lastGoodAt:       env.generatedAt,
      retry:            'refreshed on the next telemetry cycle',
      ...(ev
        ? { evidence: { id: ev.id, label: ev.label, ...(ev.href ? { href: ev.href } : {}) } }
        : {}),
    });
  }

  const d = env.data;
  return (
    `<div class="opsui-observability" data-projection="observability" data-state="${env.state}">` +
    safeRegion('Observability',               () => glanceRegion(d.glance)) +
    safeRegion('Token usage by loop',         () => tokenRowsRegion(d.rows, d.totalTokens, d.totalUsd)) +
    safeRegion('7-day cost trend',            () => ChartFrame(d.trendPoints)) +
    safeRegion('Transcript sizes',            () => transcriptSizesRegion(d.transcriptSizes)) +
    safeRegion('Provenance',                  () => provenanceRegion(env)) +
    `</div>`
  );
}
