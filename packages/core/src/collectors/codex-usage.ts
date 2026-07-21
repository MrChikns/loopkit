/**
 * collectors/codex-usage.ts — folds Codex CLI session usage into `cost.usage{provider:'codex'}`
 * events. Parallel to interactive-usage.ts, which does the same for the operator's Claude Code
 * CLI sessions — this closes the matching gap for Codex consults, so the conserved consulting
 * lane's spend is visible in the ledger instead of going untracked.
 *
 * Source: `~/.codex/sessions/**\/rollout-*.jsonl` — the Codex CLI's own rollout transcripts
 * (date-bucketed directories, not project-name dirs like Claude's). Each file's first line is
 * a `session_meta` event carrying the session's `cwd`. Every `event_msg` line whose
 * `payload.type === 'token_count'` reports `info.last_token_usage` — THIS TURN's delta — plus,
 * when available, `rate_limits`. We deliberately read `last_token_usage`, not
 * `total_token_usage`: the latter is cumulative for the whole session, so summing it across
 * every token_count event in a session would multiply the real total many times over.
 *
 * loop classification: 'consult' when the session's cwd is inside this project (an automated
 * dispatch of Codex from within the framework's own consulting lane), else 'interactive-manual'
 * (the operator's own personal Codex CLI use, sharing the same subscription quota — since the
 * lane conserves that quota, both lanes need to be visible). Classified once per file from its
 * session_meta line and cached in the watermark so incremental runs don't re-read it.
 *
 * No usd field: Codex is metered against a subscription quota, not billed per call. The only
 * meaningful spend signal is `rate_limits.primary.used_percent` — a point-in-time reading, not
 * a per-call charge, so it must never be summed (see costs.ts's codexQuotaPercent, which takes
 * the latest reading only).
 *
 * Watermark: byte offset + cached loop tag per file, same durable-JSON pattern as
 * interactive-usage.ts (survives process restarts; a lost watermark just re-scans from 0).
 */

import { open, readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { LedgerEvent, makeEvent } from '../schema.js';

const DEFAULT_TIME_BUDGET_MS = 3_000;
const MAX_READ_BYTES = 8 * 1_048_576;
const META_READ_BYTES = 65_536;

export type CodexLoop = 'consult' | 'interactive-manual';

interface TokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

interface RolloutLine {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    cwd?: string;
    info?: { last_token_usage?: TokenUsage };
    rate_limits?: {
      primary?: { used_percent?: number; window_minutes?: number; resets_at?: number | string };
      plan_type?: string;
    };
  };
}

function finite(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/** The Codex rollout's own field name for its one active rate-limit window — carried through
 *  to the emitted quota.snapshot's `window` field (never a disconnected literal at the event
 *  call site) so a future `secondary` window doesn't silently get mislabeled 'primary'. */
const CODEX_PRIMARY_WINDOW_KEY = 'primary';

/** Codex's `resets_at` ships as Unix epoch SECONDS (a number), unlike Claude's statusline feed
 *  which already carries an ISO8601 string. Normalizes both shapes to ISO8601 so every
 *  downstream consumer can keep assuming a plain ISO string. */
function normalizeResetsAt(resetsAt: number | string | undefined): string | undefined {
  if (typeof resetsAt === 'number' && Number.isFinite(resetsAt)) {
    const iso = new Date(resetsAt * 1000).toISOString();
    return iso;
  }
  if (typeof resetsAt === 'string' && !isNaN(Date.parse(resetsAt))) return resetsAt;
  return undefined;
}

export interface ParsedCodexUsage {
  ts: string;
  tokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  quotaPercent?: number;
  /** The rate-limit window key this reading came from (today always CODEX_PRIMARY_WINDOW_KEY —
   *  Codex's `secondary` window is present but null on every plan seen so far). Present only
   *  alongside quotaPercent, so callers never fabricate a window for an absent reading. */
  window?: string;
  /** rate_limits.primary.window_minutes — window length in minutes (e.g. 10080 for 7 days). */
  windowMinutes?: number;
  /** rate_limits.primary.resets_at, normalized to ISO8601 (see normalizeResetsAt). */
  resetsAt?: string;
  /** rate_limits.plan_type — the Codex subscription plan tier. */
  planType?: string;
}

/** Parse one rollout line into a billable Codex turn, or null when it isn't a `token_count`
 *  event_msg with a usable `last_token_usage` delta. Pure, exported for unit tests. */
export function parseCodexTokenCount(line: string): ParsedCodexUsage | null {
  if (!line || !line.includes('"token_count"')) return null;
  let entry: RolloutLine;
  try {
    entry = JSON.parse(line) as RolloutLine;
  } catch {
    return null;
  }
  if (entry.type !== 'event_msg' || entry.payload?.type !== 'token_count') return null;
  const usage = entry.payload.info?.last_token_usage;
  const timestamp = Date.parse(entry.timestamp ?? '');
  if (!usage || !Number.isFinite(timestamp)) return null;
  const inputTokens = finite(usage.input_tokens);
  const cachedInputTokens = finite(usage.cached_input_tokens);
  const outputTokens = finite(usage.output_tokens);
  const reasoningTokens = finite(usage.reasoning_output_tokens);
  const quotaPercent = entry.payload.rate_limits?.primary?.used_percent;
  const windowMinutes = entry.payload.rate_limits?.primary?.window_minutes;
  const resetsAt = normalizeResetsAt(entry.payload.rate_limits?.primary?.resets_at);
  const planType = entry.payload.rate_limits?.plan_type;
  const hasQuotaPercent = typeof quotaPercent === 'number' && Number.isFinite(quotaPercent);
  return {
    ts: entry.timestamp!,
    tokens: inputTokens + cachedInputTokens + outputTokens + reasoningTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    ...(hasQuotaPercent ? { quotaPercent, window: CODEX_PRIMARY_WINDOW_KEY } : {}),
    ...(typeof windowMinutes === 'number' && Number.isFinite(windowMinutes) ? { windowMinutes } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(typeof planType === 'string' && planType ? { planType } : {}),
  };
}

/** Extract the session `cwd` from a rollout file's `session_meta` line (always the first
 *  line of the file). Returns undefined when the line is malformed or predates this field. */
export function parseSessionCwd(firstLine: string): string | undefined {
  try {
    const entry = JSON.parse(firstLine) as RolloutLine;
    if (entry.type !== 'session_meta') return undefined;
    return entry.payload?.cwd;
  } catch {
    return undefined;
  }
}

/** Classify a session's loop tag from its cwd — 'consult' when Codex was dispatched from
 *  inside this project (the framework's own consulting lane), else 'interactive-manual'. */
export function classifyLoop(cwd: string | undefined, projectFilter: string): CodexLoop {
  return cwd && cwd.includes(projectFilter) ? 'consult' : 'interactive-manual';
}

// ---------------------------------------------------------------------------
// Watermark (byte offset + cached loop classification per file)
// ---------------------------------------------------------------------------

interface FileWatermark { offset: number; loop?: CodexLoop }
type Watermark = Record<string, FileWatermark>;

async function readWatermark(path: string): Promise<Watermark> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Watermark : {};
  } catch {
    return {};
  }
}

async function writeWatermark(path: string, wm: Watermark): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(wm), 'utf8');
  } catch {
    // Best-effort — a lost watermark just re-scans from 0 next run (dedup still holds).
  }
}

// ---------------------------------------------------------------------------
// Transcript discovery — ~/.codex/sessions/**/rollout-*.jsonl (date-bucketed, no project dirs)
// ---------------------------------------------------------------------------

async function walkRollouts(root: string, deadline: number): Promise<string[]> {
  const paths: string[] = [];
  const pending = [root];
  while (pending.length && Date.now() < deadline) {
    const dir = pending.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) pending.push(p);
      else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) paths.push(p);
    }
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Incremental read (byte-accurate — never splits a UTF-8 char or a partial line)
// ---------------------------------------------------------------------------

async function readBytesFrom(
  path: string,
  fromOffset: number,
  maxLen: number,
  deadline: number,
): Promise<Buffer | null> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return null;
  }
  if (size <= fromOffset) return null;
  const readLen = Math.min(size - fromOffset, maxLen);
  let handle;
  try {
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(readLen);
    const remainingMs = Math.max(1, deadline - Date.now());
    await Promise.race([
      handle.read(buffer, 0, readLen, fromOffset),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('read timeout')), remainingMs)),
    ]);
    return buffer;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readNewLines(
  path: string,
  fromOffset: number,
  deadline: number,
): Promise<{ lines: string[]; newOffset: number }> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return { lines: [], newOffset: fromOffset };
  }
  if (size < fromOffset) return { lines: [], newOffset: 0 }; // rotated/truncated — restart
  if (size === fromOffset) return { lines: [], newOffset: fromOffset };

  const buffer = await readBytesFrom(path, fromOffset, MAX_READ_BYTES, deadline);
  if (!buffer) return { lines: [], newOffset: fromOffset };
  const lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline < 0) return { lines: [], newOffset: fromOffset }; // no complete line yet
  const text = buffer.subarray(0, lastNewline).toString('utf8');
  return { lines: text.split('\n'), newOffset: fromOffset + lastNewline + 1 };
}

async function resolveLoop(path: string, projectFilter: string, deadline: number): Promise<CodexLoop> {
  const buffer = await readBytesFrom(path, 0, META_READ_BYTES, deadline);
  if (!buffer) return 'interactive-manual';
  const firstLine = buffer.toString('utf8').split('\n')[0] ?? '';
  return classifyLoop(parseSessionCwd(firstLine), projectFilter);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface CollectCodexUsageOptions {
  homeDir?: string;
  /** Override for ~/.codex/sessions (tests). */
  codexSessionsDir?: string;
  /** Substring match against a session's cwd to classify it 'consult' vs 'interactive-manual'.
   *  Default '' (matches every cwd — everything classifies 'consult' until a fork sets its
   *  own checkout-name filter). */
  projectFilter?: string;
  /** Where the byte-offset + loop-classification watermark persists. */
  watermarkPath: string;
  timeBudgetMs?: number;
}

export interface CollectCodexUsageResult {
  events: LedgerEvent[];
  filesScanned: number;
}

/** Scan Codex CLI rollout transcripts for new `token_count` events since the last watermark
 *  and return the `cost.usage{provider:'codex'}` events to append. Pure I/O orchestration —
 *  does not touch the ledger itself, so callers control the append (and can no-op in tests). */
export async function collectCodexUsage(
  opts: CollectCodexUsageOptions,
): Promise<CollectCodexUsageResult> {
  const deadline = Date.now() + (opts.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
  const home = opts.homeDir ?? homedir();
  const root = opts.codexSessionsDir ?? join(home, '.codex', 'sessions');
  const projectFilter = opts.projectFilter ?? '';

  const [watermark, files] = await Promise.all([
    readWatermark(opts.watermarkPath),
    walkRollouts(root, deadline),
  ]);

  const events: LedgerEvent[] = [];
  let dirty = false;

  for (const file of files) {
    if (Date.now() >= deadline) break;
    const fileWm = watermark[file] ?? { offset: 0 };
    let loop = fileWm.loop;
    if (!loop) {
      loop = await resolveLoop(file, projectFilter, deadline);
      dirty = true;
    }
    const { lines, newOffset } = await readNewLines(file, fileWm.offset, deadline);
    if (newOffset !== fileWm.offset || fileWm.loop !== loop) {
      watermark[file] = { offset: newOffset, loop };
      dirty = true;
    }
    for (const line of lines) {
      const usage = parseCodexTokenCount(line);
      if (!usage) continue;
      events.push(makeEvent('codex-usage-collector', 'codex', 'cost.usage', {
        provider: 'codex',
        loop,
        tokens: usage.tokens,
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        ...(usage.quotaPercent !== undefined ? { quotaPercent: usage.quotaPercent } : {}),
      }, usage.ts));
      // Also record a quota.snapshot point so the unified quota panel can regress
      // capacity/runway from history — cost.usage.quotaPercent stays latest-only.
      // Carries window_minutes/resets_at/plan_type when the rollout's rate_limits
      // block reported them, so consumers derive a label ("7d window") instead of a
      // hardcoded one for the window key. `window` itself comes from the parsed usage
      // (CODEX_PRIMARY_WINDOW_KEY), not a literal at this call site.
      if (usage.quotaPercent !== undefined && usage.window !== undefined) {
        events.push(makeEvent('codex-usage-collector', 'codex', 'quota.snapshot', {
          provider: 'codex',
          window: usage.window,
          usedPct: usage.quotaPercent,
          source: 'codex-rollout',
          ...(usage.windowMinutes !== undefined ? { windowMinutes: usage.windowMinutes } : {}),
          ...(usage.resetsAt !== undefined ? { resetsAt: usage.resetsAt } : {}),
          ...(usage.planType !== undefined ? { planType: usage.planType } : {}),
        }, usage.ts));
      }
    }
  }

  if (dirty) await writeWatermark(opts.watermarkPath, watermark);

  return { events, filesScanned: files.length };
}
