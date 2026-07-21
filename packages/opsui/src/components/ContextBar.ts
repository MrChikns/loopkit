// ContextBar — the context/freshness bar. The always-visible strip under
// the top bar that states how fresh the operating picture is and its overall
// operational state. Reuses StatusBadge so state colour is chosen once.

import { esc } from '../render/html.ts';
import type { OperationalState } from '../states/operational-state.ts';
import { StatusBadge } from './StatusBadge.ts';

export type ContextBarProps = {
  state: OperationalState;
  /** Short state label, e.g. "Healthy" / "1 blocked". */
  stateLabel: string;
  /** Freshness text, e.g. "Updated 12s ago". Announced politely on refresh. */
  freshness: string;
  /** Optional right-aligned metadata items (e.g. active worker count). */
  meta?: string[];
};

export function ContextBar(props: ContextBarProps): string {
  const badge = StatusBadge({ state: props.state, label: props.stateLabel, size: 'sm' });
  const meta = (props.meta ?? [])
    .map((m) => `<span class="opsui-contextbar__metaitem">${esc(m)}</span>`)
    .join('');
  return (
    `<div class="opsui-contextbar" role="status" aria-live="polite">` +
    `<div class="opsui-contextbar__lead">${badge}` +
    `<span class="opsui-contextbar__freshness">${esc(props.freshness)}</span></div>` +
    (meta ? `<div class="opsui-contextbar__meta">${meta}</div>` : '') +
    `</div>`
  );
}
