import { formatLocal } from '../render/html.ts';
// Timeline adapter — WI-176. Maps raw ledger events (pre-read by the app layer from the JSONL
// ledger) into a typed ProjectionEnvelope<TimelineData>. Handles both per-item (itemId filter)
// and all-items recent-activity views. No Node.js imports — the app layer reads the FS.

import type { OperationalState } from '../states/operational-state.ts';
import type { ProjectionEnvelope } from './projection-types.ts';

const SCHEMA_VERSION = '1';

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

/** One raw ledger event, as the app layer reads it from the JSONL files. */
export type TimelineEvent = {
  id: string;
  ts: string;
  actor: string;
  item: string;
  type: string;
  data: Record<string, unknown>;
};

/** App-layer input: pre-read events + optional item filter + generation timestamp. */
export type TimelineInput = {
  events: TimelineEvent[];
  /** Present when the page is filtered to a single WI-NNN item. */
  itemId?: string;
  generatedAt: string;
};

/** One rendered timeline row — all fields are pre-formatted strings. */
export type TimelineRow = {
  eventId: string;
  ts: string;
  tsLabel: string;
  itemId: string;
  type: string;
  actor: string;
  operationalState: OperationalState;
  /** Key-value pairs extracted from the event data, for display as the EventRow summary. */
  fields: { key: string; value: string }[];
};

/** The typed payload the timeline projection renders. */
export type TimelineData = {
  /** Present when the page is filtered to one item. */
  itemId?: string;
  /** Text from the item.captured event — shown as a header in per-item view. */
  capturedText?: string;
  rows: TimelineRow[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TYPE_TO_STATE: Record<string, OperationalState> = {
  'item.captured':    'neutral',
  'item.routed':      'neutral',
  'item.queued':      'neutral',
  'item.parked':      'warning',
  'item.unparked':    'neutral',
  'item.approved':    'success',
  'item.rejected':    'critical',
  'item.merged':      'success',
  'item.accepted':    'success',
  'item.feedback':    'neutral',
  'msg.in':           'neutral',
  'msg.out':          'progress',
  'build.dispatched': 'progress',
  'build.finished':   'success',
  'build.crashed':    'critical',
  'gate.passed':      'success',
  'gate.failed':      'critical',
  'gate.parked':      'warning',
};

function eventState(type: string): OperationalState {
  return TYPE_TO_STATE[type] ?? 'neutral';
}

function formatTsLabel(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  return formatLocal(d, { seconds: true });
}

const TEXT_LIMIT = 200;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const trunc = (s: string): string => (s.length > TEXT_LIMIT ? s.slice(0, TEXT_LIMIT) + '…' : s);

function extractFields(type: string, data: Record<string, unknown>): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  const add = (key: string, val: string): void => { out.push({ key, value: trunc(val) }); };

  switch (type) {
    case 'item.captured':
    case 'item.feedback':
    case 'msg.in':
    case 'msg.out': {
      const text = str(data['text']); if (text) add('text', text);
      if (type === 'item.captured') {
        const src = str(data['source']); if (src) add('source', src);
        const ext = str(data['externalRef']); if (ext) add('externalRef', ext);
      }
      break;
    }
    case 'item.routed': {
      const route = str(data['route']); if (route) add('route', route);
      const reply = str(data['reply']); if (reply) add('reply', reply);
      break;
    }
    case 'item.queued': {
      const priority = str(data['priority']); if (priority) add('priority', priority);
      const model    = str(data['model']);    if (model)    add('model', model);
      const touches  = str(data['touches']);  if (touches)  add('touches', touches);
      const spec     = str(data['spec']);     if (spec)     add('spec', spec);
      break;
    }
    case 'item.parked':
    case 'gate.parked':
    case 'gate.failed': {
      const reason = str(data['reason']); if (reason) add('reason', reason);
      break;
    }
    case 'item.unparked':
    case 'item.approved':
    case 'item.rejected':
    case 'item.accepted': {
      const by = str(data['by']); if (by) add('by', by);
      break;
    }
    case 'item.merged': {
      const commit = str(data['commit']); if (commit) add('commit', commit);
      if (data['deployed'] === true) add('deployed', 'yes');
      break;
    }
    case 'build.dispatched': {
      const attempt = typeof data['attempt'] === 'number' ? String(data['attempt']) : str(data['attempt']);
      if (attempt) add('attempt', attempt);
      const provider = str(data['provider']); if (provider) add('provider', provider);
      const model    = str(data['model']);    if (model)    add('model', model);
      const branch   = str(data['branch']);   if (branch)   add('branch', branch);
      break;
    }
    case 'build.crashed': {
      const reason = str(data['reason']);     if (reason) add('reason', reason);
      const tail   = str(data['stderrTail']); if (tail)   add('stderr', tail);
      break;
    }
    case 'build.finished': {
      const commit = str(data['commit']); if (commit) add('commit', commit);
      break;
    }
    case 'gate.passed': {
      const tests = str(data['tests']); if (tests) add('tests', tests);
      break;
    }
    default: {
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === 'string' || typeof v === 'number') add(k, String(v));
      }
    }
  }
  return out;
}

function mapRow(ev: TimelineEvent): TimelineRow {
  return {
    eventId:          ev.id,
    ts:               ev.ts,
    tsLabel:          formatTsLabel(ev.ts),
    itemId:           ev.item,
    type:             ev.type,
    actor:            ev.actor,
    operationalState: eventState(ev.type),
    fields:           extractFields(ev.type, ev.data),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Build the timeline envelope from pre-read ledger events.
 *  Never throws: malformed/missing input yields a `failed` envelope. */
export function timelineProjectionFromInput(
  raw: unknown,
  opts: { ledgerSequence: number; staleAfterSeconds?: number } = { ledgerSequence: 0 },
): ProjectionEnvelope<TimelineData> {
  const staleAfter = opts.staleAfterSeconds ?? 45;
  const now = new Date().toISOString();
  const freshUntil = new Date(new Date(now).getTime() + staleAfter * 1000).toISOString();

  const failed = (reason: string): ProjectionEnvelope<TimelineData> => ({
    projectionId: 'timeline',
    schemaVersion: SCHEMA_VERSION,
    foldVersion: 'ledger',
    ledgerSequence: opts.ledgerSequence,
    generatedAt: now,
    freshUntil,
    state: 'failed',
    data: { rows: [] },
    evidence: [{ id: 'ledger-events', kind: 'ledger-events', label: reason }],
  });

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return failed('invalid input');
  const input = raw as Record<string, unknown>;
  if (!Array.isArray(input['events'])) return failed('events must be an array');

  const inputEvents = input['events'] as unknown[];
  const events: TimelineEvent[] = inputEvents
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && !Array.isArray(e))
    .map((e) => ({
      id:    typeof e['id']    === 'string' ? e['id']    : '',
      ts:    typeof e['ts']    === 'string' ? e['ts']    : '',
      actor: typeof e['actor'] === 'string' ? e['actor'] : '?',
      item:  typeof e['item']  === 'string' ? e['item']  : '',
      type:  typeof e['type']  === 'string' ? e['type']  : '',
      data:  (e['data'] && typeof e['data'] === 'object' && !Array.isArray(e['data']))
               ? e['data'] as Record<string, unknown>
               : {},
    }))
    .filter((e) => e.id && e.ts && e.type);

  const itemId = typeof input['itemId'] === 'string' ? input['itemId'] : undefined;
  const generatedAt = typeof input['generatedAt'] === 'string' ? input['generatedAt'] : now;

  const captureEv = itemId ? events.find((e) => e.type === 'item.captured') : undefined;
  const capturedText =
    captureEv && typeof captureEv.data['text'] === 'string' ? captureEv.data['text'] : undefined;

  const rows = events.map(mapRow);

  return {
    projectionId: 'timeline',
    schemaVersion: SCHEMA_VERSION,
    foldVersion: 'ledger',
    ledgerSequence: opts.ledgerSequence,
    generatedAt,
    freshUntil: new Date(new Date(generatedAt).getTime() + staleAfter * 1000).toISOString(),
    state: 'fresh',
    data: {
      ...(itemId ? { itemId } : {}),
      ...(capturedText ? { capturedText } : {}),
      rows,
    },
    evidence: [
      {
        id:    'ledger-events',
        kind:  'ledger-events',
        label: itemId ? `${itemId} ledger events` : 'Recent ledger events',
        // Item-hub link sweep (WI-349): a per-item timeline's own provenance chip now
        // points at the canonical hub (the standalone per-item route 301s there).
        ...(itemId ? { href: `/item/${itemId}` } : {}),
      },
    ],
  };
}
