// Minimal server-render helpers. Components are typed TS functions that return
// HTML strings (no React/bundler). All interpolated text must pass
// through `esc` — components never emit unescaped caller data.

/** HTML-escape text for safe interpolation into element content or attributes. */
export function esc(value: string | number): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Join truthy class names into a single attribute value. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((p): p is string => Boolean(p)).join(' ');
}

/** Local-time display formatter (local, not UTC). The console is server-rendered on the
 *  operator's own machine, so the server timezone IS the operator's. */
export function formatLocal(iso: string | Date, opts: { seconds?: boolean } = {}): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return opts.seconds ? `${base}:${p(d.getSeconds())}` : base;
}

const D_REF_RE = /\bD-(\d+)\b/g;

/** Escape free text and linkify every `D-NNN` mention to the app's decision anchor.
 *  The package never knows the app's routes, so the boundary supplies `drefBaseHref` — a
 *  base URL each anchor id (`d-nnn`, lowercase) is appended to (e.g. `/company#`). When no
 *  base is configured the mentions render as plain escaped text (never a hardcoded/dead
 *  link). Escapes first, then re-inserts trusted anchor markup — never interpolates caller
 *  text unescaped. */
export function linkifyDecisionRefs(
  text: string,
  opts: { drefBaseHref?: string | undefined } = {},
): string {
  const escaped = esc(text);
  const base = opts.drefBaseHref;
  if (!base) return escaped;
  return escaped.replace(D_REF_RE, (match, n: string) => {
    const anchor = `d-${n}`;
    return `<a class="opsui-dref" href="${esc(base)}${anchor}">${match}</a>`;
  });
}
