/**
 * calibration.ts — tier calibration (self-tuning acceptance windows).
 *
 * The base config ships four attention tiers with FIXED auto-accept windows (auto=2h,
 * optional=48h, review=168h; 'must' never auto-accepts). This module makes the
 * 'optional' and 'review' windows self-tune from the operator's actual verdicts,
 * so the operator is bothered less over time without ever mutating loopkit.config.json:
 *
 *   - DEMOTE (bother less): a tier the operator keeps cleanly accepting with no
 *     problems reported → SHRINK its window (accept sooner, surface less).
 *   - PROMOTE (bother more, safety valve): a tier that gets a problem report →
 *     GROW its window (more review time before the next auto-accept).
 *
 * Event-sourced (one home for this state): every change is a `tier.recalibrated` event;
 * the effective window for a tier = the latest `tier.recalibrated.windowHours`
 * for that tier, else the config default. This module is pure and deterministic
 * — no I/O, no clock reads; the reactor step (beats/reactor.ts) supplies events
 * and config and does the appending.
 */

import { LedgerEvent } from './schema.js';

export type TunedTier = 'optional' | 'review';

export interface TierCalibrationConfig {
  enabled: boolean;
  /** Consecutive clean accepts (no problems) since the watermark that trigger a shrink. */
  demoteAfterCleanAccepts: number;
  /** Window *= this on demote (e.g. 0.5). */
  demoteFactor: number;
  /** Window *= this on promote (e.g. 2.0). */
  promoteFactor: number;
  /** Minimum window, in hours. */
  windowFloorHours: number;
  /** Maximum window, in hours. */
  windowCeilingHours: number;
}

export interface TierStats {
  cleanAccepts: number;
  problems: number;
}

/**
 * Decide whether a tier's window should change, given its current window and the
 * verdict stats accumulated since the last recalibration (or ever, if never tuned).
 *
 * Precedence: PROMOTE (any problem reported) beats DEMOTE (clean-accept streak) —
 * a single problem report is the safety valve and always wins over a clean streak
 * accumulated before it. Returns null when disabled or when nothing changes.
 */
export function decideTierWindow(
  currentWindowHours: number,
  stats: TierStats,
  cfg: TierCalibrationConfig,
): { newWindowHours: number; reason: string } | null {
  if (!cfg.enabled) return null;

  if (stats.problems > 0) {
    const grown = Math.min(cfg.windowCeilingHours, Math.round(currentWindowHours * cfg.promoteFactor));
    if (grown === currentWindowHours) return null;
    return {
      newWindowHours: grown,
      reason: `${stats.problems} problem(s) reported — lengthening the window to ${grown}h`,
    };
  }

  if (stats.cleanAccepts >= cfg.demoteAfterCleanAccepts) {
    const shrunk = Math.max(cfg.windowFloorHours, Math.round(currentWindowHours * cfg.demoteFactor));
    if (shrunk === currentWindowHours) return null;
    return {
      newWindowHours: shrunk,
      reason: `${stats.cleanAccepts} clean accepts, 0 problems — shortening the window to ${shrunk}h`,
    };
  }

  return null;
}

export interface EffectiveWindows {
  optional: number;
  review: number;
}

/**
 * Compute the effective auto-accept window for each tuned tier from the raw event
 * list: the latest `tier.recalibrated` for a tier wins; absent → the supplied default.
 * Also returns each tier's watermark (ts of its latest recalibration, or '' if never
 * tuned) — the point after which new verdicts count toward the NEXT decision.
 */
export function effectiveTierWindows(
  events: LedgerEvent[],
  defaults: { optional: number; review: number },
): { windows: EffectiveWindows; watermark: Record<TunedTier, string> } {
  const windows: EffectiveWindows = { optional: defaults.optional, review: defaults.review };
  const watermark: Record<TunedTier, string> = { optional: '', review: '' };

  for (const ev of events) {
    if (ev.type !== 'tier.recalibrated') continue;
    const data = ev.data as { tier?: string; windowHours?: number };
    const tier = data.tier;
    if (tier !== 'optional' && tier !== 'review') continue;
    if (ev.ts > watermark[tier]) {
      watermark[tier] = ev.ts;
      if (typeof data.windowHours === 'number' && Number.isFinite(data.windowHours)) {
        windows[tier] = data.windowHours;
      }
    }
  }

  return { windows, watermark };
}

const PROBLEM_RE = /^Problem with (WI-\d+)/i;

/**
 * Count clean operator-accepts and problem-reports per tuned tier, since each tier's
 * watermark (exclusive — events at/before the watermark don't count, they already
 * informed the last decision).
 *
 * - `item.accepted` with `data.by === 'operator'` (loopctl's `accept` verb — a reactor
 *   auto-accept has `by: 'reactor:tier-<tier>'` and must NOT be counted here) attributes
 *   a clean accept to the accepted item's tier.
 * - `item.captured` whose `data.text` matches `/^Problem with (WI-\d+)/i` (the
 *   ops-console "Found a problem" button's prefilled text) attributes a problem to the
 *   REFERENCED item's tier (`classifyTier` resolves WI-NNN → tier).
 *
 * `classifyTier` is supplied by the caller, closing over the fold's item records and
 * the acceptance-tier classifier config — this module stays pure and has no fold/config
 * dependency of its own.
 */
export function tallyVerdictsSince(
  events: LedgerEvent[],
  watermark: Record<TunedTier, string>,
  classifyTier: (itemId: string) => string | undefined,
): Record<TunedTier, TierStats> {
  const stats: Record<TunedTier, TierStats> = {
    optional: { cleanAccepts: 0, problems: 0 },
    review: { cleanAccepts: 0, problems: 0 },
  };

  for (const ev of events) {
    if (ev.type === 'item.accepted') {
      const data = ev.data as { by?: string };
      if (data.by !== 'operator') continue;
      const tier = classifyTier(ev.item);
      if (tier !== 'optional' && tier !== 'review') continue;
      if (ev.ts <= watermark[tier]) continue;
      stats[tier].cleanAccepts++;
      continue;
    }

    if (ev.type === 'item.captured') {
      const data = ev.data as { text?: string };
      const m = PROBLEM_RE.exec(data.text ?? '');
      if (!m) continue;
      const refId = m[1]!;
      const tier = classifyTier(refId);
      if (tier !== 'optional' && tier !== 'review') continue;
      if (ev.ts <= watermark[tier]) continue;
      stats[tier].problems++;
    }
  }

  return stats;
}
