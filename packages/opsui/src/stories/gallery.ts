// Static stories gallery (no Storybook). Renders every
// first-wave component across its states so a screenshot gallery-gate can catch
// visual drift. Pure string rendering; the build script wires in the stylesheets.

import { AppShell } from '../components/AppShell.ts';
import { BottomNav } from '../components/BottomNav.ts';
import { Button } from '../components/Button.ts';
import { Card } from '../components/Card.ts';
import { CommandPalette } from '../components/CommandPalette.ts';
import { ContextBar } from '../components/ContextBar.ts';
import { EventRow } from '../components/EventRow.ts';
import { IntentComposer } from '../components/IntentComposer.ts';
import { MetricTile } from '../components/MetricTile.ts';
import { NavigationRail } from '../components/NavigationRail.ts';
import { StatusBadge } from '../components/StatusBadge.ts';
import { WindowPicker } from '../components/WindowPicker.ts';
import { TopBar } from '../components/TopBar.ts';
import type { NavDestination } from '../components/types.ts';
import { OPERATIONAL_STATES } from '../states/operational-state.ts';
import { STATUS_IDS, STATUS_CATALOG, statusBadgeProps } from '../states/status-catalog.ts';
import { esc } from '../render/html.ts';
import type { ThemeName } from '../tokens/semantic.ts';

// Sample destinations (the registry emits these; here they are literal
// so the shell stories have something to render).
const DESTINATIONS: NavDestination[] = [
  { id: 'command', title: 'Command', purpose: 'Glance, act and drill without leaving the picture', href: '/command', mobilePriority: 1 },
  { id: 'acceptance', title: 'Acceptance', purpose: 'Test and accept what shipped', href: '/acceptance', mobilePriority: 2 },
  { id: 'decisions', title: 'Decisions', purpose: 'Answer what is blocking the queue', href: '/decisions', mobilePriority: 3 },
  { id: 'health', title: 'Health', purpose: 'SLOs and the pipeline itself', href: '/health', mobilePriority: 4 },
  { id: 'workforce', title: 'Workforce', purpose: 'Workers, sessions and threads', href: '/workforce', mobilePriority: 5 },
  { id: 'company', title: 'Knowledge', purpose: 'The knowledge stream and provenance', href: '/company', mobilePriority: null },
];

function section(title: string, body: string): string {
  return (
    `<section class="story"><h2 class="story__title">${title}</h2>` +
    `<div class="story__row">${body}</div></section>`
  );
}

function buttonStories(): string {
  const variants = ['primary', 'secondary', 'ghost', 'danger'] as const;
  return section(
    'Button',
    variants.map((v) => Button({ label: v, variant: v })).join('') +
      Button({ label: 'disabled', variant: 'secondary', disabled: true }),
  );
}

function statusBadgeStories(): string {
  const base = OPERATIONAL_STATES.map((state) =>
    StatusBadge({ state, label: state }),
  ).join('');
  const emphasis =
    StatusBadge({ state: 'critical', label: 'Blocking', emphasis: 'blocking' }) +
    StatusBadge({ state: 'info', label: 'Recommended', emphasis: 'recommended' });
  return section('StatusBadge', base + emphasis);
}

/** The full status catalog (status-catalog.ts, WI-086/WI-087) rendered as visible
 *  documentation — every operational status id a work item can carry, its badge exactly as
 *  every real surface (Command, Missions, the item hub) renders it, plus the one-line
 *  meaning an operator should read it as. This is the vocabulary, made visible. */
function statusCatalogStories(): string {
  const rows = STATUS_IDS.map((id) => {
    const entry = STATUS_CATALOG[id];
    const badge = StatusBadge(statusBadgeProps(entry));
    return (
      `<div class="opsui-status-catalog__row">` +
      `<div class="opsui-status-catalog__badge">${badge}</div>` +
      `<span class="opsui-status-catalog__meaning">${esc(entry.meaning)}</span>` +
      `</div>`
    );
  }).join('');
  return section('Status catalog', `<div class="opsui-status-catalog">${rows}</div>`);
}

function windowPickerStories(): string {
  // Shown standalone and in its real habitat — a Card headerAside (WI-359 pattern:
  // region filters live on the title row, never in the body).
  return section(
    'WindowPicker',
    WindowPicker({ active: '24h' }) +
      WindowPicker({ active: '7d' }) +
      Card({
        title: 'Region with a window filter',
        subtitle: 'Filter sits in headerAside',
        headerAside: WindowPicker({ active: '7d' }),
        body: '<p style="margin:0;color:var(--text-2);font-size:13px">Windowed content.</p>',
      }),
  );
}

function cardStories(): string {
  const variants = ['default', 'glance', 'inset'] as const;
  return section(
    'Card',
    variants
      .map((variant) =>
        Card({
          variant,
          title: `Card · ${variant}`,
          subtitle: 'Grouping surface',
          headerAside: StatusBadge({ state: 'success', label: 'Healthy' }),
          body: '<p style="margin:0;color:var(--text-2);font-size:13px">Body content composed from shared components.</p>',
        }),
      )
      .join(''),
  );
}

function metricStories(): string {
  return section(
    'MetricTile',
    MetricTile({
      label: 'Dispatch latency',
      value: '4.2s',
      footnote: 'p95 · last 24h',
      state: 'success',
      open: { kind: 'projection', id: 'plane-observability' },
    }) +
      MetricTile({
        label: 'Needs acceptance',
        value: 3,
        footnote: 'oldest 6h',
        state: 'warning',
        open: { kind: 'projection', id: 'acceptance' },
      }) +
      MetricTile({
        label: 'Blocked decisions',
        value: 1,
        footnote: 'queue blocked',
        state: 'critical',
        open: { kind: 'evidence', id: 'ev-decisions' },
      }),
  );
}

function eventRowStories(): string {
  return section(
    'EventRow',
    EventRow({
      state: 'success',
      title: 'WI-141 · SLO evidence links',
      metadata: ['shipped', 'deploy 8d698c8', '11:02'],
      summary: 'Delivered and deployed to all three instances.',
      badge: { state: 'success', label: 'Delivered' },
      evidence: { id: 'deploy-8d698c8', label: 'Deploy receipt' },
    }) +
      EventRow({
        state: 'critical',
        title: 'ADR-042 · threshold ownership',
        metadata: ['decision', 'blocking queue'],
        summary: 'A parked decision is blocking two queued items.',
        badge: { state: 'critical', label: 'Blocking', emphasis: 'blocking' },
        actions: [{ id: 'answer:ADR-042', label: 'Answer', emphasis: 'primary' }],
        evidence: { id: 'ADR-042', label: 'Decision detail' },
      }),
  );
}

function navigationRailStories(): string {
  return section(
    'NavigationRail',
    `<div class="opsui-rail--expanded">${NavigationRail({ destinations: DESTINATIONS, activeId: 'command', expanded: true })}</div>` +
      `<div class="opsui-rail--compact">${NavigationRail({ destinations: DESTINATIONS, activeId: 'command', expanded: false })}</div>`,
  );
}

function topBarStories(): string {
  return section(
    'TopBar',
    `<div style="flex:1 1 100%">${TopBar({
      title: 'Command',
      breadcrumbs: [{ label: 'Ops', href: '/command' }],
    })}</div>`,
  );
}

function intentComposerStories(): string {
  // The drop-intent widget: the write peer of Search. Rendered inline here; the
  // shell wraps it in the topbar-triggered dialog (see TopBar / AppShell stories).
  return section(
    'IntentComposer',
    `<div style="flex:1 1 100%;max-width:560px">${IntentComposer({
      action: '/intent',
    })}</div>`,
  );
}

function contextBarStories(): string {
  return section(
    'ContextBar',
    `<div style="flex:1 1 100%">${ContextBar({
      state: 'warning',
      stateLabel: '1 needs acceptance',
      freshness: 'Updated 12s ago',
      meta: ['2 workers', 'dispatch 4.2s p95'],
    })}</div>`,
  );
}

function bottomNavStories(): string {
  // `.opsui-bottomnav` is display:none off-mobile; `.story-bottomnav` (gallery
  // chrome) forces it visible so the screenshot gate can see it on desktop.
  return section(
    'BottomNav',
    `<div class="story-bottomnav" style="flex:1 1 320px;max-width:360px">${BottomNav({
      destinations: DESTINATIONS,
      activeId: 'command',
    })}</div>`,
  );
}

// A bounded box that contains the shell's full-height/fixed layout so it renders
// as one screenshot tile alongside the other stories. `transform` makes the
// palette's `position: fixed` resolve against this box, not the viewport.
function shellStories(): string {
  const palette = CommandPalette({
    open: true,
    groups: [
      {
        heading: 'Projections',
        items: [
          { label: 'Health', action: 'projection:health', meta: 'SLOs' },
          { label: 'Acceptance', action: 'projection:acceptance', meta: '3 waiting' },
        ],
      },
      {
        heading: 'Decisions',
        items: [{ label: 'ADR-042 · threshold ownership', action: 'answer:ADR-042', meta: 'blocking' }],
      },
    ],
  });
  const shell = AppShell({
    rail: NavigationRail({ destinations: DESTINATIONS, activeId: 'command', expanded: true }),
    topBar: TopBar({ title: 'Command', breadcrumbs: [{ label: 'Ops', href: '/command' }] }),
    contextBar: ContextBar({
      state: 'success',
      stateLabel: 'Healthy',
      freshness: 'Updated 4s ago',
      meta: ['2 workers'],
    }),
    workspace:
      Card({
        variant: 'glance',
        title: 'Operating picture',
        subtitle: 'Projections fill the workspace',
        body: '<p style="margin:0;color:var(--text-2);font-size:13px">The shell owns layout, navigation, and the palette; projections own this region.</p>',
      }) +
      `<div style="height:8px"></div>` +
      palette,
    railExpanded: true,
  });
  return (
    `<section class="story"><h2 class="story__title">AppShell</h2>` +
    `<div class="story__row"><div style="flex:1 1 100%;position:relative;transform:translateZ(0);height:480px;overflow:hidden;border:1px solid var(--line);border-radius:14px">${shell}</div></div></section>`
  );
}

/** All story sections, in gallery order. Pure HTML, no document chrome. */
export function renderStories(): string {
  return [
    buttonStories(),
    statusBadgeStories(),
    statusCatalogStories(),
    windowPickerStories(),
    cardStories(),
    metricStories(),
    eventRowStories(),
    navigationRailStories(),
    topBarStories(),
    intentComposerStories(),
    contextBarStories(),
    bottomNavStories(),
    shellStories(),
  ].join('\n');
}

/** A complete, self-contained gallery document for one theme. */
export function galleryDocument(opts: {
  tokensCss: string;
  componentsCss: string;
  theme?: ThemeName;
}): string {
  const theme = opts.theme ?? 'dark';
  const galleryChrome = `
    body { margin: 0; padding: 32px; }
    .story { margin-bottom: 32px; }
    .story__title { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-3); margin: 0 0 12px; }
    .story__row { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-start; }
    .story-bottomnav .opsui-bottomnav { display: flex; position: static; }
    .opsui-status-catalog { display: flex; flex-direction: column; gap: 10px; width: 100%; }
    .opsui-status-catalog__row { display: flex; align-items: baseline; gap: 12px; }
    .opsui-status-catalog__badge { flex: 0 0 auto; min-width: 180px; }
    .opsui-status-catalog__meaning { color: var(--text-2); font-size: 13px; }
  `;
  return (
    `<!doctype html><html lang="en" data-theme="${theme}"><head>` +
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>ops-ui stories · ${theme}</title>` +
    `<style>${opts.tokensCss}</style>` +
    `<style>${opts.componentsCss}</style>` +
    `<style>${galleryChrome}</style>` +
    `<script type="module" src="/ui/shell.js"></script></head>` +
    `<body class="opsui-root">${renderStories()}</body></html>`
  );
}
