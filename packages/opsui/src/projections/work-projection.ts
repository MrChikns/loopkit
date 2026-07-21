// Work ledger projection ("Missions", nav collapse 9→5 WI-350)
// — the founder's view of every active work item: ONE EventRow board ordered
// building → queued → parked, each row carrying its valid run-control verbs
// (Stop/Escalate building, Hold/Escalate queued, Approve-Decline/Requeue-Dismiss/Resume
// parked), state-map badges, inline evidence drawer drill (→ timeline per item), glance
// metrics, backlog, a collapsed "Engine" section (beats/breakers/scheduling), answered/
// closed (collapsed), and provenance. Composed ONLY from shared components.
// A failed envelope renders ProjectionFailure and nothing else.
//
// Nav collapse 9→5 (WI-350): Missions RE-ABSORBS the Workers page (nav IA rewire had split
// them out). In-flight run cards (phase checklist + touch chips), the "why isn't this
// building?" scheduling region, and worker-session/beat/breaker sections all render here
// again — the region renderers still live in THIS file (beatsRegion/schedulingRegion/
// touchChips/phaseChecklist, all exported) and workers-projection.ts imports them from
// here (relocation by import, not copy) for its own now-unregistered standalone page.

import { Card } from '../components/Card.ts';
import { EventRow } from '../components/EventRow.ts';
import { MetricTile } from '../components/MetricTile.ts';
import { ProjectionFailure } from '../components/ProjectionFailure.ts';
import { StatusBadge } from '../components/StatusBadge.ts';
import { esc } from '../render/html.ts';
import { toTouchList, unblockNote } from './fold-adapter.ts';
import type { OperationalState } from '../states/operational-state.ts';
import type { ProjectionEnvelope } from './projection-types.ts';
import type { WorkLedgerData, WorkItem, QueueBlockingRow } from './work-adapter.ts';
import type { BeatRecord, BuildRecord, BreakerRecord } from './workforce-adapter.ts';
import { backlogStateToOp } from './planner-adapter.ts';
import type { BacklogRow } from './planner-adapter.ts';

// ─── Evidence drawer drill (server-rendered approximation) ──────────────────
//
// A later slice will wire `data-opsui-action="evidence:*"` to a full overlay drawer.
// Until then every EventRow is followed by a <details> block that exposes the
// same content inline — the operator can drill without the full overlay being complete.

/** Feature A — the context manifest. Honest label: this is the assembled scout BRIEF the
 *  agent was handed before building, not a file-by-file manifest of what it read. Absent
 *  brief ⇒ an explicit "built without a context pack" line, never a silently omitted block.
 *  The brief is drill-depth detail — spec + park
 *  reason alone usually carry the decision — so it folds CLOSED by default, summary styled
 *  like the pre-flip Details toggle (same drill classes, no new CSS). */
function contextBlock(item: WorkItem): string {
  if (!item.brief) {
    return `<p class="opsui-work__drill-context opsui-work__drill-context--none">` +
      `<strong>Context the agent had:</strong> No scout brief (built without a context pack)</p>`;
  }
  const modelSuffix = item.brief.model ? ` · ${esc(item.brief.model)}` : '';
  return (
    `<details class="opsui-work__drill opsui-work__drill--context">` +
    `<summary class="opsui-work__drill-summary">Context the agent had (assembled brief${modelSuffix}, ${esc(item.brief.at)})</summary>` +
    `<div class="opsui-work__drill-body"><p class="opsui-work__drill-context-body">${esc(item.brief.text)}</p></div>` +
    `</details>`
  );
}

function evidenceDrill(item: WorkItem): string {
  // The timeline is demoted: spec + park reason + context manifest render OPEN and primary
  // (no click needed); the Timeline drill-through demotes to a small secondary link BELOW
  // the details.
  const link = `<a class="opsui-work__timeline-link" href="${esc(item.evidence.href)}">${esc(item.evidence.label)}</a>`;
  const specBlock = item.spec
    ? `<p class="opsui-work__drill-spec">${esc(item.spec)}</p>`
    : '';
  const parkBlock = item.summary
    ? `<p class="opsui-work__drill-park"><strong>Park reason:</strong> ${esc(item.summary)}</p>`
    : '';
  const body = `${specBlock}${parkBlock}${contextBlock(item)}`;
  return (
    `<details class="opsui-work__drill" open>` +
    `<summary class="opsui-work__drill-summary">Details</summary>` +
    `<div class="opsui-work__drill-body">${body}</div>` +
    `</details>` +
    link
  );
}

// ─── Region renderers ────────────────────────────────────────────────────────

function glanceRegion(metrics: WorkLedgerData['glance']): string {
  const tiles = metrics.map((m) => MetricTile(m)).join('');
  return Card({
    variant: 'glance',
    title: 'Work ledger',
    subtitle: 'Active items across the build lane',
    body: `<div class="opsui-glancegrid">${tiles}</div>`,
  });
}

/** Parked rows must be honestly classified and actionable, not a bare alarming 'parked' badge
 *  for every kind. `decomposition` parks need nothing from the operator — they read as
 *  calm/neutral (already routed to the planner), never as needs-attention, so they get their
 *  own badge instead of the shared warning badge. */
function parkedBadge(item: WorkItem): { state: OperationalState; label: string; emphasis?: 'default' | 'blocking' | 'recommended' } {
  if (item.parkKind === 'decomposition') {
    return {
      state: 'neutral',
      label: item.successorRef ? `→ planner (${item.successorRef})` : '→ planner lane',
    };
  }
  return { state: item.operationalState, label: item.stateLabel, emphasis: item.emphasisForBadge };
}

/** A short pointer note under decision-parked rows — the SAME item is also actionable from
 *  the founder's decision desk, so acting here and there both resolve it (never two sources
 *  of truth, just two doors onto the one park event). */
function decisionDeskNote(item: WorkItem): string {
  if (item.parkKind !== 'decision') return '';
  return `<p class="opsui-work__park-note">Also on your decision desk → <a href="/command">/command</a></p>`;
}

/** parkKind-aware "what unblocks this" line — every parked row on Missions
 *  carries it, not just decision parks (those also keep {@link decisionDeskNote} pointing
 *  at the desk). Shares the ONE `unblockNote` helper (fold-adapter.ts, imported via
 *  work-adapter.ts) rather than re-deriving the copy per surface. */
function unblockNoteRegion(item: WorkItem): string {
  const text = unblockNote(item.parkKind, item.summary);
  return `<p class="opsui-work__unblock-note">${esc(text)}</p>`;
}

/** Build a building item's in-flight body — the phase checklist + touch chips a run card
 *  carries (Workers used to render these on a separate page; the nav collapse (WI-350)
 *  re-merges them into this ONE board so a building item is never duplicated across two
 *  surfaces). Looked up by id from `workforce.inflight` (the `BuildRecord` list) — absent
 *  when no workforce summary was passed through, in which case the row renders with no
 *  extra body, same as before the merge. */
function inflightBody(id: string, inflight: BuildRecord[] | undefined): string {
  const build = inflight?.find((b) => b.id === id);
  if (!build) return '';
  return `${phaseChecklist(build.branch)}${touchChips(build.touches)}`;
}

function boardRegion(items: WorkItem[], shippedThisWeek: number, inflight: BuildRecord[] | undefined): string {
  const headerAside = StatusBadge({
    state: items.length ? 'neutral' : 'success',
    label: items.length ? `${items.length} active` : 'Lane clear',
  });
  const emptyMsg = shippedThisWeek > 0
    ? `<p class="opsui-empty">${shippedThisWeek} shipped this week — nothing active in the lane.</p>`
    : `<p class="opsui-empty">Lane is clear — no items building or queued.</p>`;

  // Nav collapse 9→5 (WI-350): Missions re-absorbs Workers — the ONE board now carries
  // every state's valid run-control verbs (building: Stop/Escalate; queued: Hold/Escalate;
  // parked: Approve/Decline (decision), Requeue/Dismiss (ops), Resume (hold); decomposition
  // parks stay button-less/calm). `item.actions` already carries the correct verb set per
  // state (buildRunControlActions, work-adapter.ts) — this renderer no longer filters them
  // down to parked-only, so nothing needs re-deciding here, only rendering.
  const body = items.length === 0
    ? emptyMsg
    : items.map((item) => {
        const isParked = item.state === 'parked';
        const isBuilding = item.state === 'building';
        const badge = isParked ? parkedBadge(item) : {
          state: item.operationalState,
          label: item.stateLabel,
          emphasis: item.emphasisForBadge,
        };
        const summary = isParked && item.parkKind === 'ops' && !item.summary
          ? 'no reason recorded'
          : item.summary;
        const rowBody = isBuilding ? inflightBody(item.id, inflight) : '';
        const row = EventRow({
          state: item.operationalState,
          title: item.title,
          metadata: item.metadata,
          ...(summary ? { summary } : {}),
          badge,
          ...(item.originChip ? { originChip: item.originChip } : {}),
          ...(rowBody ? { body: rowBody } : {}),
          ...(!(isParked && item.parkKind === 'decomposition') && item.actions && item.actions.length > 0
            ? { actions: item.actions }
            : {}),
        });
        const unblock = isParked ? unblockNoteRegion(item) : '';
        const note = isParked ? decisionDeskNote(item) : '';
        return `<div class="opsui-work__item">${row}${unblock}${note}${evidenceDrill(item)}</div>`;
      }).join('');

  return Card({
    title: 'Board',
    subtitle: 'Building → queued → parked',
    headerAside,
    body,
  });
}

function answeredRegion(items: WorkItem[]): string {
  if (items.length === 0) return '';
  const body = items.map((item) =>
    EventRow({
      state: item.operationalState,
      title: item.title,
      metadata: item.metadata,
      badge: { state: item.operationalState, label: item.stateLabel },
      evidence: item.evidence,
    }),
  ).join('');
  const card = Card({
    variant: 'inset',
    title: 'Answered / Closed',
    subtitle: 'Terminal-routed items — answered, questions, duplicates',
    body,
  });
  return (
    `<details class="opsui-work__answered">` +
    `<summary class="opsui-work__answered-summary">Answered / Closed (${items.length})</summary>` +
    card +
    `</details>`
  );
}

// ─── Scheduling region — "why isn't this building?" ────────────────────────────
// Renders the fold's queueBlocking readout (@loopkit/core src/cli.ts buildQueueBlocking) as
// a plain readable list — NOT a graph. Every reason string is computed upstream from the
// same predicates dispatch itself gates on, so this never re-decides runnability, only
// reports it.

function schedulingRow(row: QueueBlockingRow): string {
  return EventRow({
    state: row.runnable ? 'success' : 'warning',
    title: row.id,
    metadata: [],
    ...(row.reason ? { summary: row.reason } : {}),
    badge: row.runnable
      ? { state: 'success', label: 'runnable now' }
      : { state: 'warning', label: 'blocked' },
  });
}

export function schedulingRegion(rows: QueueBlockingRow[]): string {
  const blocked = rows.filter((r) => !r.runnable).length;
  const headerAside = StatusBadge({
    state: blocked ? 'warning' : 'success',
    label: blocked ? `${blocked} blocked` : 'all runnable',
  });
  const body = rows.length === 0
    ? `<p class="opsui-empty">Queue is empty — nothing waiting to build.</p>`
    : rows.map(schedulingRow).join('');
  return Card({
    title: 'Why isn’t this building?',
    subtitle: 'Every queued or parked item, and the concrete reason it is not in flight',
    headerAside,
    body,
  });
}

// ─── Workforce sections (console consolidation 1/4) ───────────────────────────
// Copied VERBATIM from workforce-projection.ts (region-renderer bodies unchanged)
// so the working EventRow form/composer action wiring and class names survive the
// fold. Each is guarded by the caller on `data.workforce?.<field>?.length`.

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

export function beatsRegion(beats: BeatRecord[]): string {
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

/** Small non-interactive touch-path chips — same visual vocabulary as the provenance strip
 *  (`opsui-provenance__chip`) but scoped to the run card so a style tweak there doesn't
 *  silently ripple here. */
export function touchChips(touches: string | undefined): string {
  const list = toTouchList(touches);
  if (list.length === 0) return '';
  const chips = list.map((t) => `<span class="opsui-inflight__chip">${esc(t)}</span>`).join('');
  return `<div class="opsui-inflight__chips">${chips}</div>`;
}

/** Truthful phase checklist for a building item. `branch` (currentBuild.branch) is the real
 *  signal that a worktree/branch was actually created, so its presence — not an assumption —
 *  decides whether "dispatched" reads as done. The gate always runs POST-flight for an item
 *  still in `building` state, so it is rendered as an upcoming step, never in-progress/passed
 *  (spec trap: no invented %/ETA, no claimed-done gate). */
export function phaseChecklist(branch: string | undefined): string {
  const dispatched = branch
    ? `<li class="opsui-inflight__phase opsui-inflight__phase--done">✓ dispatched</li>`
    : `<li class="opsui-inflight__phase opsui-inflight__phase--pending">○ dispatched (no branch recorded yet)</li>`;
  return (
    `<ol class="opsui-inflight__phases">` +
    dispatched +
    `<li class="opsui-inflight__phase opsui-inflight__phase--active">● building</li>` +
    `<li class="opsui-inflight__phase opsui-inflight__phase--pending">○ gate</li>` +
    `</ol>`
  );
}

// Nav IA rewire: the plain in-flight card and the
// recent-outcomes card that used to live here are GONE. Workers needs its in-flight cards
// to also carry Stop/Escalate action buttons (joined onto the BuildRecord by
// workers-adapter.ts), which the old Missions-only in-flight helper couldn't express, so
// workers-projection.ts owns its own `inflightRegion` built from the exported
// `touchChips`/`phaseChecklist` primitives above instead of importing this one.
// Recent-outcomes was neither asked for on Missions nor Workers by the contract, and its
// canonical home is workforce-projection.ts's own `outcomesRegion` (the still-exported,
// no-longer-registered standalone module) — this was a "console consolidation 1/4" fold-in
// duplicate, safely deleted rather than left dead.

export function breakerRegion(states: BreakerRecord[]): string {
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

// ─── Groomable backlog (console consolidation 4/4) ─────────────────────────────
// Copied VERBATIM from the retired planner-projection.ts's backlogRegion/backlogStateLabel
// (region-renderer bodies unchanged) so the working markup and class names survive the
// fold. Guarded by the caller on `data.backlog?.length`.

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
    `<div class="opsui-work__backlog">` +
    Card({
      title:       'Groomable backlog',
      subtitle:    'Groomable items within open gates',
      headerAside,
      body,
    }) +
    `</div>`
  );
}

// ─── Engine — collapsed scheduling/beats/breakers (nav collapse 9→5, WI-350) ───────
// Everything the founder needs to act on (building/queued/parked items + their verbs)
// is already on the board above; "why isn't this building?" plus beat/breaker health is
// plane-diagnostic detail, so it folds into ONE collapsed `<details>` at the bottom —
// zero-JS, matching the Answered/Closed and Auto-accepting-soon collapse convention.

function engineRegion(
  queueBlocking: QueueBlockingRow[] | undefined,
  beats: BeatRecord[] | undefined,
  breakerStates: BreakerRecord[] | undefined,
): string {
  const hasBeats = (beats?.length ?? 0) > 0;
  const hasBreakers = (breakerStates?.length ?? 0) > 0;
  const hasScheduling = (queueBlocking?.length ?? 0) > 0;
  if (!hasBeats && !hasBreakers && !hasScheduling) return '';
  const body =
    (hasBeats ? beatsRegion(beats!) : '') +
    schedulingRegion(queueBlocking ?? []) +
    (hasBreakers ? breakerRegion(breakerStates!) : '');
  const breakerNote = hasBreakers
    ? StatusBadge({ state: 'critical', label: `${breakerStates!.length} breaker${breakerStates!.length === 1 ? '' : 's'}`, emphasis: 'blocking' })
    : '';
  return (
    `<details class="opsui-work__engine">` +
    `<summary class="opsui-work__engine-summary">Engine — scheduling, beats, breakers${breakerNote}</summary>` +
    `<div class="opsui-work__engine-body">${body}</div>` +
    `</details>`
  );
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

/** Render the work ledger projection workspace from its envelope. A `failed`
 *  envelope renders ProjectionFailure and nothing else. */
export function WorkProjection(env: ProjectionEnvelope<WorkLedgerData>): string {
  if (env.state === 'failed') {
    const foldEvidence = env.evidence[0];
    return ProjectionFailure({
      projection: 'Work ledger',
      reason: `fold ${env.foldVersion} did not fold cleanly`,
      lastGoodSequence: env.ledgerSequence,
      lastGoodAt: env.generatedAt,
      retry: 'reactor re-folds on the next beat (30s)',
      ...(foldEvidence
        ? { evidence: { id: foldEvidence.id, label: foldEvidence.label, ...(foldEvidence.href ? { href: foldEvidence.href } : {}) } }
        : {}),
    });
  }

  // Nav collapse 9→5 (WI-350): Missions re-absorbs Workers — one board (building → queued
  // → parked, run-control verbs on every applicable row), backlog, a collapsed Engine
  // section (scheduling + beats + breakers), and answered/closed (also collapsed).
  const d = env.data;
  return (
    `<div class="opsui-work" data-projection="work" data-state="${env.state}">` +
    glanceRegion(d.glance) +
    boardRegion(d.active, d.shippedThisWeek, d.workforce?.inflight) +
    (d.backlog?.length ? backlogRegion(d.backlog) : '') +
    answeredRegion(d.answered ?? []) +
    engineRegion(d.queueBlocking, d.workforce?.beats, d.workforce?.breakerStates) +
    provenanceRegion(env) +
    `</div>`
  );
}
