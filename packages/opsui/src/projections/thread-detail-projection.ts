// Thread detail projection — per-external-ref thread detail view (WI-188/WI-191).
// Renders the original founder message, inline attachments, and all reactor
// replies for one conversation thread. Called from renderThreadDetail in the
// app boundary; data is assembled there from the fold + ledger events.
// Composed ONLY from shared components — no raw opsui-* class authorship
// on consuming surfaces.

import { StatusBadge } from '../components/StatusBadge.ts';
import { isResolvableExternalRef } from './fold-adapter.ts';
import { esc, formatLocal } from '../render/html.ts';
import { deriveItemStatus, statusBadgeProps } from '../states/status-catalog.ts';

function fmtTs(ts: string): string {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? '' : formatLocal(d);
}

export type ThreadDetailAttachment = {
  externalId: string;
  name: string;
  bytes: number;
};

export type ThreadDetailMessage = {
  ts: string;
  direction: 'in' | 'out';
  text: string;
};

export type ThreadDetailData = {
  externalRef: string;
  wiRef: string;
  itemState: string;
  capturedAt?: string;
  originalText: string;
  attachments: ThreadDetailAttachment[];
  /** Every message after the opening capture, in ledger order — founder replies AND
   *  reactor replies interleaved (WI-260: the founder's own follow-up replies were
   *  silently dropped when this only carried msg.out). */
  messages: ThreadDetailMessage[];
  outCount: number;
};

const IMAGE_EXT = /\.(jpg|jpeg|png|gif|webp|svg)$/i;

function renderAttachments(attachments: ThreadDetailAttachment[]): string {
  if (attachments.length === 0) return '';
  return (
    `<div class="opsui-threads__attachments">` +
    attachments
      .map((a) => {
        const url = `/attachment?id=${encodeURIComponent(a.externalId)}&name=${encodeURIComponent(a.name)}`;
        if (IMAGE_EXT.test(a.name)) {
          return (
            `<a href="${esc(url)}" target="_blank" rel="noopener">` +
            `<img class="opsui-threads__attachment-img" src="${esc(url)}" alt="${esc(a.name)}" loading="lazy">` +
            `</a>`
          );
        }
        return (
          `<a class="opsui-threads__attachment-link" href="${esc(url)}" download="${esc(a.name)}">` +
          `📎 ${esc(a.name)} (${a.bytes.toLocaleString()} bytes)` +
          `</a>`
        );
      })
      .join('') +
    `</div>`
  );
}

/** Render the thread detail workspace from pre-assembled data. Data collection stays
 *  in the host app layer; all opsui-* class authorship stays inside this package. */
export function ThreadDetailProjection(data: ThreadDetailData): string {
  const { externalRef, wiRef, itemState, capturedAt, originalText, attachments, messages, outCount } = data;
  const status = deriveItemStatus({ state: itemState });
  const headerTs = capturedAt ? fmtTs(capturedAt) : '';
  // A channel-style externalRef (e.g. 'console', stamped on every console-composer
  // capture) isn't a resolvable per-intent address — redirect back to the canonical item
  // hub instead of a /threads/<ref> page the router can never resolve for it.
  const nextPath = isResolvableExternalRef(externalRef) ? `/threads/${externalRef}` : `/item/${wiRef}`;
  const actionUrl = `/intent?next=${encodeURIComponent(nextPath)}`;
  const inputId = `reply-${esc(wiRef || externalRef)}`;

  const outHtml =
    messages.length === 0
      ? `<p class="opsui-empty">No replies yet.</p>`
      : messages
          .map((m) => {
            const dir = m.direction === 'out' ? 'conductor' : 'founder';
            return (
              `<div class="opsui-threads__msg opsui-threads__msg--${dir}">` +
              `<span class="opsui-threads__msg-dir" aria-hidden="true">${dir === 'conductor' ? '🤖' : '👤'}</span>` +
              `<div class="opsui-threads__msg-body">` +
              `<p class="opsui-threads__msg-text">${esc(m.text)}</p>` +
              `<time class="opsui-threads__msg-ts" datetime="${esc(m.ts)}">${esc(fmtTs(m.ts))}</time>` +
              `</div></div>`
            );
          })
          .join('');

  const replyForm =
    `<form class="opsui-threads__reply" method="post" action="${esc(actionUrl)}" enctype="multipart/form-data" data-opsui-action="intent.submit" data-reply-to="${esc(externalRef)}">` +
    `<input type="hidden" name="replyTo" value="${esc(externalRef)}">` +
    `<label class="opsui-threads__reply-label" for="${inputId}">Reply</label>` +
    `<div class="opsui-threads__reply-row">` +
    `<textarea class="opsui-threads__reply-input" id="${inputId}" name="intent" rows="2" placeholder="Reply…"></textarea>` +
    `<button class="opsui-threads__reply-btn opsui-btn opsui-btn--primary opsui-btn--sm" type="submit">Send</button>` +
    `</div></form>`;

  return (
    `<div class="opsui-threads" data-projection="thread-detail">` +
    // ─── Header card: original message ───────────────────────────────────────
    `<div class="opsui-threads__card">` +
    `<div class="opsui-threads__card-hdr">` +
    `<span class="opsui-threads__card-label">${esc(externalRef)} · ${esc(wiRef)}</span>` +
    StatusBadge(statusBadgeProps(status)) +
    (headerTs ? `<span class="opsui-threads__last-ts">Captured ${esc(headerTs)}</span>` : '') +
    `</div>` +
    `<div class="opsui-threads__messages">` +
    `<div class="opsui-threads__msg">` +
    `<span class="opsui-threads__msg-dir" aria-hidden="true">👤</span>` +
    `<div class="opsui-threads__msg-body">` +
    `<p class="opsui-threads__msg-text">${esc(originalText || '(no message text)')}</p>` +
    `</div></div></div>` +
    renderAttachments(attachments) +
    `</div>` +
    // ─── Replies card ─────────────────────────────────────────────────────────
    `<div class="opsui-threads__card">` +
    `<div class="opsui-threads__card-hdr">` +
    `<span class="opsui-threads__card-label">Conversation</span>` +
    StatusBadge({ state: outCount > 0 ? 'success' : 'neutral', label: `${outCount} repl${outCount === 1 ? 'y' : 'ies'}` }) +
    `</div>` +
    `<div class="opsui-threads__messages">${outHtml}</div>` +
    replyForm +
    `</div>` +
    `</div>`
  );
}
