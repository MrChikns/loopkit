/**
 * session.ts — attended-session verbs over the claim-lease kernel.
 *
 * An operator SESSION claims queued items so the away beats defer to it while the lease is
 * active (fold.ts isClaimActive — the ONE predicate). Everything here is a ledger-write verb
 * in the exact conventions of verbs.ts: typed options, `VerbError` on usage problems (never
 * process.exit — the console's HTTP path shares these), and every append under `withLock`.
 * Nothing is ever mutated to release a lease — expiry/dead-man is computed at read time.
 *
 * The "current session" pointer (which session this terminal is driving) is runtime state,
 * not ledger truth — it lives as a small file in the run dir beside the other run-state
 * (watermarks, locks), and the ledger stays the one source of session lifecycle truth.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withLock } from './ledger.js';
import { fold, isClaimActive, FoldResult, ItemRecord } from './fold.js';
import { makeEvent, DEFAULT_CLAIM_TTL_MINUTES } from './schema.js';
import { VerbError } from './verbs.js';

// ---------------------------------------------------------------------------
// Session identity
// ---------------------------------------------------------------------------

/** Lowercase RFC-4648 base32 alphabet (same shape discipline as target ids). */
const SESSION_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** Shape every session id conforms to: `ses-` + 8 lowercase base32 chars. */
export const SESSION_ID_RE = /^ses-[a-z2-7]{8}$/;

/** Mint a fresh opaque session id (`ses-<8 lowercase base32 chars>`), cryptographically random. */
export function mintSessionId(): string {
  const bytes = randomBytes(5);
  let n = 0n;
  for (let i = 0; i < 5; i++) n = (n << 8n) | BigInt(bytes[i] ?? 0);
  let s = '';
  for (let i = 0; i < 8; i++) {
    s = SESSION_ID_ALPHABET[Number(n & 31n)] + s;
    n >>= 5n;
  }
  return 'ses-' + s;
}

// ---------------------------------------------------------------------------
// Current-session pointer (run-state, not ledger truth)
// ---------------------------------------------------------------------------

/** Path of the current-session pointer file inside a run dir. */
export function currentSessionPath(runDir: string): string {
  return join(runDir, 'session.current');
}

/** Read the current-session pointer; undefined when absent/invalid. */
export function readCurrentSession(runDir: string): string | undefined {
  try {
    const raw = readFileSync(currentSessionPath(runDir), 'utf8').trim();
    return SESSION_ID_RE.test(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Persist the current-session pointer (best-effort mkdir of the run dir). */
export function writeCurrentSession(runDir: string, sessionId: string): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(currentSessionPath(runDir), sessionId + '\n', 'utf8');
}

/** Drop the current-session pointer (on session end). Best-effort. */
export function clearCurrentSession(runDir: string): void {
  try { rmSync(currentSessionPath(runDir), { force: true }); } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// startSession / heartbeatSession / endSession
// ---------------------------------------------------------------------------

export interface StartSessionOptions {
  /** Capture origin; mirrors captureIntent's source. Defaults to 'cli'. */
  source?: string;
  /** Explicit session id (tests); default: freshly minted. */
  sessionId?: string;
}

export interface StartSessionResult { sessionId: string }

/** Append `session.started`. The event is addressed by the sessionId (a global handle). */
export async function startSession(
  ledgerDir: string,
  opts: StartSessionOptions = {},
): Promise<StartSessionResult> {
  const sessionId = opts.sessionId ?? mintSessionId();
  if (!SESSION_ID_RE.test(sessionId)) throw new VerbError(`Invalid session id: ${sessionId}`);
  const source = opts.source ?? 'cli';
  return withLock(ledgerDir, async (tx) => {
    await tx.append([makeEvent('cli', sessionId, 'session.started', { sessionId, source })]);
    return { sessionId };
  });
}

/** Append `session.heartbeat` — the dead-man liveness pulse. */
export async function heartbeatSession(ledgerDir: string, sessionId: string): Promise<void> {
  if (!SESSION_ID_RE.test(sessionId)) throw new VerbError(`Invalid session id: ${sessionId}`);
  await withLock(ledgerDir, async (tx) => {
    await tx.append([makeEvent('cli', sessionId, 'session.heartbeat', { sessionId })]);
  });
}

export interface EndSessionResult {
  sessionId: string;
  /** Items whose claims this end released (same locked append as session.ended). */
  released: string[];
}

/**
 * Append `session.ended`, releasing ALL of the session's live claims in the SAME locked
 * append — a session end never strands a lease for the dead-man timer to collect.
 */
export async function endSession(ledgerDir: string, sessionId: string): Promise<EndSessionResult> {
  if (!SESSION_ID_RE.test(sessionId)) throw new VerbError(`Invalid session id: ${sessionId}`);
  return withLock(ledgerDir, async (tx) => {
    const allEvents = await tx.loadAll();
    const result = fold(allEvents);
    const released: string[] = [];
    const events = [];
    for (const rec of result.items.values()) {
      if (rec.claim?.sessionId === sessionId) {
        released.push(rec.id);
        events.push(makeEvent('cli', rec.id, 'item.released', { reason: `session ${sessionId} ended` }));
      }
    }
    events.push(makeEvent('cli', sessionId, 'session.ended', { sessionId }));
    await tx.append(events);
    return { sessionId, released };
  });
}

// ---------------------------------------------------------------------------
// claimItems / releaseItems
// ---------------------------------------------------------------------------

export interface ClaimItemsOptions {
  sessionId: string;
  /** Explicit item ids to claim. Mutually exclusive with allQueued. */
  ids?: string[];
  /** Claim every queued item not actively claimed by another session. */
  allQueued?: boolean;
  /** Lease length; default DEFAULT_CLAIM_TTL_MINUTES. */
  ttlMinutes?: number;
  /** Injected clock for lease-activity checks (tests). Default Date.now(). */
  nowMs?: number;
}

export interface ClaimSkip { id: string; reason: string }

export interface ClaimItemsResult {
  sessionId: string;
  claimed: string[];
  skipped: ClaimSkip[];
}

/**
 * Append `item.claimed` for queued items. Explicit ids must exist (VerbError otherwise);
 * a non-queued item or one actively claimed by ANOTHER session is skipped with a reason.
 * A re-claim by the SAME session renews the lease (latest item.claimed wins in the fold).
 * The claiming session must exist and not be ended.
 */
export async function claimItems(ledgerDir: string, opts: ClaimItemsOptions): Promise<ClaimItemsResult> {
  const { sessionId } = opts;
  if (!SESSION_ID_RE.test(sessionId)) throw new VerbError(`Invalid session id: ${sessionId}`);
  if (!opts.allQueued && (!opts.ids || opts.ids.length === 0)) {
    throw new VerbError('pass item ids or allQueued');
  }
  const ttlMinutes = opts.ttlMinutes ?? DEFAULT_CLAIM_TTL_MINUTES;
  if (!(ttlMinutes > 0)) throw new VerbError('ttlMinutes must be positive');
  const nowMs = opts.nowMs ?? Date.now();

  return withLock(ledgerDir, async (tx) => {
    const allEvents = await tx.loadAll();
    const result = fold(allEvents);
    const ses = result.sessions.get(sessionId);
    if (!ses) throw new VerbError(`Unknown session ${sessionId} — run \`session start\` first`);
    if (ses.endedAt !== undefined) throw new VerbError(`Session ${sessionId} already ended`);

    const candidates: ItemRecord[] = [];
    const skipped: ClaimSkip[] = [];
    if (opts.allQueued) {
      for (const rec of result.items.values()) {
        if (rec.state === 'queued') candidates.push(rec);
      }
      candidates.sort((a, b) => a.id.localeCompare(b.id));
    } else {
      for (const rawId of opts.ids!) {
        const rec = result.items.get(rawId);
        if (!rec) throw new VerbError(`No such item: ${rawId}`);
        candidates.push(rec);
      }
    }

    const claimed: string[] = [];
    const events = [];
    for (const rec of candidates) {
      if (rec.state !== 'queued') {
        skipped.push({ id: rec.id, reason: `not queued (state: ${rec.state})` });
        continue;
      }
      const activeClaim = isClaimActive(rec, result.sessions, nowMs) ? rec.claim : undefined;
      if (activeClaim && activeClaim.sessionId !== sessionId) {
        skipped.push({ id: rec.id, reason: `claimed by ${activeClaim.sessionId}` });
        continue;
      }
      // Unclaimed, expired, or our own (renewal) — claim/renew the lease.
      events.push(makeEvent('cli', rec.id, 'item.claimed', { sessionId, ttlMinutes }));
      claimed.push(rec.id);
    }
    if (events.length > 0) await tx.append(events);
    return { sessionId, claimed, skipped };
  });
}

export interface ReleaseItemsOptions {
  ids: string[];
  reason?: string;
}

export interface ReleaseItemsResult {
  released: string[];
  skipped: ClaimSkip[];
}

/** Append `item.released` for each claimed item; unclaimed items are skipped (no-op). */
export async function releaseItems(ledgerDir: string, opts: ReleaseItemsOptions): Promise<ReleaseItemsResult> {
  if (!opts.ids || opts.ids.length === 0) throw new VerbError('pass item ids to release');
  return withLock(ledgerDir, async (tx) => {
    const allEvents = await tx.loadAll();
    const result = fold(allEvents);
    const released: string[] = [];
    const skipped: ClaimSkip[] = [];
    const events = [];
    for (const rawId of opts.ids) {
      const rec = result.items.get(rawId);
      if (!rec) throw new VerbError(`No such item: ${rawId}`);
      if (!rec.claim) {
        skipped.push({ id: rec.id, reason: 'not claimed' });
        continue;
      }
      events.push(makeEvent('cli', rec.id, 'item.released', {
        ...(opts.reason ? { reason: opts.reason } : {}),
      }));
      released.push(rec.id);
    }
    if (events.length > 0) await tx.append(events);
    return { released, skipped };
  });
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/** The session's ACTIVE claims on still-queued items (the conductor's work list). */
export function activeSessionClaims(
  result: FoldResult,
  sessionId: string,
  nowMs: number,
): ItemRecord[] {
  const out: ItemRecord[] = [];
  for (const rec of result.items.values()) {
    if (rec.state !== 'queued') continue;
    if (rec.claim?.sessionId !== sessionId) continue;
    if (!isClaimActive(rec, result.sessions, nowMs)) continue;
    out.push(rec);
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}
