// WindowPicker — the zero-JS time-window filter (promoted to a shared
// component). Renders query-param links (`?window=24h|7d|…`) with aria-current on
// the active option, styled as a compact segmented control. Place it in a Card's
// `headerAside` slot so the filter sits on the title row of the region it scopes —
// never inside the body. Same link-not-script pattern as the acceptance origin filter.
//
// The option set is configurable per widget class (e.g. a spend table offers
// 24h/7d/30d/all while a cache widget offers 5m/1h/24h), and `param` lets two pickers
// coexist on one page without clobbering each other's query param. Option keys are
// validated/labelled by the shared time-window parser — the picker never invents a
// second parse of the window grammar.

import { esc } from '../render/html.ts';
import { FOLLOW_WINDOW_OPTIONS } from '../time-window.ts';

/** @deprecated Prefer plain window-key strings via the shared time-window parser; this
 *  narrow union survives for callers written against the original three-preset picker. */
export type TimeWindow = '24h' | '7d' | '30d';

export type WindowPickerProps = {
  /** The currently-active window key (highlighted chip). A custom URL-typed window that
   *  is not in `options` simply renders with no chip highlighted. */
  active: string;
  /** Visually-hidden-from-layout short label; defaults to "Window". */
  label?: string;
  /** Chip options, in render order. Defaults to the follow-the-picker preset. */
  options?: readonly string[];
  /** Query param the chips set; defaults to `window`. */
  param?: string;
  /** Extra query params to preserve on the links (rendered as-is, already encoded). */
  extraQuery?: string;
};

export function WindowPicker(props: WindowPickerProps): string {
  const label = props.label ?? 'Window';
  const param = props.param ?? 'window';
  const options = props.options ?? FOLLOW_WINDOW_OPTIONS;
  const links = options.map((o) => {
    const isActive = o === props.active;
    const cls = `opsui-window__btn${isActive ? ' opsui-window__btn--active' : ''}`;
    const query = `?${esc(param)}=${esc(o)}${props.extraQuery ? `&${props.extraQuery}` : ''}`;
    return (
      `<a class="${cls}" href="${query}"` +
      (isActive ? ' aria-current="true"' : '') +
      `>${esc(o)}</a>`
    );
  }).join('');
  return (
    `<div class="opsui-window" role="group" aria-label="Time window">` +
    `<span class="opsui-window__label">${esc(label)}</span>${links}</div>`
  );
}
