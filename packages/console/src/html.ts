/**
 * html.ts — the console's page shell, built on `@loopkit/ui`'s AppShell/NavigationRail/TopBar.
 * Every interactive TopBar affordance the design system marks with a `data-opsui-shell` hook
 * (search, drop-intent, theme) gets a working href/form fallback here, on the SAME markup the
 * client-JS layer (public/console-shell.js + friends) progressively enhances — the buttons
 * stay `display: none` (console.css) until that JS marks the document ready, at which point it
 * reveals them and hides the no-JS twins in turn. The shell-level CommandPalette and
 * IntentComposerModal render hidden for the same reason: they're inert markup without JS, and
 * the JS opens them via the identical `data-opsui-shell="palette-open"` / `"composer-open"`
 * hooks the TopBar buttons already carry.
 *
 * Every ledger-derived string (source text, spec, park reason, event data) is untrusted: it
 * originated as free text an operator or an agent typed. `esc` is the single escaping choke
 * point every view MUST route through before interpolating a string into markup.
 */

import { AppShell, Card, NavigationRail, TopBar, BottomNav, CommandPalette, IntentComposerModal, esc as uiEsc } from '@loopkit/ui';
import type { NavDestination, PaletteGroup } from '@loopkit/ui';

/** Escape a string for safe interpolation into HTML text or an attribute value. */
export function esc(s: unknown): string {
  if (s === undefined || s === null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export type NavId = 'command' | 'missions' | 'acceptance' | 'system' | 'analytics' | 'knowledge';

/** The one destination list the rail renders — letter-badge glyphs match the section initial,
 *  same convention as the reference console this reshell matches (single-char fallback glyph,
 *  NavigationRail icon slot). */
export const NAV_DESTINATIONS: (NavDestination & { id: NavId })[] = [
  {
    id: 'command',
    mobilePriority: 1,
    title: 'Command',
    purpose: 'Glance, act and drill without leaving the operating picture',
    href: '/command',
  },
  {
    id: 'missions',
    mobilePriority: 2,
    title: 'Missions',
    purpose: 'Active work items, live builds, queue, backlog and engine health in one board',
    href: '/missions',
  },
  {
    id: 'acceptance',
    mobilePriority: 3,
    title: 'Acceptance',
    purpose: 'Shipped slices awaiting your verdict',
    href: '/acceptance',
  },
  {
    id: 'system',
    mobilePriority: 4,
    title: 'System',
    purpose: 'SLO board, plane health and build artifacts for the pipeline itself',
    href: '/system',
  },
  {
    id: 'analytics',
    mobilePriority: 5,
    title: 'Analytics',
    purpose: 'Plane spend·judge·trajectory + throughput/capture/latency',
    href: '/analytics',
  },
  {
    id: 'knowledge',
    // Sixth destination: past the bottom bar's five-slot limit on purpose — BottomNav's
    // built-in More sheet picks it up, which is the scaling pattern for every future view.
    mobilePriority: 6,
    title: 'Knowledge',
    purpose: 'Operator-configured reference docs, one click from cited decisions',
    href: '/knowledge',
  },
];

const NAV_TITLE: Record<NavId, string> = Object.fromEntries(
  NAV_DESTINATIONS.map((d) => [d.id, d.title]),
) as Record<NavId, string>;

export interface PageOptions {
  title: string;
  /** Which nav destination is active — highlights the matching rail link, and (absent an
   *  explicit title override) supplies the TopBar breadcrumb's final crumb. */
  activeNav?: NavId;
  /** Optional meta-refresh interval in seconds (no client JS otherwise). */
  refreshSeconds?: number;
  /** Status-strip summary line, rendered as the TopBar's breadcrumb lead-in is fixed
   *  ("Command / <Section>"); this renders as a light context line under the shell header. */
  statusStrip?: string;
  /** Theme cookie value ('light' | 'dark' | undefined). Rendered as `data-theme` on <html> so
   *  the generated tokens.css `html[data-theme="light"]` override applies server-side. */
  theme?: string;
  /** IntentComposer confirmation chip (query param `?captured=WI-NNN`) — forwarded to the
   *  shell-level composer modal so a fresh capture always resolves to a visible confirmation,
   *  even though the modal itself only opens via JS in this no-JS slice (it still renders,
   *  the confirmation text is legible with the modal left closed via CSS `[hidden]`). */
  capturedId?: string;
  /** Ledger-trace metadata for the provenance footer. Views that know their fold pass it
   *  (event count, generated-at, per-pane CLI equivalents); views that don't still get the
   *  generic trace statement — every page ends with the footer either way. */
  provenance?: ProvenanceInfo;
}

// ---------------------------------------------------------------------------
// Provenance footer — every view ends with it
// ---------------------------------------------------------------------------

/** One "reproduce this figure at the terminal" reference: a pane label + the CLI command. */
export interface ProvenanceCliRef {
  label: string;
  command: string;
}

export interface ProvenanceInfo {
  /** ISO8601 render timestamp — when this page's projections were computed. */
  generatedAt?: string;
  /** Number of ledger events the fold consumed to produce the page. */
  eventCount?: number;
  /** Number of work items in the fold. */
  itemCount?: number;
  /** Per-pane CLI equivalents — the command that reproduces each figure from the terminal. */
  cliEquivalents?: ProvenanceCliRef[];
}

/**
 * The shared provenance footer, rendered by the page shell on EVERY view: every value above
 * it traces to the append-only ledger — replaying the events reproduces the page. Fold
 * metadata (event count, generated-at) plus the CLI command reproducing each pane's figures.
 * Static server-rendered markup; the CLI list collapses behind a native `<details>` (zero JS).
 */
export function provenanceFooter(info: ProvenanceInfo = {}): string {
  const metaParts: string[] = [];
  if (info.eventCount !== undefined) metaParts.push(`${esc(String(info.eventCount))} ledger event(s)`);
  if (info.itemCount !== undefined) metaParts.push(`${esc(String(info.itemCount))} work item(s)`);
  if (info.generatedAt !== undefined) metaParts.push(`generated ${esc(info.generatedAt)}`);
  const metaLine = metaParts.length > 0
    ? `<p class="provenance__meta">${metaParts.join(' · ')}</p>`
    : '';

  const cli = info.cliEquivalents ?? [];
  const cliBlock = cli.length > 0
    ? `<details class="provenance__cli"><summary>Reproduce these figures at the terminal</summary>` +
      `<table class="provenance__cli-table">` +
      `<thead><tr><th>Pane</th><th>CLI equivalent</th></tr></thead>` +
      `<tbody>${cli.map((r) => `<tr><td>${esc(r.label)}</td><td><code>${esc(r.command)}</code></td></tr>`).join('')}</tbody>` +
      `</table></details>`
    : '';

  const body =
    `<p class="provenance__trace">Every value on this page is a projection of the append-only ledger — ` +
    `replay the events and you reproduce it. Nothing here is hand-maintained state.</p>` +
    metaLine +
    cliBlock;

  return `<footer class="opsui-provenance">${Card({ title: 'Provenance', subtitle: 'Where these numbers come from', body })}</footer>`;
}

/** How many destinations the rail/bottom-nav bar surfaces before the rest move into the
 *  overflow disclosure below — kept in sync with BottomNav's own default `limit` (five).
 *  NAV_DESTINATIONS only has five entries today, so this is currently a no-op; it starts
 *  applying the moment a sixth destination is registered. */
const NAV_RAIL_LIMIT = 5;

/** Split destinations into the bar-visible set (top `limit` by mobilePriority) and the rest.
 *  Doing this split at the call site — rather than letting NavigationRail/BottomNav ever see
 *  more than `limit` destinations — means overflow always renders through `moreDisclosure`
 *  below (a native `<details>`, zero JS) instead of BottomNav's own JS-gated bottom-sheet
 *  affordance, which never gets the chance to trigger. */
export function splitNavForBar(
  destinations: (NavDestination & { id: string })[],
  limit: number = NAV_RAIL_LIMIT,
): { primary: (NavDestination & { id: string })[]; overflow: (NavDestination & { id: string })[] } {
  const sorted = [...destinations].sort(
    (a, b) => (a.mobilePriority ?? Infinity) - (b.mobilePriority ?? Infinity),
  );
  return { primary: sorted.slice(0, limit), overflow: sorted.slice(limit) };
}

/** Render overflow destinations inside a native `<details class="opsui-more">` disclosure —
 *  same href-driven anchors as the bar items above it (reuses `itemClass` so they're styled
 *  identically), just collapsed by default and requiring no client JS to open. */
export function moreDisclosure(
  destinations: (NavDestination & { id: string })[],
  activeId: string | undefined,
  itemClass: string,
): string {
  if (destinations.length === 0) return '';
  const items = destinations
    .map((d) => {
      const active = d.id === activeId;
      const className = active ? `${itemClass} ${itemClass}--active` : itemClass;
      const current = active ? ' aria-current="page"' : '';
      return `<a class="${className}" href="${esc(d.href)}"${current}>${esc(d.title)}</a>`;
    })
    .join('');
  return (
    `<details class="opsui-more"><summary class="opsui-more__summary">More</summary>` +
    `<div class="opsui-more__items">${items}</div></details>`
  );
}

/** Splice pre-rendered overflow markup just inside a component's closing `</nav>` tag, so it
 *  inherits the same show/hide media queries (desktop rail vs. mobile bottom nav) as the bar
 *  it belongs to. */
function withOverflow(navHtml: string, overflowHtml: string): string {
  return overflowHtml ? navHtml.replace(/<\/nav>\s*$/, `${overflowHtml}</nav>`) : navHtml;
}

function railFor(activeNav?: NavId): string {
  // The desktop rail is a VERTICAL column with unlimited height, so it renders every
  // destination flat — matching the reference console. The five-slot NAV_RAIL_LIMIT + "More"
  // overflow exists only for the mobile BottomNav bar (five horizontal slots), wired in page()
  // below; folding the rail into a "More" disclosure was a regression the moment a sixth
  // destination (Knowledge) registered.
  return NavigationRail({ destinations: NAV_DESTINATIONS, activeId: activeNav, expanded: true });
}

/**
 * The shell-level CommandPalette's result groups. There is no search/suggest endpoint (the
 * console has no server-side search API to call), so — per the progressive-enhancement
 * contract — the palette ships with exactly what's true today: the five nav destinations,
 * client-filtered by console-palette.js's fuzzy match. This degrades honestly: no JS means the
 * palette never opens (its Search no-JS twin links straight to /missions instead), and with JS
 * the results are real working `navigate:` links, never a stub.
 */
function paletteGroupsFromNav(): PaletteGroup[] {
  return [
    {
      heading: 'Go to',
      items: NAV_DESTINATIONS.map((d) => ({
        label: d.title,
        action: `navigate:${d.href}`,
        meta: d.purpose,
      })),
    },
  ];
}

/** The breadcrumb reads "Console / <Section>" — a fixed root crumb (matching the reference
 *  console's "Ops / <Section>" shape) followed by the active section, so Command's own crumb
 *  never duplicates itself the way a bare "Command / Command" would. */
function topBarFor(opts: PageOptions): string {
  const title = opts.activeNav ? NAV_TITLE[opts.activeNav] : opts.title;
  return TopBar({
    title,
    breadcrumbs: [{ label: 'Console', href: '/command' }],
  });
}

/**
 * TopBar renders Search / Drop intent / theme-toggle as `data-opsui-shell` buttons meant for
 * the (not-yet-built) client module. This slice keeps the exact same classes/attributes — so
 * slice 3's JS binds to the identical markup — but layers a no-JS fallback UNDER each button via
 * a thin wrapper: Search becomes a real link to /missions (a full-text search page is optional
 * per the task and out of scope here), Drop intent becomes a real link to the inline composer
 * anchor on /command, and the theme toggle becomes a tiny same-page POST /theme form. The
 * buttons themselves stay `type="button"` (unclickable without JS) — swapped for real
 * `<a>`/`<form>` twins placed immediately after them, both sharing the design system's button
 * chrome so the page reads identically whichever one renders.
 */
function topBarWithNoJsFallback(opts: PageOptions, returnTo: string): string {
  const bar = topBarFor(opts);
  const searchFallback =
    `<a class="opsui-topbar__palette opsui-topbar__nojs" href="/missions">` +
    `<span class="opsui-topbar__palette-hint">Search</span></a>`;
  const composerFallback =
    `<a class="opsui-topbar__intent opsui-topbar__nojs" href="/command#opsui-intent">` +
    `<span class="opsui-topbar__intent-icon" aria-hidden="true">+</span>` +
    `<span class="opsui-topbar__intent-hint">Drop intent</span></a>`;
  const nextTheme = opts.theme === 'light' ? 'dark' : 'light';
  const themeFallback =
    `<form method="post" action="/theme" class="opsui-topbar__theme-form">` +
    `<input type="hidden" name="returnTo" value="${esc(returnTo)}">` +
    `<input type="hidden" name="theme" value="${esc(nextTheme)}">` +
    `<button type="submit" class="opsui-topbar__theme opsui-topbar__nojs" aria-label="Toggle colour theme">` +
    `<span aria-hidden="true">◐</span></button></form>`;
  // Insert the fallbacks right after each button's closing tag so both twins sit adjacent —
  // CSS (console.css) hides the inert `data-opsui-shell` buttons until slice 3's JS marks the
  // document ready, at which point the JS-driven originals take over and the fallbacks hide.
  return bar
    .replace(
      /(<button type="button" class="opsui-topbar__palette"[^>]*>.*?<\/button>)/s,
      `$1${searchFallback}`,
    )
    .replace(
      /(<button type="button" class="opsui-topbar__intent"[^>]*>.*?<\/button>)/s,
      `$1${composerFallback}`,
    )
    .replace(
      /(<button type="button" class="opsui-topbar__theme"[^>]*>.*?<\/button>)/s,
      `$1${themeFallback}`,
    );
}

/**
 * External script tags — the ONE place the zero-inline-script rule allows a `<script>` tag:
 * every one carries `src` and no body, loaded from this server's own /console-*.js static
 * routes (same allowlist as console.css). `defer` keeps them off the critical render path and
 * guarantees DOM-ready-order execution: shell first (it owns open/close + the ready class),
 * then palette/composer/confirm (they only need the shell's hooks to already exist in markup,
 * not for shell.js to have run first — but deferred scripts execute in document order
 * regardless, so the ordering is both correct and irrelevant to correctness here).
 */
const SHELL_SCRIPTS = [
  '/console-shell.js',
  '/console-palette.js',
  '/console-composer.js',
  '/console-confirm.js',
  '/console-live.js',
] as const;

function shellScriptTags(): string {
  return SHELL_SCRIPTS.map((src) => `<script src="${src}" defer></script>`).join('\n');
}

/** Wrap a body fragment (the page's `opsui-shell__workspace` content) in the shared AppShell. */
export function page(opts: PageOptions, bodyHtml: string): string {
  const refresh = opts.refreshSeconds
    ? `<meta http-equiv="refresh" content="${opts.refreshSeconds}">`
    : '';
  const statusStrip = opts.statusStrip
    ? `<div class="statusstrip">${opts.statusStrip}</div>`
    : '';
  const returnTo = opts.activeNav ? NAV_DESTINATIONS.find((d) => d.id === opts.activeNav)?.href ?? '/command' : '/command';
  const rail = railFor(opts.activeNav);
  const topBar = topBarWithNoJsFallback(opts, returnTo);
  // Shell-level modals: hidden by construction (CommandPalette/IntentComposerModal default to
  // closed), opened only by console-shell.js via the TopBar buttons' `data-opsui-shell` hooks.
  // AppShell nests both inside `.opsui-shell` itself (its own palette/composerModal slots).
  const palette = CommandPalette({ groups: paletteGroupsFromNav(), open: false });
  const composerModal = IntentComposerModal({
    action: '/intent',
    capturedId: opts.capturedId,
    capturedHref: opts.capturedId ? `/item/${encodeURIComponent(opts.capturedId)}` : undefined,
  });
  // Every view ends with the provenance footer — views that pass fold metadata get the full
  // trace (event count, generated-at, CLI equivalents); the rest get the generic statement.
  const workspace = `${statusStrip}${bodyHtml}${provenanceFooter(opts.provenance)}`;
  // The rail is desktop-only (components.css hides it ≤640px); the BottomNav twin is the
  // mobile navigation — same bar-visible destinations, same activeId, zero-JS anchors, with
  // anything past NAV_RAIL_LIMIT folded into the same native-<details> overflow as the rail.
  const { primary: bottomNavPrimary, overflow: bottomNavOverflow } = splitNavForBar(NAV_DESTINATIONS);
  const bottomNav = withOverflow(
    BottomNav({ destinations: bottomNavPrimary, activeId: opts.activeNav }),
    moreDisclosure(bottomNavOverflow, opts.activeNav, 'opsui-bottomnav__item'),
  );
  const shell = AppShell({ rail, topBar, workspace, palette, composerModal, bottomNav, railExpanded: true });
  const themeAttr = opts.theme === 'light' ? ' data-theme="light"' : '';

  return `<!doctype html>
<html lang="en"${themeAttr}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#0b0e14">
${refresh}
<title>${esc(opts.title)}</title>
<link rel="stylesheet" href="/ui-fonts.css">
<link rel="stylesheet" href="/ui-tokens.css">
<link rel="stylesheet" href="/ui-components.css">
<link rel="stylesheet" href="/console.css">
</head>
<body>
${shell}
${shellScriptTags()}
</body>
</html>
`;
}

/**
 * Render a plain error page for a write verb that cannot proceed (no such item, wrong item
 * state, verb validation failure) — always with a link back to the view the operator came
 * from: on a zero-JS console a dead-end error page would otherwise strand them.
 */
export function errorPage(message: string, backHref: string): string {
  return page(
    { title: 'Cannot do that — loopkit console', activeNav: 'command' },
    `<h1 class="opsui-page-title">Cannot do that</h1>
<p>${esc(message)}</p>
<p><a href="${esc(backHref)}">← Back</a></p>`,
  );
}

/** Render a simple 404 page. */
export function notFoundPage(path: string): string {
  return page(
    { title: '404 — not found', activeNav: 'command' },
    `<h1>404</h1><p>No route for <code>${esc(path)}</code>.</p>`,
  );
}

/**
 * A single-button POST form (zero client JS) — the shape every operator verb uses. `returnTo`
 * is threaded through as a hidden field so the server can 303-redirect back to whichever view
 * the form was rendered on (POST-redirect-GET).
 */
export function verbForm(opts: {
  action: string;
  label: string;
  returnTo: string;
  className?: string;
}): string {
  return `<form method="post" action="${esc(opts.action)}" class="${esc(opts.className ?? 'verb-form')} opsui-eventrow__actionform">
<input type="hidden" name="returnTo" value="${esc(opts.returnTo)}">
<button type="submit" class="opsui-btn opsui-btn--primary opsui-btn--sm">${esc(opts.label)}</button>
</form>`;
}

/**
 * A deliberately designed empty state — the ledger starts nearly empty, and this console gets
 * screenshotted/demoed, so "nothing here yet" must read as intentional, not broken.
 */
export function emptyState(title: string, hint?: string): string {
  const hintHtml = hint ? `<span class="opsui-empty__hint">${esc(hint)}</span>` : '';
  return `<div class="opsui-empty-state">
<span class="opsui-empty-state__title">${esc(title)}</span>
${hintHtml}
</div>`;
}

/** Re-exported so callers that only need escaping don't have to import `@loopkit/ui` directly. */
export { uiEsc };
