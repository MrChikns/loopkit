// Pagination — the one canonical zero-JS pager. Prev/Next are real anchors
// carrying a caller-supplied href builder (so the surface owns its query params); the
// edges render as inert spans. Consumes tokens only, no ad-hoc button styling.

import { esc } from '../render/html.ts';

export type PaginationProps = {
  /** 1-based current page. */
  page: number;
  /** Total number of pages (>= 1). */
  pageCount: number;
  /** Total item count, for the "Page X of Y (N items)" info line. */
  total: number;
  /** Noun for the info line, e.g. "shipped" — rendered as "(N shipped)". */
  itemNoun?: string;
  /** Builds the href for a target page (the surface owns its query string). */
  hrefFor: (page: number) => string;
  /** Accessible label for the nav landmark. */
  label?: string;
};

/** A zero-JS pager. Returns '' when there is only one page (nothing to navigate). */
export function Pagination(props: PaginationProps): string {
  if (props.pageCount <= 1) return '';
  const { page, pageCount, total } = props;
  const noun = props.itemNoun ? ` ${esc(props.itemNoun)}` : '';

  const prev =
    page <= 1
      ? `<span class="opsui-pager__edge opsui-pager__edge--disabled">← Prev</span>`
      : `<a class="opsui-pager__edge" href="${esc(props.hrefFor(page - 1))}" rel="prev">← Prev</a>`;
  const next =
    page >= pageCount
      ? `<span class="opsui-pager__edge opsui-pager__edge--disabled">Next →</span>`
      : `<a class="opsui-pager__edge" href="${esc(props.hrefFor(page + 1))}" rel="next">Next →</a>`;

  return (
    `<nav class="opsui-pager" aria-label="${esc(props.label ?? 'Pages')}">` +
    prev +
    `<span class="opsui-pager__info">Page ${esc(String(page))} of ${esc(String(pageCount))} (${esc(String(total))}${noun})</span>` +
    next +
    `</nav>`
  );
}
