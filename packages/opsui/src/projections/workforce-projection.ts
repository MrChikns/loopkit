// Workforce projection — the founder's view of the build
// plane's live workers: beat health (reactor + dispatch), active worktree sessions,
// recent outcomes, and any tripped circuit breakers. Composed ONLY from shared
// components. A failed envelope renders ProjectionFailure and
// nothing else — never a falsely-calm "all quiet" over a broken plane.

import { Card } from '../components/Card.ts';
import { EventRow } from '../components/EventRow.ts';
import { MetricTile } from '../components/MetricTile.ts';
import { ProjectionFailure } from '../components/ProjectionFailure.ts';
import { StatusBadge } from '../components/StatusBadge.ts';
import { esc } from '../render/html.ts';
import type { ProjectionEnvelope } from './projection-types.ts';
import type {
  WorkforceData,
  BeatRecord,
  BuildRecord,
  OutcomeRecord,
  BreakerRecord,
} from './workforce-adapter.ts';

// ─── Region renderers (each composes shared components only) ──────────────────

function glanceRegion(metrics: WorkforceData['glance']): string {
  return Card({
    variant: 'glance',
    title: 'Workforce',
    subtitle: 'Beat health · active builds · circuit breakers',
    body: `<div class="opsui-glancegrid">${metrics.map((m) => MetricTile(m)).join('')}</div>`,
  });
}

/** One WorkerSession card row — a beat running its heartbeat cycle. */
function beatRow(b: BeatRecord): string {
  const age = b.ageSec !== undefined ? `${b.ageSec}s ago` : 'age unknown';
  const meta: string[] = [age];
  if (b.pid !== undefined) meta.push(`pid ${b.pid}`);
  return EventRow({
    state: b.state,
    title: b.name,
    metadata: meta,
    badge: { state: b.state, label: b.stateLabel },
  });
}

function beatsRegion(beats: BeatRecord[]): string {
  const headerAside = StatusBadge({
    state: beats.length ? 'neutral' : 'warning',
    label: `${beats.length} beat${beats.length === 1 ? '' : 's'}`,
  });
  const body =
    beats.length === 0
      ? `<p class="opsui-empty">No beat data — is the loop running?</p>`
      : beats.map(beatRow).join('');
  return Card({
    title: 'Worker sessions',
    subtitle: 'reactor · dispatch — each is one heartbeat cycle',
    headerAside,
    body,
  });
}

function inflightRegion(builds: BuildRecord[]): string {
  const headerAside = StatusBadge({
    state: builds.length ? 'progress' : 'neutral',
    label: builds.length ? `${builds.length} active` : 'idle',
  });
  const body =
    builds.length === 0
      ? `<p class="opsui-empty">No active builds — lane idle.</p>`
      : builds
          .map((b) => {
            const meta: string[] = [`attempt ${b.attempt}`];
            if (b.model) meta.push(b.model);
            if (b.elapsedMin !== undefined) meta.push(`${b.elapsedMin}m elapsed`);
            if (b.budgetMin !== undefined) meta.push(`${b.budgetMin}m budget`);
            return EventRow({
              state: 'progress',
              title: b.id,
              metadata: meta,
              badge: { state: 'progress', label: 'building' },
            });
          })
          .join('');
  return Card({
    title: 'In-flight builds',
    subtitle: 'Active worker sessions dispatched to a worktree',
    headerAside,
    body,
  });
}

function outcomesRegion(outcomes: OutcomeRecord[]): string {
  const body =
    outcomes.length === 0
      ? `<p class="opsui-empty">No recent outcomes.</p>`
      : outcomes
          .map((o) => {
            const meta: string[] = [o.outcome];
            if (o.at) meta.push(o.at.slice(0, 16).replace('T', ' '));
            return EventRow({
              state: o.state,
              title: o.spec ? `${o.id} · ${o.spec}` : o.id,
              metadata: meta,
              badge: { state: o.state, label: o.outcome },
            });
          })
          .join('');
  return Card({
    title: 'Recent outcomes',
    subtitle: 'Merged · parked · rejected — last 7 days',
    body,
  });
}

function breakerRegion(states: BreakerRecord[]): string {
  if (states.length === 0) return '';
  const body = states
    .map((b) =>
      EventRow({
        state: 'critical',
        title: b.spec ? `${b.id} · ${b.spec}` : b.id,
        metadata: [`${b.attempts} attempts exhausted`],
        badge: { state: 'critical', label: 'breaker tripped', emphasis: 'blocking' },
      }),
    )
    .join('');
  return Card({
    title: 'Breakers',
    subtitle: 'Items parked after exhausting their retry budget',
    headerAside: StatusBadge({
      state: 'critical',
      label: `${states.length} tripped`,
      emphasis: 'blocking',
    }),
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
    `fold ${esc(env.foldVersion)} · seq #${esc(env.ledgerSequence)} · ` +
    `generated ${esc(env.generatedAt)}`;
  return Card({
    variant: 'inset',
    title: 'Provenance',
    subtitle: 'Every value above traces to the plane',
    body:
      `<p class="opsui-provenance__meta">${meta}</p>` +
      (chips ? `<div class="opsui-provenance__chips">${chips}</div>` : ''),
  });
}

// ─── Entry point ──────────────────────────────────────────────────────────────

/** Render the workforce projection workspace from its envelope. A `failed`
 *  envelope renders ProjectionFailure and nothing else. */
export function WorkforceProjection(env: ProjectionEnvelope<WorkforceData>): string {
  if (env.state === 'failed') {
    const ev = env.evidence[0];
    return ProjectionFailure({
      projection: 'Workforce',
      reason: 'workforce summary did not parse cleanly',
      lastGoodSequence: env.ledgerSequence,
      lastGoodAt: env.generatedAt,
      retry: 'reactor re-folds on the next beat (30s)',
      ...(ev
        ? { evidence: { id: ev.id, label: ev.label, ...(ev.href ? { href: ev.href } : {}) } }
        : {}),
    });
  }

  const d = env.data;
  return (
    `<div class="opsui-workforce" data-projection="workforce" data-state="${env.state}">` +
    glanceRegion(d.glance) +
    beatsRegion(d.beats) +
    inflightRegion(d.inflight) +
    outcomesRegion(d.recentOutcomes) +
    breakerRegion(d.breakerStates) +
    provenanceRegion(env) +
    `</div>`
  );
}
