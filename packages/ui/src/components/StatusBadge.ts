// StatusBadge — the only way to render an operational state chip.
// No custom colour prop exists; colour derives from `state`. Never colour alone:
// always a text label plus a shape marker.

import type { OperationalState } from '../states/operational-state.ts';
import { cx, esc } from '../render/html.ts';

export type StatusEmphasis = 'default' | 'blocking' | 'recommended';
export type StatusSize = 'sm' | 'md';

export type StatusBadgeProps = {
  state: OperationalState;
  label: string;
  emphasis?: StatusEmphasis;
  size?: StatusSize;
};

// Shape marker per emphasis: blocking → diamond, recommended → star.
const MARKER_SHAPE: Record<StatusEmphasis, string> = {
  default: 'dot',
  blocking: 'diamond',
  recommended: 'star',
};

export function StatusBadge(props: StatusBadgeProps): string {
  const emphasis: StatusEmphasis = props.emphasis ?? 'default';
  const size: StatusSize = props.size ?? 'md';
  const className = cx(
    'opsui-status',
    `opsui-status--${props.state}`,
    `opsui-status--${size}`,
    emphasis !== 'default' && `opsui-status--${emphasis}`,
  );
  const marker =
    `<span class="opsui-status__marker opsui-status__marker--${MARKER_SHAPE[emphasis]}"` +
    ` aria-hidden="true"></span>`;
  return (
    `<span class="${className}" data-state="${props.state}">` +
    `${marker}<span class="opsui-status__label">${esc(props.label)}</span></span>`
  );
}
