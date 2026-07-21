// EventRow — human-readable projection of one important event. The
// vertical rail uses the lighter semantic *tab* token, never a dark border
// colour. Raw worker chatter never appears here — only stream-worthy events.

import type { OperationalState } from '../states/operational-state.ts';
import { cx, esc, linkifyDecisionRefs } from '../render/html.ts';
import { Button, type ButtonVariant } from './Button.ts';
import { StatusBadge, type StatusBadgeProps } from './StatusBadge.ts';
import type { EvidenceRef, EventAction } from './types.ts';

/** A metadata chip is plain text by default; pass `{ label, href }` for the item-hub
 *  link sweep so a work-item id in the metadata row drills to its hub page — the
 *  common string case is untouched, so every existing caller keeps working unchanged. */
export type EventRowMetaItem = string | { label: string; href: string };

export type EventRowProps = {
  state: OperationalState;
  title: string;
  metadata: EventRowMetaItem[];
  summary?: string;
  /** Trusted HTML body rendered between the summary and actions — only ever set by
   *  our own projection renderers (e.g. the decision block), never from user input. */
  body?: string;
  badge?: StatusBadgeProps;
  /** Origin chip — a small secondary StatusBadge shown after the state badge in the
   *  row head (target / plane / mixed). Classifies where the slice's changes land. */
  originChip?: StatusBadgeProps;
  actions?: EventAction[];
  evidence?: EvidenceRef;
  /** App-resolved base href for linkifying `D-NNN` mentions in the summary (e.g. the app's
   *  decision-anchor page, `/company#`). The package never knows the app's routes; without
   *  it, D-NNN mentions render as plain escaped text (never a hardcoded/dead link). */
  drefBaseHref?: string;
};

const ACTION_VARIANT: Record<NonNullable<EventAction['emphasis']>, ButtonVariant> = {
  default: 'secondary',
  primary: 'primary',
  danger: 'danger',
};

export function EventRow(props: EventRowProps): string {
  const className = cx('opsui-eventrow', `opsui-eventrow--${props.state}`);

  const badge = props.badge ? StatusBadge(props.badge) : '';
  const originChip = props.originChip
    ? StatusBadge({ ...props.originChip, size: 'sm' })
    : '';
  const meta = props.metadata.length
    ? `<div class="opsui-eventrow__meta">` +
      props.metadata
        .map((m) =>
          typeof m === 'string'
            ? `<span class="opsui-eventrow__metaitem">${esc(m)}</span>`
            : `<a class="opsui-eventrow__metaitem opsui-eventrow__metaitem--link" href="${esc(m.href)}">${esc(m.label)}</a>`,
        )
        .join('') +
      `</div>`
    : '';
  // Item-hub link sweep: when the app supplies `drefBaseHref`, D-NNN mentions inside a row's
  // free-text summary (park reasons, decision notes) link to the app's decision anchor.
  // linkifyDecisionRefs escapes the text itself before inserting trusted anchor markup; with
  // no base it renders plain escaped text — byte-identical to a bare `esc`.
  const summary = props.summary
    ? `<p class="opsui-eventrow__summary">${linkifyDecisionRefs(props.summary, { drefBaseHref: props.drefBaseHref })}</p>`
    : '';
  const body = props.body ?? '';

  const actionButtons = (props.actions ?? []).map((a) => {
    if (a.form) {
      // Zero-JS: a one-button POST form through the app's deterministic verb endpoint.
      // `confirm` (run-controls hard-stop): a data-opsui-confirm attribute lets
      // opsui-confirm.js gate submission behind window.confirm() — progressive
      // enhancement, the form still posts directly with JS disabled.
      const btnClass = `opsui-btn opsui-btn--${a.emphasis === 'primary' ? 'primary' : a.emphasis === 'danger' ? 'danger' : 'secondary'} opsui-btn--sm`;
      const confirmAttr = a.form.confirm ? ` data-opsui-confirm="${esc(a.form.confirm)}"` : '';
      return (
        `<form class="opsui-eventrow__actionform" method="post" action="${esc(a.form.action)}"${confirmAttr}>` +
        `<input type="hidden" name="intent" value="${esc(a.form.intent)}">` +
        `<button class="${btnClass}" type="submit">${esc(a.label)}</button></form>`
      );
    }
    if (a.composer) {
      // Opens the global composer pre-filled — opsui-shell.js reads `data-opsui-prefill`
      // on the `composer-open` trigger and seeds the textarea before focusing it.
      const btnClass = `opsui-btn opsui-btn--${a.emphasis === 'primary' ? 'primary' : a.emphasis === 'danger' ? 'danger' : 'secondary'} opsui-btn--sm`;
      return (
        `<button class="${btnClass}" type="button" data-opsui-shell="composer-open"` +
        ` data-opsui-prefill="${esc(a.composer.prefill)}">${esc(a.label)}</button>`
      );
    }
    return Button({
      label: a.label,
      variant: ACTION_VARIANT[a.emphasis ?? 'default'],
      size: 'sm',
      action: a.id,
    });
  });
  if (props.evidence) {
    actionButtons.push(
      props.evidence.href
        ? Button({ label: props.evidence.label, variant: 'ghost', size: 'sm', href: props.evidence.href })
        : Button({
            label: props.evidence.label,
            variant: 'ghost',
            size: 'sm',
            action: `evidence:${props.evidence.id}`,
          }),
    );
  }
  const actions = actionButtons.length
    ? `<div class="opsui-eventrow__actions">${actionButtons.join('')}</div>`
    : '';

  return (
    `<article class="${className}" data-state="${props.state}">` +
    `<span class="opsui-eventrow__rail" aria-hidden="true"></span>` +
    `<div class="opsui-eventrow__content">` +
    `<div class="opsui-eventrow__head">` +
    `<h4 class="opsui-eventrow__title">${esc(props.title)}</h4>` +
    (badge || originChip
      ? `<span class="opsui-eventrow__badges">${badge}${originChip}</span>`
      : '') +
    `</div>` +
    `${meta}${summary}${body}${actions}</div></article>`
  );
}
