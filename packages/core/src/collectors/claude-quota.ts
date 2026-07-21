/**
 * collectors/claude-quota.ts — folds statusline.py's throttled quota drop file into
 * `quota.snapshot{provider:'claude'}` events.
 *
 * statusline.py runs on every render of the Claude Code status bar (many times a minute)
 * and already reads `rate_limits.five_hour` / `rate_limits.seven_day` off the hook's stdin
 * JSON to build the bar text. It throttles (see statusline.py) and appends one JSONL line
 * per write to `.ai/runs/loopkit/claude-quota.jsonl`:
 *
 *   {"ts": "...", "provider": "claude", "planType": "...", "windows": [
 *     {"window": "five_hour", "usedPct": 12.3, "resetsAt": "..."},
 *     {"window": "seven_day", "usedPct": 45.6}
 *   ]}
 *
 * This collector is the read side: byte-offset watermark over that single small file,
 * same incremental-read shape as codex-usage.ts's per-file reader. Fail-soft — a missing
 * drop file (no session has run since this shipped, or a non-primary host) just no-ops.
 */

import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { LedgerEvent, makeEvent } from '../schema.js';

const MAX_READ_BYTES = 2 * 1_048_576;

interface DropWindow {
  window?: string;
  usedPct?: number;
  resetsAt?: string;
}
interface DropLine {
  ts?: string;
  provider?: string;
  planType?: string;
  windows?: DropWindow[];
}

/** Parse one drop-file line into its quota.snapshot data points, or [] when malformed. */
export function parseClaudeQuotaLine(line: string): Array<{ window: string; usedPct: number; ts: string; resetsAt?: string; planType?: string }> {
  if (!line.trim()) return [];
  let entry: DropLine;
  try {
    entry = JSON.parse(line) as DropLine;
  } catch {
    return [];
  }
  const ts = entry.ts;
  if (typeof ts !== 'string' || isNaN(Date.parse(ts)) || !Array.isArray(entry.windows)) return [];
  const out: Array<{ window: string; usedPct: number; ts: string; resetsAt?: string; planType?: string }> = [];
  for (const w of entry.windows) {
    if (typeof w?.window !== 'string' || typeof w?.usedPct !== 'number' || !Number.isFinite(w.usedPct)) continue;
    out.push({
      window: w.window,
      usedPct: w.usedPct,
      ts,
      ...(typeof w.resetsAt === 'string' ? { resetsAt: w.resetsAt } : {}),
      ...(typeof entry.planType === 'string' ? { planType: entry.planType } : {}),
    });
  }
  return out;
}

interface Watermark { offset: number }

async function readWatermark(path: string): Promise<Watermark> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return parsed && typeof parsed === 'object' && typeof parsed.offset === 'number' ? parsed as Watermark : { offset: 0 };
  } catch {
    return { offset: 0 };
  }
}

async function writeWatermark(path: string, wm: Watermark): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(wm), 'utf8');
  } catch {
    // Best-effort — a lost watermark just re-scans from 0 next run (dedup by ts is not
    // required since duplicate quota.snapshot points are harmless point-in-time readings).
  }
}

export interface CollectClaudeQuotaOptions {
  /** Path to the statusline.py drop file. */
  dropFilePath: string;
  /** Where the byte-offset watermark persists. */
  watermarkPath: string;
}

export interface CollectClaudeQuotaResult {
  events: LedgerEvent[];
}

/** Read new lines from the statusline.py quota drop file since the last watermark and
 *  return the `quota.snapshot{provider:'claude'}` events to append. Pure I/O orchestration —
 *  does not touch the ledger itself. */
export async function collectClaudeQuota(opts: CollectClaudeQuotaOptions): Promise<CollectClaudeQuotaResult> {
  let size: number;
  try {
    size = (await stat(opts.dropFilePath)).size;
  } catch {
    return { events: [] };
  }

  const watermark = await readWatermark(opts.watermarkPath);
  if (size < watermark.offset) watermark.offset = 0; // rotated/truncated — restart
  if (size === watermark.offset) return { events: [] };

  const readLen = Math.min(size - watermark.offset, MAX_READ_BYTES);
  let text: string;
  try {
    const handle = await import('node:fs/promises').then((fs) => fs.open(opts.dropFilePath, 'r'));
    try {
      const buffer = Buffer.alloc(readLen);
      await handle.read(buffer, 0, readLen, watermark.offset);
      text = buffer.toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return { events: [] };
  }

  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline < 0) return { events: [] }; // no complete line yet
  const lines = text.slice(0, lastNewline).split('\n');
  const newOffset = watermark.offset + Buffer.byteLength(text.slice(0, lastNewline + 1), 'utf8');

  const events: LedgerEvent[] = [];
  for (const line of lines) {
    for (const point of parseClaudeQuotaLine(line)) {
      events.push(makeEvent('claude-quota-collector', 'claude', 'quota.snapshot', {
        provider: 'claude',
        window: point.window,
        usedPct: point.usedPct,
        source: 'statusline',
        ...(point.resetsAt !== undefined ? { resetsAt: point.resetsAt } : {}),
        ...(point.planType !== undefined ? { planType: point.planType } : {}),
      }, point.ts));
    }
  }

  await writeWatermark(opts.watermarkPath, { offset: newOffset });
  return { events };
}
