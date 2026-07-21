// WindowPicker — the zero-JS time-window filter (WI-359, promoted to a shared
// component). Renders query-param links (`?window=24h|7d`) with aria-current on
// the active option, styled as a compact segmented control. Place it in a Card's
// `headerAside` slot so the filter sits on the title row of the region it scopes —
// never inside the body. Same link-not-script pattern
// as the acceptance origin filter (WI-180).

import { esc } from '../render/html.ts';

export type TimeWindow = '24h' | '7d' | '30d';

export type WindowPickerProps = {
  active: TimeWindow;
  /** Visually-hidden-from-layout short label; defaults to "Window". */
  label?: string;
  /** Extra query params to preserve on the links (rendered as-is, already encoded). */
  extraQuery?: string;
};

const OPTIONS: Array<{ value: TimeWindow; label: string }> = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' }, // WI-360
];

export function WindowPicker(props: WindowPickerProps): string {
  const label = props.label ?? 'Window';
  const links = OPTIONS.map((o) => {
    const isActive = o.value === props.active;
    const cls = `opsui-window__btn${isActive ? ' opsui-window__btn--active' : ''}`;
    const query = `?window=${o.value}${props.extraQuery ? `&${props.extraQuery}` : ''}`;
    return (
      `<a class="${cls}" href="${query}"` +
      (isActive ? ' aria-current="true"' : '') +
      `>${esc(o.label)}</a>`
    );
  }).join('');
  return (
    `<div class="opsui-window" role="group" aria-label="Time window">` +
    `<span class="opsui-window__label">${esc(label)}</span>${links}</div>`
  );
}
