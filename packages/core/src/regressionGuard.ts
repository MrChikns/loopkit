/**
 * regressionGuard.ts — halt a beat before it acts on a TRUNCATED
 * ledger, instead of silently folding a shorter-but-consistent history.
 *
 * Composes the pure comparison in doctor.ts (detectLedgerRegression) with the filesystem
 * watermark (.ai/runs/loopkit/doctor-maxids.json, same pattern as hygiene.ts's lastbeat.json)
 * and the existing notify-phone escalation path (mirrors reactor.ts's stepNotifyDecisionParks).
 * Both beats call this as their very first action after acquiring their lock — a regression
 * halts the ENTIRE beat (no step runs against the truncated fold), which is what prevents
 * the doctor from re-dispatching already-merged work items after a ledger is truncated or
 * wiped out from under a running plane.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readLedgerMaxIds } from './ledger.js';
import { detectLedgerRegression, LedgerMaxIds } from './doctor.js';

const WATERMARK_FILE = 'doctor-maxids.json';
const NOTIFIED_FLAG_PREFIX = 'ledger-regression-notified-';

function readWatermarks(runDir: string): LedgerMaxIds {
  try {
    const parsed = JSON.parse(readFileSync(join(runDir, WATERMARK_FILE), 'utf8'));
    return (parsed && typeof parsed === 'object') ? parsed as LedgerMaxIds : {};
  } catch {
    return {};
  }
}

function writeWatermarks(runDir: string, maxIds: LedgerMaxIds): void {
  try {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, WATERMARK_FILE), JSON.stringify(maxIds, null, 2), 'utf8');
  } catch { /* best-effort — a lost watermark just re-baselines next beat, never blocks */ }
}

export interface RegressionGuardOptions {
  repoRoot: string;
  ledgerDir: string;
  /** `.ai/runs/loopkit` — where the watermark + notified-dedup flags live. */
  runDir: string;
  /** Which beat is checking, for the notify message and detail text. */
  loop: 'reactor' | 'dispatch';
  /** cfg.notifyHook, relative to repoRoot (e.g. `.ai/notify-phone.sh`). */
  notifyHook?: string;
  /** Injected notify for tests — same contract as ReactorOptions.notify:
   *  return `false` to simulate a total-transport failure, void/true for delivered. */
  notify?: (message: string) => void | boolean;
  /** Injected for tests — real default reads ledgerDir via ledger.ts. */
  readMaxIds?: (ledgerDir: string) => Promise<LedgerMaxIds>;
}

export interface RegressionGuardResult {
  halted: boolean;
  detail: string;
}

/**
 * Real notify-phone call, mirroring reactor.ts's stepNotifyDecisionParks default: exit 0 =
 * delivered, anything else (missing hook, non-zero exit, thrown) = not delivered.
 */
function realNotify(repoRoot: string, notifyHook: string | undefined, message: string): boolean {
  if (!notifyHook) return false;
  const hookPath = join(repoRoot, notifyHook);
  if (!existsSync(hookPath)) return false;
  try {
    const r = spawnSync(hookPath, [message], { stdio: 'pipe', timeout: 10_000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

export async function checkLedgerRegressionGuard(
  opts: RegressionGuardOptions,
): Promise<RegressionGuardResult> {
  try {
    const readMaxIds = opts.readMaxIds ?? readLedgerMaxIds;
    const current = await readMaxIds(opts.ledgerDir);
    const prior = readWatermarks(opts.runDir);
    const { regressed, regressions, nextWatermarks } = detectLedgerRegression(current, prior);

    if (!regressed) {
      writeWatermarks(opts.runDir, nextWatermarks);
      return { halted: false, detail: 'no ledger regression' };
    }

    const detailList = regressions
      .map(r => `${r.file}: watermark ${r.watermark} > current ${r.current ?? '(file missing)'}`)
      .join('; ');
    const detail = `LEDGER REGRESSION detected — halting ${opts.loop}: ${detailList}`;

    // Dedup on the regression's own signature (not a per-beat timestamp) so a standing
    // truncation pages once, not every 30s/60s beat, while a NEW/worse regression re-pages.
    const sig = createHash('sha1').update(detailList).digest('hex').slice(0, 16);
    const flagPath = join(opts.runDir, `${NOTIFIED_FLAG_PREFIX}${sig}`);
    if (!existsSync(flagPath)) {
      const notifyFn = opts.notify ?? ((msg: string) => realNotify(opts.repoRoot, opts.notifyHook, msg));
      const delivered = notifyFn(
        `loopkit ops: ledger regression HALTED the plane (${opts.loop}) — ${detailList.slice(0, 400)}`,
      ) !== false;
      if (delivered) {
        try { mkdirSync(opts.runDir, { recursive: true }); writeFileSync(flagPath, '', 'utf8'); } catch { /* best-effort */ }
      }
    }

    // Persist watermarks even while halted: files that DIDN'T regress still advance so a
    // later legitimate append on those files isn't misread as a fresh regression; the
    // regressed file itself holds at its prior (higher) watermark until it recovers past it.
    writeWatermarks(opts.runDir, nextWatermarks);

    return { halted: true, detail };
  } catch (e) {
    // Fail-open: a broken regression check must never itself stall the plane.
    return { halted: false, detail: `ledger regression check failed (fail-open): ${e}` };
  }
}
