/**
 * quota-pressure.ts — Degraded-mode projection over `quota.snapshot` events.
 *
 * Read-only: tells dispatch's spawn-decision gate whether the plane is in quota-pressure
 * degraded mode. `quota.snapshot` readings are point-in-time — never summed like
 * cost.usage's tokens/usd — so this looks at the LATEST reading per provider:window only.
 * A window reset (e.g. 200%→10%) is just a fresh latest reading, never a false trigger from
 * stale history.
 *
 * Fail-open: no snapshot events, unparseable events, or an absent/invalid threshold all
 * resolve to `degraded: false` — unknown quota state must never block dispatch.
 *
 * Pure function over events; no I/O.
 */

import { LedgerEvent } from './schema.js';

export interface QuotaBreach {
  provider: string;
  window: string;
  usedPct: number;
}

export interface QuotaPressureResult {
  degraded: boolean;
  /** provider:window pairs whose latest reading is at/above the threshold, sorted for stable output. */
  breaches: QuotaBreach[];
}

/**
 * Computes degraded-mode state from quota.snapshot history. Any window whose most recent
 * reading is >= thresholdPct trips degraded mode — one caller hitting its ceiling is enough
 * to pause new spawns, since a stuck window blocks that provider's dispatch builds regardless
 * of how much headroom other windows have.
 */
export function computeQuotaPressure(
  events: LedgerEvent[],
  thresholdPct: number | undefined,
): QuotaPressureResult {
  if (thresholdPct === undefined || !Number.isFinite(thresholdPct) || thresholdPct <= 0) {
    return { degraded: false, breaches: [] };
  }

  const latest = new Map<string, { provider: string; window: string; usedPct: number; ts: string }>();
  for (const ev of events) {
    if (ev.type !== 'quota.snapshot') continue;
    const d = ev.data as { provider?: unknown; window?: unknown; usedPct?: unknown };
    if (typeof d.provider !== 'string' || typeof d.window !== 'string'
      || typeof d.usedPct !== 'number' || !Number.isFinite(d.usedPct)) continue;
    const key = `${d.provider}:${d.window}`;
    const prior = latest.get(key);
    if (!prior || ev.ts > prior.ts) {
      latest.set(key, { provider: d.provider, window: d.window, usedPct: d.usedPct, ts: ev.ts });
    }
  }

  const breaches: QuotaBreach[] = [...latest.values()]
    .filter(v => v.usedPct >= thresholdPct)
    .map(v => ({ provider: v.provider, window: v.window, usedPct: v.usedPct }))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.window.localeCompare(b.window));

  return { degraded: breaches.length > 0, breaches };
}
