/**
 * collectors/interactive-usage.ts — folds the operator's interactive Claude Code sessions
 * into `cost.usage{loop:'interactive'}` events.
 *
 * An observability spend view that only sums `cost.usage` events the loopkit beats emit
 * for their own headless `claude -p` calls (dispatch/scout/judge/reactor) misses the
 * operator's own interactive CLI sessions, which run outside loopkit entirely and are
 * typically most of the real spend. This collector closes that gap.
 *
 * Source: `~/.claude/projects/<repoRoot-with-dashes>/*.jsonl` transcripts — the same
 * session/weekly token-gauge source a consuming app's own UI would read — reused here,
 * not reparsed (one parser, append-only doctrine).
 *
 * Interactive vs headless dedup: every transcript line the CLI writes carries an
 * `entrypoint` field. Genuine interactive terminal usage is `entrypoint:"cli"`; every
 * loopkit-spawned run (reactor classifications, dispatch/scout/judge builds — whether it
 * lands in a work-item worktree's own project dir or shares the main repo's) is
 * `entrypoint:"sdk-cli"` (the `claude -p` SDK invocation loopkit's providers use).
 * Filtering on this field is what keeps this collector from double-counting
 * ledger-tracked spend — it is a more precise signal than pattern-matching worktree
 * directory names, and it covers both exclusion cases (isolated worktree sessions, and
 * beat spawns sharing the main repo's project dir) with a single check.
 *
 * Pricing: no per-token dollar figure exists in the raw transcript (that field is
 * synthesized by `--output-format json` for headless calls, not written to the session
 * log) — so cost is estimated from a static list-price table, tier-detected from the
 * model alias. This is metered against a subscription plan, not billed per-call, hence
 * the "API-equivalent" framing on the console.
 *
 * Watermark: a byte offset per transcript file, persisted to a small JSON file (durable —
 * survives process restarts, unlike an in-memory cursor). Each run reads only new bytes
 * since the last offset; a read is capped at MAX_READ_BYTES per file per run so one huge
 * backlog file can't blow the caller's time budget — it just catches up over multiple runs.
 */

import { open, readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { LedgerEvent, makeEvent } from '../schema.js';

const DEFAULT_TIME_BUDGET_MS = 3_000;
const MAX_READ_BYTES = 8 * 1_048_576;

// ---------------------------------------------------------------------------
// Pricing (approximate published list prices, USD per 1M tokens)
// ---------------------------------------------------------------------------

type PriceTier = { input: number; output: number; cacheRead: number; cacheWrite: number };

const PRICING: Record<'opus' | 'sonnet' | 'haiku', PriceTier> = {
  opus:   { input: 15, output: 75, cacheRead: 1.50, cacheWrite: 18.75 },
  sonnet: { input: 3,  output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  haiku:  { input: 1,  output: 5,  cacheRead: 0.10, cacheWrite: 1.25 },
};

/** Model alias -> pricing tier. Unrecognized aliases (e.g. a new "fable" model) fall back
 *  to the sonnet tier — the mid-point — rather than guessing a number with no basis. */
export function pricingTierFor(model: string): keyof typeof PRICING {
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('haiku')) return 'haiku';
  return 'sonnet';
}

export interface TranscriptUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

function finite(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/** USD estimate for one turn's usage, given its model. Each usage field is priced at its
 *  own tier — the Anthropic usage object's `input_tokens` already excludes cache-read and
 *  cache-creation tokens (they are reported as separate fields, not folded into it), so no
 *  subtraction between the fields is needed or correct. */
export function estimateUsd(model: string, usage: TranscriptUsage): number {
  const price = PRICING[pricingTierFor(model)];
  const input = finite(usage.input_tokens);
  const output = finite(usage.output_tokens);
  const cacheRead = finite(usage.cache_read_input_tokens);
  const cacheWrite = finite(usage.cache_creation_input_tokens);
  return (
    input * price.input +
    output * price.output +
    cacheRead * price.cacheRead +
    cacheWrite * price.cacheWrite
  ) / 1_000_000;
}

function totalTokens(usage: TranscriptUsage): number {
  return finite(usage.input_tokens) + finite(usage.output_tokens)
    + finite(usage.cache_read_input_tokens) + finite(usage.cache_creation_input_tokens);
}

// ---------------------------------------------------------------------------
// Transcript line parsing (pure)
// ---------------------------------------------------------------------------

interface TranscriptLine {
  type?: string;
  entrypoint?: string;
  requestId?: string;
  timestamp?: string;
  message?: { id?: string; model?: string; usage?: TranscriptUsage };
}

export interface ParsedTurn {
  /** Dedup key: message.id + requestId. */
  key: string;
  model: string;
  ts: string;
  tokens: number;
  usd: number;
}

/** Parse one raw transcript line into a billable interactive turn, or null when the line
 *  isn't an interactive assistant turn with usage — excludes headless (`sdk-cli`) runs,
 *  tool-result/meta lines, and malformed JSON. Pure, exported for unit tests. */
export function parseInteractiveTurn(line: string): ParsedTurn | null {
  if (!line || !line.includes('"usage"')) return null;
  let entry: TranscriptLine;
  try {
    entry = JSON.parse(line) as TranscriptLine;
  } catch {
    return null;
  }
  if (entry.type !== 'assistant') return null;
  if (entry.entrypoint !== 'cli') return null; // excludes every loopkit-spawned (sdk-cli) run
  const usage = entry.message?.usage;
  const model = entry.message?.model;
  const timestamp = Date.parse(entry.timestamp ?? '');
  if (!usage || !model || !Number.isFinite(timestamp)) return null;
  const requestKey = entry.requestId ?? '';
  const messageKey = entry.message?.id ?? '';
  if (!requestKey && !messageKey) return null;
  return {
    key: `${messageKey}:${requestKey}`,
    model,
    ts: entry.timestamp!,
    tokens: totalTokens(usage),
    usd: estimateUsd(model, usage),
  };
}

// ---------------------------------------------------------------------------
// Watermark (byte offset per transcript file — durable across restarts)
// ---------------------------------------------------------------------------

type Watermark = Record<string, number>;

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
// Transcript discovery
// ---------------------------------------------------------------------------

async function walkJsonl(root: string, deadline: number): Promise<string[]> {
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
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) paths.push(p);
    }
  }
  return paths;
}

/** Find every transcript under project dirs whose name contains `filter` (default
 *  '' — matches every project dir; a fork narrows this to its own checkout name to keep
 *  the scan off unrelated projects under ~/.claude/projects). */
async function findTranscripts(root: string, filter: string, deadline: number): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const paths: string[] = [];
  for (const entry of entries) {
    if (Date.now() >= deadline) break;
    if (!entry.isDirectory() || !entry.name.includes(filter)) continue;
    paths.push(...await walkJsonl(join(root, entry.name), deadline));
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Incremental read (byte-accurate — never splits a UTF-8 char or a partial line)
// ---------------------------------------------------------------------------

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

  const readLen = Math.min(size - fromOffset, MAX_READ_BYTES);
  let handle;
  try {
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(readLen);
    const remainingMs = Math.max(1, deadline - Date.now());
    await Promise.race([
      handle.read(buffer, 0, readLen, fromOffset),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('read timeout')), remainingMs)),
    ]);
    const lastNewline = buffer.lastIndexOf(0x0a);
    if (lastNewline < 0) return { lines: [], newOffset: fromOffset }; // no complete line yet
    const text = buffer.subarray(0, lastNewline).toString('utf8');
    return { lines: text.split('\n'), newOffset: fromOffset + lastNewline + 1 };
  } catch {
    return { lines: [], newOffset: fromOffset };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface CollectInteractiveUsageOptions {
  homeDir?: string;
  /** Override for ~/.claude/projects (tests). */
  claudeProjectsDir?: string;
  /** Substring project-dir filter. Default '' (matches every project dir). */
  projectFilter?: string;
  /** Where the byte-offset watermark persists. */
  watermarkPath: string;
  timeBudgetMs?: number;
}

export interface CollectInteractiveUsageResult {
  events: LedgerEvent[];
  filesScanned: number;
}

/** Scan operator-interactive transcripts for new usage since the last watermark and return
 *  the `cost.usage{loop:'interactive'}` events to append. Pure I/O orchestration — does not
 *  touch the ledger itself, so callers control the append (and can no-op in tests). */
export async function collectInteractiveUsage(
  opts: CollectInteractiveUsageOptions,
): Promise<CollectInteractiveUsageResult> {
  const deadline = Date.now() + (opts.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
  const home = opts.homeDir ?? homedir();
  const root = opts.claudeProjectsDir ?? join(home, '.claude', 'projects');
  const filter = opts.projectFilter ?? '';

  const [watermark, files] = await Promise.all([
    readWatermark(opts.watermarkPath),
    findTranscripts(root, filter, deadline),
  ]);

  const events: LedgerEvent[] = [];
  const seen = new Set<string>();
  let dirty = false;

  for (const file of files) {
    if (Date.now() >= deadline) break;
    const fromOffset = watermark[file] ?? 0;
    const { lines, newOffset } = await readNewLines(file, fromOffset, deadline);
    if (newOffset !== fromOffset) {
      watermark[file] = newOffset;
      dirty = true;
    }
    for (const line of lines) {
      const turn = parseInteractiveTurn(line);
      if (!turn || seen.has(turn.key)) continue;
      seen.add(turn.key);
      events.push(makeEvent('interactive-usage-collector', 'interactive', 'cost.usage', {
        provider: 'claude-cli',
        loop: 'interactive',
        tokens: turn.tokens,
        usd: turn.usd,
      }, turn.ts));
    }
  }

  if (dirty) await writeWatermark(opts.watermarkPath, watermark);

  return { events, filesScanned: files.length };
}
