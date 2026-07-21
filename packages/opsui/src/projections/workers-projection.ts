// Workers projection — nav IA rewire. NET-NEW page
// composed from the pieces relocated OUT of Missions (work-projection.ts): in-flight
// run cards (phase checklist, touch chips, Stop/Escalate), queued/parked rows carrying
// Hold/Resume/Retry verbs, the "why isn't this building?" scheduling region, and the
// beats/breaker workforce sections. Every relocated region renderer is IMPORTED from
// work-projection.ts (relocation by import, not copy — they still live and are owned
// there); this file only adds the new "queued rows" region and composes the whole page.
// A failed envelope renders ProjectionFailure and nothing else.

import { Card } from '../components/Card.ts';
import { EventRow } from '../components/EventRow.ts';
import { MetricTile } from '../components/MetricTile.ts';
import { ProjectionFailure } from '../components/ProjectionFailure.ts';
import { StatusBadge } from '../components/StatusBadge.ts';
import { esc } from '../render/html.ts';
import { schedulingRegion, beatsRegion, breakerRegion, touchChips, phaseChecklist } from './work-projection.ts';
import { unblockNote } from './fold-adapter.ts';
import type { WorkersData, InflightBuild } from './workers-adapter.ts';
import type { WorkItem } from './work-adapter.ts';
import type { ProjectionEnvelope } from './projection-types.ts';

// ─── Region renderers ────────────────────────────────────────────────────────

function glanceRegion(metrics: WorkersData['glance']): string {
  const tiles = metrics.map((m) => MetricTile(m)).join('');
  return Card({
    variant: 'glance',
    title: 'Workers',
    subtitle: 'The AI workforce — in-flight builds, queue, and beats',
    body: `<div class="opsui-glancegrid">${tiles}</div>`,
  });
}

/** In-flight run card — phase checklist + touch chips (from `BuildRecord`, same renderers
 *  work-projection.ts owns) PLUS Stop/Escalate action buttons (joined onto the build by
 *  workers-adapter.ts). One card carries all three, per the contract. */
function inflightRow(build: InflightBuild): string {
  const meta: string[] = [`attempt ${build.attempt}`];
  if (build.model) meta.push(build.model);
  if (build.elapsedMin !== undefined) meta.push(`${build.elapsedMin}m elapsed`);
  if (build.budgetMin !== undefined) meta.push(`${build.budgetMin}m budget`);
  if (build.branch) meta.push(`branch ${build.branch}`);
  const rowBody = `${phaseChecklist(build.branch)}${touchChips(build.touches)}`;
  return EventRow({
    state: 'progress',
    title: build.id,
    metadata: meta,
    badge: { state: 'progress', label: 'building' },
    body: rowBody,
    ...(build.actions && build.actions.length > 0 ? { actions: build.actions } : {}),
  });
}

function inflightRegion(builds: InflightBuild[]): string {
  const headerAside = StatusBadge({
    state: builds.length ? 'progress' : 'neutral',
    label: builds.length ? `${builds.length} active` : 'idle',
  });
  const body = builds.length === 0
    ? `<p class="opsui-empty">No active builds — lane idle.</p>`
    : builds.map(inflightRow).join('');
  return Card({
    title: 'In-flight builds',
    subtitle: 'Active worker sessions dispatched to a worktree',
    headerAside,
    body,
  });
}

/** Queued/parked rows carrying Hold/Resume/Retry/Escalate verbs (relocated out of
 *  Missions' board — those rows are read-only there now). Building items are excluded
 *  here; they render as in-flight cards above instead. */
function queuedRow(item: WorkItem): string {
  // Parked rows carry a parkKind-aware "what unblocks this" line — queued
  // (not-yet-parked) rows have nothing to unblock, so this stays parked-only.
  const unblock = item.state === 'parked'
    ? `<p class="opsui-work__unblock-note">${esc(unblockNote(item.parkKind, item.summary))}</p>`
    : '';
  return EventRow({
    state: item.operationalState,
    title: item.title,
    metadata: item.metadata,
    ...(item.summary ? { summary: item.summary } : {}),
    ...(unblock ? { body: unblock } : {}),
    badge: {
      state: item.operationalState,
      label: item.stateLabel,
      emphasis: item.emphasisForBadge,
    },
    ...(item.originChip ? { originChip: item.originChip } : {}),
    ...(item.actions && item.actions.length > 0 ? { actions: item.actions } : {}),
    evidence: item.evidence,
  });
}

function queuedRegion(items: WorkItem[]): string {
  const headerAside = StatusBadge({
    state: items.length ? 'warning' : 'success',
    label: items.length ? `${items.length} waiting` : 'Nothing waiting',
  });
  const body = items.length === 0
    ? `<p class="opsui-empty">Nothing queued or parked — every item is either building or clear.</p>`
    : items.map(queuedRow).join('');
  return Card({
    title: 'Queue',
    subtitle: 'Queued and parked items — Hold, Resume, Retry, Escalate',
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
    subtitle: 'Every value above traces to the ledger',
    body:
      `<p class="opsui-provenance__meta">${meta}</p>` +
      (chips ? `<div class="opsui-provenance__chips">${chips}</div>` : ''),
  });
}

// ─── Entry point ──────────────────────────────────────────────────────────────

/** Render the Workers projection workspace from its envelope. A `failed` envelope
 *  renders ProjectionFailure and nothing else. */
export function WorkersProjection(env: ProjectionEnvelope<WorkersData>): string {
  if (env.state === 'failed') {
    const foldEvidence = env.evidence[0];
    return ProjectionFailure({
      projection: 'Workers',
      reason: `fold ${env.foldVersion} did not fold cleanly`,
      lastGoodSequence: env.ledgerSequence,
      lastGoodAt: env.generatedAt,
      retry: 'reactor re-folds on the next beat (30s)',
      ...(foldEvidence
        ? { evidence: { id: foldEvidence.id, label: foldEvidence.label, ...(foldEvidence.href ? { href: foldEvidence.href } : {}) } }
        : {}),
    });
  }

  const d = env.data;
  return (
    `<div class="opsui-workers" data-projection="workers" data-state="${env.state}">` +
    glanceRegion(d.glance) +
    (d.workforce?.beats?.length ? beatsRegion(d.workforce.beats) : '') +
    inflightRegion(d.inflight) +
    queuedRegion(d.queued) +
    schedulingRegion(d.queueBlocking ?? []) +
    (d.workforce?.breakerStates?.length ? breakerRegion(d.workforce.breakerStates) : '') +
    provenanceRegion(env) +
    `</div>`
  );
}
