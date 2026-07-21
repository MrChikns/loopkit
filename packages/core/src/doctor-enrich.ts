/**
 * doctor-enrich.ts — deterministic capture-time diagnosis enrichment.
 *
 * When the doctor reaps a crashed/stalled build, a repair worker picking the requeued
 * item up cold has to rediscover "what changed on master recently" and "what else was
 * happening on the plane" via ad-hoc greps. These two pure/near-pure helpers attach that
 * evidence directly on the build.crashed/build.stalled event at capture time — no LLM,
 * git + already-loaded ledger events only. Follows the reality-check.ts pattern: no-shell
 * execFileSync, never throw, fail to an empty result on any git oddity (detached HEAD,
 * shallow clone, no merges yet).
 */
import { execFileSync } from 'node:child_process';
import { LedgerEvent, DoctorLedgerContextEntry } from './schema.js';

export const GIT_LOG_SINCE_MAX_LINES = 25;
export const LEDGER_CONTEXT_WINDOW_MINUTES = 15;
export const LEDGER_CONTEXT_MAX_ENTRIES = 10;

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/**
 * Oneline, no-merge commit subjects on master since the last merge commit — the change
 * window a repair worker most plausibly needs to correlate against. Falls back to a fixed
 * lookback of `maxLines` commits when master has no merge commit yet (young repo / squash
 * workflow). Never throws: detached HEAD, a shallow clone, or a missing `master` ref all
 * degrade to an empty array rather than blocking the doctor's requeue.
 */
export function getGitLogSinceLastMerge(
  repoRoot: string,
  maxLines: number = GIT_LOG_SINCE_MAX_LINES,
): string[] {
  if (maxLines <= 0) return [];
  try {
    let sinceRef = '';
    try {
      sinceRef = git(repoRoot, ['log', 'master', '--merges', '-1', '--format=%H']);
    } catch {
      // no merge commits reachable — fall through to the fixed lookback below
    }
    const range = sinceRef ? `${sinceRef}..master` : 'master';
    const out = git(repoRoot, ['log', range, '--oneline', '--no-merges', '-n', String(maxLines)]);
    if (!out) return [];
    return out.split('\n').map(l => l.trim()).filter(Boolean).slice(0, maxLines);
  } catch {
    return [];
  }
}

/**
 * The ledger events nearest in time to a failing item's own most recent event — any item,
 * not just its own trail, so a repair worker sees what ELSE was happening on the plane
 * around the failure (a shared-file build finishing, another item merging). Stripped to
 * ts/type/item (no data blobs) to stay small; bounded to `LEDGER_CONTEXT_MAX_ENTRIES`
 * regardless of how busy the window was. Pure — `allEvents` is assumed pre-loaded and
 * chronologically ordered (the ledger reader's contract); no I/O here.
 */
export function getLedgerContext(
  allEvents: LedgerEvent[],
  itemId: string,
  windowMinutes: number = LEDGER_CONTEXT_WINDOW_MINUTES,
): DoctorLedgerContextEntry[] {
  if (windowMinutes <= 0 || allEvents.length === 0) return [];

  let anchor: LedgerEvent | undefined;
  for (let i = allEvents.length - 1; i >= 0; i--) {
    if (allEvents[i]!.item === itemId) { anchor = allEvents[i]; break; }
  }
  if (!anchor) return [];
  const anchorMs = new Date(anchor.ts).getTime();
  if (isNaN(anchorMs)) return [];

  const windowMs = windowMinutes * 60_000;
  const inWindow = allEvents.filter(e => {
    const ms = new Date(e.ts).getTime();
    return !isNaN(ms) && Math.abs(ms - anchorMs) <= windowMs;
  });

  const anchorIdx = inWindow.indexOf(anchor);
  const half = Math.floor(LEDGER_CONTEXT_MAX_ENTRIES / 2);
  const start = Math.max(0, anchorIdx - half);
  const end = Math.min(inWindow.length, start + LEDGER_CONTEXT_MAX_ENTRIES);

  return inWindow.slice(start, end).map(e => ({ ts: e.ts, type: e.type, item: e.item }));
}

/**
 * Attach gitLogSince + surroundingEvents to a build.crashed/build.stalled event's data.
 * A no-op passthrough for any other event type — the terminal-state guard falls out
 * for free here since the doctor only ever produces these two types via its reap path
 * (never on an already-terminal merge/reject/done item).
 */
export function enrichCrashOrStallEvent(
  event: LedgerEvent,
  repoRoot: string,
  allEvents: LedgerEvent[],
): LedgerEvent {
  if (event.type !== 'build.crashed' && event.type !== 'build.stalled') return event;

  const gitLogSince = getGitLogSinceLastMerge(repoRoot);
  const surroundingEvents = getLedgerContext(allEvents, event.item);
  if (gitLogSince.length === 0 && surroundingEvents.length === 0) return event;

  return {
    ...event,
    data: {
      ...(event.data as Record<string, unknown>),
      ...(gitLogSince.length > 0 ? { gitLogSince } : {}),
      ...(surroundingEvents.length > 0 ? { surroundingEvents } : {}),
    } as LedgerEvent['data'],
  };
}
