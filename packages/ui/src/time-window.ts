// time-window.ts — the ONE server-side time-window model behind every zero-JS
// `?window=`-style filter (WindowPicker chips + view-side scoping). A window arrives as a
// query-param string; this module owns parsing and labelling so no view ever grows a second
// parser: curated presets AND arbitrary `Nm`/`Nh`/`Nd` durations (`?window=45m` typed straight
// into the URL) parse here, garbage falls back to the caller's default instead of throwing,
// and `all` means unbounded (ms: null). Chips stay the curated presets — custom durations are
// URL-only, no date-picker UI.

export interface TimeWindowSpec {
  /** Canonical key, echoed into hrefs (`?window=<key>`): `all` or `<N><m|h|d>`. */
  key: string;
  /** Window length in milliseconds; null means all-time (no cutoff). */
  ms: number | null;
  /** Human interval label for captions: "last 24h" / "last 45m" / "all-time". */
  label: string;
}

/** Chip preset for spend/token/throughput widgets that follow a page-level picker. */
export const FOLLOW_WINDOW_OPTIONS: readonly string[] = ['24h', '7d', '30d', 'all'];

/** Chip preset for fast-moving widgets whose collectors bucket at 5m/1h granularity. */
export const FAST_WINDOW_OPTIONS: readonly string[] = ['5m', '1h', '24h'];

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `Nm`/`Nh`/`Nd` with N ≥ 1 — no zero-length or negative windows, no other units. */
const DURATION_RE = /^([1-9]\d{0,4})([mhd])$/;

function tryParse(raw: string): TimeWindowSpec | undefined {
  if (raw === 'all') return { key: 'all', ms: null, label: 'all-time' };
  const m = DURATION_RE.exec(raw);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unitMs = UNIT_MS[m[2] as string];
  if (unitMs === undefined) return undefined;
  return { key: raw, ms: n * unitMs, label: `last ${raw}` };
}

/**
 * Parse a window query-param value. Unparseable input (absent, empty, `0m`, `-5h`, `5w`,
 * free text) resolves to `fallback` — a filter control must never 500 a read-only page.
 * `fallback` itself must be a valid window key; an invalid fallback resolves to `24h` as the
 * last-resort default rather than recursing.
 */
export function parseTimeWindow(raw: string | null | undefined, fallback: string): TimeWindowSpec {
  if (typeof raw === 'string') {
    const parsed = tryParse(raw);
    if (parsed) return parsed;
  }
  return tryParse(fallback) ?? { key: '24h', ms: 24 * 3_600_000, label: 'last 24h' };
}

/** The cutoff timestamp (ms since epoch) for a window, or null for all-time. */
export function windowCutoffMs(spec: TimeWindowSpec, nowMs: number): number | null {
  return spec.ms === null ? null : nowMs - spec.ms;
}
