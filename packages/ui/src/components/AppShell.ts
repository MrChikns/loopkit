// AppShell — the one layout frame for every plane surface:
// navigation rail + sticky top bar + context/freshness bar + workspace, with the
// evidence-drawer overlay and mobile bottom-navigation as slots. It composes
// pre-rendered regions (each its own canonical component) and never owns their
// internals — projections fill the workspace.

import { cx } from '../render/html.ts';

export type AppShellProps = {
  /** Pre-rendered NavigationRail. */
  rail: string;
  /** Pre-rendered TopBar. */
  topBar: string;
  /** Pre-rendered ContextBar (freshness/state strip). */
  contextBar?: string;
  /** Pre-rendered workspace HTML — the projection's two-column body. */
  workspace: string;
  /** Pre-rendered EvidenceDrawer overlay (deferred; slot only). */
  drawer?: string;
  /** Pre-rendered mobile BottomNav. */
  bottomNav?: string;
  /** Pre-rendered CommandPalette (ships hidden). */
  palette?: string;
  /** Pre-rendered IntentComposer modal (ships hidden; global "drop intent" entry point). */
  composerModal?: string;
  /** Initial rail width; the client toggle flips + persists it. */
  railExpanded?: boolean;
};

export function AppShell(props: AppShellProps): string {
  const railState = (props.railExpanded ?? true) ? 'expanded' : 'compact';
  const className = cx('opsui-shell', 'opsui-root');
  return (
    `<div class="${className}" data-opsui-shell="root" data-rail="${railState}">` +
    props.rail +
    `<div class="opsui-shell__column">` +
    props.topBar +
    (props.contextBar ?? '') +
    `<main class="opsui-shell__workspace" role="main" tabindex="-1">${props.workspace}</main>` +
    `</div>` +
    (props.bottomNav ?? '') +
    (props.drawer ?? '') +
    (props.palette ?? '') +
    (props.composerModal ?? '') +
    `</div>`
  );
}
