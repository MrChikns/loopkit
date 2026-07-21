// MetricTile — a glanceable value that MUST be actionable: it opens a
// projection or the evidence drawer. Value is tabular-numeric; the footnote gives
// the time horizon / comparison / composition.

import type { OperationalState } from '../states/operational-state.ts';
import { cx, esc } from '../render/html.ts';

export type MetricOpen = {
  kind: 'projection' | 'evidence';
  id: string;
};

export type MetricTileProps = {
  /** Drill target — renders the tile as a link. */
  href?: string;
  label: string;
  value: string | number;
  footnote: string;
  state?: OperationalState;
  /** What the tile opens. Required — a tile must be actionable. */
  open: MetricOpen;
};

export function MetricTile(props: MetricTileProps): string {
  const className = cx(
    'opsui-metric',
    props.state && `opsui-metric--${props.state}`,
  );
  const body =
    `<span class="opsui-metric__label">${esc(props.label)}</span>` +
    `<span class="opsui-metric__value">${esc(props.value)}</span>` +
    `<span class="opsui-metric__footnote">${esc(props.footnote)}</span>`;
  // Glance → drill is a navigation, not a scripted action: an href renders a real anchor
  // (operator finding — the data-attribute buttons had no wired listener).
  if (props.href) {
    return `<a class="${className}" href="${esc(props.href)}">${body}</a>`;
  }
  const action = `${props.open.kind}:${props.open.id}`;
  return (
    `<button type="button" class="${className}" data-opsui-action="${esc(action)}">${body}</button>`
  );
}
