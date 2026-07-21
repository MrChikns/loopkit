// ProjectionFailure — fold failure is LOUD: the console must never
// silently render stale fallback data. This is the single surface a projection
// renders when its envelope state is `failed` — it states what broke and what the
// last good data was, and never dresses failure up as ordinary content.

import { cx, esc } from '../render/html.ts';
import { StatusBadge } from './StatusBadge.ts';
import type { EvidenceRef } from './types.ts';

export type ProjectionFailureProps = {
  /** What projection failed to render (human title). */
  projection: string;
  /** Fold/schema reason the sequence was rejected. */
  reason: string;
  /** Last successfully-rendered ledger sequence + when it was fresh. */
  lastGoodSequence: number;
  lastGoodAt?: string;
  /** The sequence that was rejected (present when known). */
  rejectedSequence?: number;
  /** Retry status line, e.g. "retrying in 30s" or "no automatic retry". */
  retry?: string;
  /** Raw evidence link where safe. */
  evidence?: EvidenceRef;
};

export function ProjectionFailure(props: ProjectionFailureProps): string {
  const className = cx('opsui-projfail', 'opsui-projfail--critical');
  const badge = StatusBadge({
    state: 'critical',
    label: 'Fold failure',
    emphasis: 'blocking',
  });

  const facts: Array<[string, string]> = [
    ['Reason', props.reason],
    [
      'Last good',
      props.lastGoodAt
        ? `#${props.lastGoodSequence} · ${props.lastGoodAt}`
        : `#${props.lastGoodSequence}`,
    ],
  ];
  if (props.rejectedSequence !== undefined) {
    facts.push(['Rejected', `#${props.rejectedSequence}`]);
  }
  facts.push(['Retry', props.retry ?? 'no automatic retry']);

  const rows = facts
    .map(
      ([k, v]) =>
        `<div class="opsui-projfail__row">` +
        `<dt class="opsui-projfail__key">${esc(k)}</dt>` +
        `<dd class="opsui-projfail__val">${esc(v)}</dd></div>`,
    )
    .join('');

  const evidence = props.evidence
    ? `<a class="opsui-projfail__evidence" data-opsui-action="evidence:${esc(props.evidence.id)}"` +
      (props.evidence.href ? ` href="${esc(props.evidence.href)}"` : '') +
      `>${esc(props.evidence.label)}</a>`
    : '';

  return (
    `<section class="${className}" role="alert" data-state="critical">` +
    `<header class="opsui-projfail__head">` +
    `<h3 class="opsui-projfail__title">${esc(props.projection)} could not render</h3>${badge}</header>` +
    `<dl class="opsui-projfail__facts">${rows}</dl>${evidence}</section>`
  );
}
