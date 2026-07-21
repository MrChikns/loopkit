// Artifacts projection — nav IA rewire. Read-only
// list of REAL build artifacts (gate logs, diffs, salvage patches) per work item/
// attempt, mtime-sorted newest first, capped ~50 by the caller. Composed ONLY from
// shared components. A failed envelope renders ProjectionFailure
// and nothing else.
//
// Nav collapse 9→5 (WI-350): the Artifacts registry entry retired — `artifactsSystemRegion`
// is exported below so health-projection.ts composes it as a System region carrying
// `id="artifacts"` (relocation by import, not copy). This file's own `ArtifactsProjection`
// keeps working for callers that still hold a standalone `ArtifactsData` envelope.

import { Card } from '../components/Card.ts';
import { EventRow } from '../components/EventRow.ts';
import { MetricTile } from '../components/MetricTile.ts';
import { ProjectionFailure } from '../components/ProjectionFailure.ts';
import { StatusBadge } from '../components/StatusBadge.ts';
import { esc } from '../render/html.ts';
import type { ProjectionEnvelope } from './projection-types.ts';
import type { ArtifactsData, ArtifactRow } from './artifacts-adapter.ts';

// ─── Region renderers ─────────────────────────────────────────────────────────

function glanceRegion(metrics: ArtifactsData['glance']): string {
  const tiles = metrics.map((m) => MetricTile(m)).join('');
  return Card({
    variant: 'glance',
    title: 'Artifacts',
    subtitle: 'Real build evidence — gate logs, diffs, salvage patches',
    body: `<div class="opsui-glancegrid">${tiles}</div>`,
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function kindLabel(kind: ArtifactRow['kind']): string {
  switch (kind) {
    case 'gate.log': return 'gate log';
    case 'salvage.patch': return 'salvage patch';
    case 'salvage.md': return 'salvage note';
    case 'manifest.json': return 'context manifest';
    case 'diff': return 'diff';
    default: return 'build log';
  }
}

// Exported (item-hub link sweep, WI-349) so `item-hub-projection.ts` reuses the SAME
// row renderer for the hub's Evidence region, filtered to one WI — one renderer, never
// a second copy that could drift from this page's row markup.
export function artifactRow(a: ArtifactRow): string {
  return EventRow({
    state: 'neutral',
    title: `${a.itemId} · attempt ${a.attempt} — ${kindLabel(a.kind)}`,
    metadata: [a.filename, formatBytes(a.sizeBytes), a.mtime],
    badge: { state: 'neutral', label: a.kind },
  });
}

function artifactsRegion(data: ArtifactsData): string {
  const { artifacts, truncated } = data;
  const headerAside = StatusBadge({
    state: artifacts.length ? 'neutral' : 'success',
    label: artifacts.length ? `${artifacts.length}${truncated ? '+' : ''} artifacts` : 'None yet',
  });
  const cappedNote = truncated
    ? `<p class="opsui-empty">Showing the newest ${artifacts.length} — older artifacts exist but are capped from this list.</p>`
    : '';
  const body = artifacts.length === 0
    ? `<p class="opsui-empty">No build artifacts yet — the dispatch beat writes gate logs, diffs, and salvage patches here as items build.</p>`
    : artifacts.map(artifactRow).join('') + cappedNote;
  return Card({
    title: 'Recent artifacts',
    subtitle: 'Newest first — read-only, one row per file on disk',
    headerAside,
    body,
  });
}

/** Artifacts as a System region (nav collapse 9→5, WI-350) — `id="artifacts"` anchors the
 *  `/health#artifacts` redirect target. Wraps the SAME `artifactsRegion` this page's own
 *  entry point composes — one renderer, two callers. */
export function artifactsSystemRegion(data: ArtifactsData): string {
  return `<section id="artifacts" class="opsui-artifacts" data-region="artifacts">${artifactsRegion(data)}</section>`;
}

function provenanceRegion(env: ProjectionEnvelope<ArtifactsData>): string {
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
    subtitle: 'Every value above traces to the ledger',
    body:
      `<p class="opsui-provenance__meta">${meta}</p>` +
      (chips ? `<div class="opsui-provenance__chips">${chips}</div>` : ''),
  });
}

// ─── Entry point ──────────────────────────────────────────────────────────────

/** Render the Artifacts projection from its envelope. A `failed` envelope renders
 *  ProjectionFailure and nothing else. */
export function ArtifactsProjection(env: ProjectionEnvelope<ArtifactsData>): string {
  if (env.state === 'failed') {
    const foldEvidence = env.evidence[0];
    return ProjectionFailure({
      projection: 'Artifacts',
      reason: `fold ${env.foldVersion} did not fold cleanly`,
      lastGoodSequence: env.ledgerSequence,
      lastGoodAt: env.generatedAt,
      retry: 'wire-up re-reads the artifact dir on the next request',
      ...(foldEvidence
        ? { evidence: { id: foldEvidence.id, label: foldEvidence.label, ...(foldEvidence.href ? { href: foldEvidence.href } : {}) } }
        : {}),
    });
  }

  const d = env.data;
  return (
    `<div class="opsui-artifacts" data-projection="artifacts" data-state="${env.state}">` +
    glanceRegion(d.glance) +
    artifactsRegion(d) +
    provenanceRegion(env) +
    `</div>`
  );
}
