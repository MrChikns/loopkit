// Card — the primary grouping surface, and the ONLY component that
// owns border, radius, background, and shadow. Headers/titles/subtitles are part
// of the same contract so projections never hand-roll a card header.

import { cx, esc } from '../render/html.ts';

export type CardVariant = 'default' | 'glance' | 'inset';

export type CardProps = {
  /** Pre-rendered HTML for the card body. Callers compose other components here. */
  body: string;
  variant?: CardVariant;
  title?: string;
  subtitle?: string;
  /** Optional pre-rendered HTML placed at the end of the header row (e.g. a badge). */
  headerAside?: string;
};

export function Card(props: CardProps): string {
  const variant: CardVariant = props.variant ?? 'default';
  const className = cx('opsui-card', `opsui-card--${variant}`);

  let header = '';
  if (props.title || props.headerAside) {
    const titleBlock = props.title
      ? `<div class="opsui-card__titles">` +
        `<h3 class="opsui-card__title">${esc(props.title)}</h3>` +
        (props.subtitle
          ? `<p class="opsui-card__subtitle">${esc(props.subtitle)}</p>`
          : '') +
        `</div>`
      : '';
    const aside = props.headerAside
      ? `<div class="opsui-card__aside">${props.headerAside}</div>`
      : '';
    header = `<header class="opsui-card__header">${titleBlock}${aside}</header>`;
  }

  return `<section class="${className}">${header}<div class="opsui-card__body">${props.body}</div></section>`;
}
