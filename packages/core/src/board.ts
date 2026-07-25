/**
 * board.ts — Render the fold result as a human-readable markdown board.
 *
 * Groups items by state (newest-first within each group).
 * Ages are computed from event timestamps:
 *   - created age: now - createdAt
 *   - dispatch age: now - buildingAt (shown separately for building items)
 */

import { FoldResult, ItemRecord, ItemState } from './fold.js';
import { criteriaAbsenceNote } from './criteria.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function age(ts: string | undefined, now: Date): string {
  if (!ts) return '?';
  const diffMs = now.getTime() - new Date(ts).getTime();
  if (diffMs < 0) return '0s';
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function stateEmoji(state: ItemState): string {
  switch (state) {
    case 'captured':  return '📥';
    case 'routed':    return '🔀';
    case 'answered':  return '✉️';
    case 'queued':    return '⏳';
    case 'building':  return '🔨';
    case 'gated':     return '🔍';
    case 'parked':    return '🅿️';
    case 'approved':  return '✅';
    case 'merged':    return '🚀';
    case 'accepted':  return '🎉';
    case 'rejected':  return '❌';
    case 'done':      return '✔️';
    default:          return '❓';
  }
}

const STATE_ORDER: ItemState[] = [
  'building', 'gated', 'approved', 'parked',
  'queued', 'routed', 'captured',
  'merged', 'accepted', 'done', 'rejected', 'answered',
];

/**
 * States where an acceptance bar is expected, so its ABSENCE is worth saying out loud. An
 * answered/rejected/done item was never going to be measured against one, and printing a note
 * on those would be noise that trains the eye to skip the line that matters.
 */
const CRITERIA_EXPECTED_STATES: ReadonlySet<ItemState> = new Set<ItemState>([
  'queued', 'building', 'gated', 'approved', 'merged',
]);

/**
 * The acceptance criteria block (WI-193 win 3). Rendered from `rec.criteria`, which the fold
 * keeps CURRENT — an `item.respec` replaces the list wholesale, so a bar the operator has since
 * withdrawn cannot keep sitting on the board (the same rule the amended `spec` already follows).
 * Seeing what was promised beside what shipped is the whole payoff: it makes the human judgement
 * faster without adding a single line of automation.
 */
function criteriaBlock(rec: ItemRecord): string[] {
  if (rec.criteria && rec.criteria.length > 0) {
    return ['  · acceptance criteria:', ...rec.criteria.map(c => `    - ${c}`)];
  }
  if (!CRITERIA_EXPECTED_STATES.has(rec.state)) return [];
  return [`  · ${criteriaAbsenceNote(rec.criteriaExempt)}`];
}

function renderItem(rec: ItemRecord, now: Date): string {
  const createdAge = age(rec.createdAt ?? rec.capturedAt, now);
  const dispatchAge = rec.state === 'building' && rec.buildingAt
    ? ` · in-flight ${age(rec.buildingAt, now)}`
    : '';
  const attemptsStr = rec.attempts > 1 ? ` · attempt ${rec.attempts}` : '';
  const noveltyStr = rec.state === 'parked' && rec.parkNovelty === 'repeat-known' ? ' 🔁repeat' : '';
  const parkStr = rec.state === 'parked' && rec.parkReason ? ` · ${rec.parkReason}${noveltyStr}` : '';
  const modelStr = rec.model ? ` · model=${rec.model}` : '';
  const priorityStr = rec.priority ? ` · ${rec.priority}` : '';

  // Operator-facing render prefers the amended spec (item.respec target) over the immutable
  // original capture text — a respec'd item must never show its superseded description.
  const shortText = rec.spec
    ? rec.spec.slice(0, 80).replace(/\n/g, ' ') + (rec.spec.length > 80 ? '…' : '')
    : rec.sourceText
      ? rec.sourceText.slice(0, 80).replace(/\n/g, ' ') + (rec.sourceText.length > 80 ? '…' : '')
      : '';

  return [
    `- **${rec.id}** ${stateEmoji(rec.state)} ${rec.state}`,
    `  · created ${createdAge} ago${dispatchAge}${attemptsStr}${modelStr}${priorityStr}${parkStr}`,
    shortText ? `  · ${shortText}` : '',
    ...criteriaBlock(rec),
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// Board render
// ---------------------------------------------------------------------------

export interface BoardOptions {
  now?: Date;
  /** Include items in these states only (default: all) */
  states?: ItemState[];
}

/**
 * Render a markdown board from a fold result.
 */
export function renderBoard(result: FoldResult, options: BoardOptions = {}): string {
  const now = options.now ?? new Date();
  const filterStates = options.states ? new Set(options.states) : null;

  // Group items by state
  const groups = new Map<ItemState, ItemRecord[]>();
  for (const rec of result.items.values()) {
    if (filterStates && !filterStates.has(rec.state)) continue;
    if (!groups.has(rec.state)) groups.set(rec.state, []);
    groups.get(rec.state)!.push(rec);
  }

  // Sort each group newest-first by the most relevant timestamp
  for (const [, recs] of groups) {
    recs.sort((a, b) => {
      const ta = a.transitions[a.state] ?? a.createdAt ?? '';
      const tb = b.transitions[b.state] ?? b.createdAt ?? '';
      return tb.localeCompare(ta);
    });
  }

  const lines: string[] = ['# Loopkit Board\n'];
  lines.push(`_Generated ${now.toISOString()}_\n`);

  let hasContent = false;
  for (const state of STATE_ORDER) {
    const recs = groups.get(state);
    if (!recs || recs.length === 0) continue;
    hasContent = true;
    lines.push(`## ${stateEmoji(state)} ${state} (${recs.length})\n`);
    for (const rec of recs) {
      lines.push(renderItem(rec, now));
    }
    lines.push('');
  }

  if (!hasContent) {
    lines.push('_No items._');
  }

  return lines.join('\n');
}
