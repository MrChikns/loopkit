// Threads projection — WI-154. The founder's conversation
// history with the conductor: every thread from the fold with its message
// bodies, sorted most-recent-reply first, each carrying an inline reply
// composer that posts via the command dispatcher's `intent.submit` action
// (server fallback: direct POST to /intent). Composed ONLY from
// shared components. A failed envelope renders
// ProjectionFailure and nothing else.

import { Card } from '../components/Card.ts';
import { MetricTile } from '../components/MetricTile.ts';
import { Pagination } from '../components/Pagination.ts';
import { ProjectionFailure } from '../components/ProjectionFailure.ts';
import { StatusBadge } from '../components/StatusBadge.ts';
import { esc , formatLocal } from '../render/html.ts';
import type { GlanceMetric } from './command-projection.ts';
import { isResolvableExternalRef } from './fold-adapter.ts';
import type { ProjectionEnvelope } from './projection-types.ts';
import { THREAD_STATE_BADGE } from './threads-adapter.ts';
import type { ThreadsData, ThreadCard } from './threads-adapter.ts';

/** WI-307: the Conversations region pages at THREADS_PAGE_SIZE with a zero-JS prev/next
 *  pager (same pattern as the delivery stream — command-projection.ts DELIVERY_PAGE_SIZE). */
export const THREADS_PAGE_SIZE = 20;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTs(ts: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return formatLocal(d);
}

// ─── Message list ─────────────────────────────────────────────────────────────

function messageList(thread: ThreadCard): string {
  if (thread.messages.length === 0) return '';
  const items = thread.messages.map((m) => {
    const dir = m.direction === 'out' ? 'conductor' : 'founder';
    return (
      `<div class="opsui-threads__msg opsui-threads__msg--${esc(dir)}">` +
      `<span class="opsui-threads__msg-dir" aria-hidden="true">${dir === 'conductor' ? '🤖' : '👤'}</span>` +
      `<div class="opsui-threads__msg-body">` +
      `<p class="opsui-threads__msg-text">${esc(m.text)}</p>` +
      (m.ts ? `<time class="opsui-threads__msg-ts" datetime="${esc(m.ts)}">${esc(formatTs(m.ts))}</time>` : '') +
      `</div>` +
      `</div>`
    );
  }).join('');
  return `<div class="opsui-threads__messages">${items}</div>`;
}

// ─── Reply composer ───────────────────────────────────────────────────────────

function replyForm(thread: ThreadCard): string {
  const replyTo = thread.externalRef ?? '';
  const replyInput = replyTo
    ? `<input type="hidden" name="replyTo" value="${esc(replyTo)}">`
    : '';
  const nextPath = '/threads';
  const actionUrl = `/intent?next=${esc(encodeURIComponent(nextPath))}`;
  const inputId = `reply-${esc(thread.id)}`;
  const attachId = `reply-attach-${esc(thread.id)}`;
  return (
    // opsui-composer is a second class so opsui-composer.js hooks paste/drop/count for free.
    `<form class="opsui-threads__reply opsui-composer" method="post" action="${actionUrl}" enctype="multipart/form-data" data-opsui-action="intent.submit"${replyTo ? ` data-reply-to="${esc(replyTo)}"` : ''}>` +
    replyInput +
    `<label class="opsui-threads__reply-label" for="${inputId}">Reply</label>` +
    `<div class="opsui-composer__chips" hidden></div>` +
    `<div class="opsui-composer__attach-row">` +
    `<label class="opsui-composer__file-label" for="${attachId}">+ Attach</label>` +
    `<input class="opsui-composer__file-input" type="file" id="${attachId}" name="attachment" accept="image/*,.pdf,.txt,.md,.csv" multiple>` +
    `<span class="opsui-composer__count" hidden></span>` +
    `</div>` +
    `<div class="opsui-threads__reply-row">` +
    `<textarea class="opsui-threads__reply-input" id="${inputId}" name="intent" rows="2" placeholder="Reply…"></textarea>` +
    `<button class="opsui-threads__reply-btn opsui-btn opsui-btn--primary opsui-btn--sm" type="submit">Send</button>` +
    `</div>` +
    `</form>`
  );
}

// ─── Thread card ──────────────────────────────────────────────────────────────

/** Exported so Command can compose the same thread card (incl. reply form) into its
 *  "Conversations" region (nav IA rewire) — relocation
 *  by import, not copy; this renderer stays owned here. Folds every thread into a
 *  collapsed one-liner `<details>` (WI-308): id · title · state badge · last-reply in
 *  the `<summary>`, full message history + reply composer in the body, collapsed by
 *  default. Needs no JS — `<details>` is native. */
export function threadCard(thread: ThreadCard): string {
  const badgeSpec = THREAD_STATE_BADGE[thread.state];
  const stateBadge = StatusBadge({
    state: badgeSpec.state,
    label: badgeSpec.label,
    ...(thread.state === 'needs-you' ? { emphasis: 'blocking' as const } : {}),
  });

  const parkSubtitle = thread.state === 'needs-you' && thread.parkReason
    ? `<p class="opsui-threads__park-reason">${esc(thread.parkReason)}</p>`
    : '';

  const supersededSubtitle = thread.state === 'superseded' && thread.supersededBy
    ? `<p class="opsui-threads__superseded-note">Closed — superseded by ${esc(thread.supersededBy)}</p>`
    : '';

  const lastReply = thread.lastOutTs
    ? `<span class="opsui-threads__last-ts">Last reply ${esc(formatTs(thread.lastOutTs))}</span>`
    : '';

  // A channel-style externalRef (e.g. 'console', stamped on every console-composer capture)
  // isn't a resolvable per-intent address — link the card at the canonical item hub instead
  // of a /threads/<ref> page the router can never resolve for it.
  const detailHref = thread.externalRef && isResolvableExternalRef(thread.externalRef)
    ? `/threads/${thread.externalRef}`
    : `/item/${thread.id}`;
  const title = thread.title || thread.label;
  // A channel-style externalRef (e.g. 'console') is shared by every capture on that channel,
  // so it never displaces the WI id in the id-chip slot (thread.label) — it renders as its
  // own small tag ahead of the title instead.
  const channelTag = thread.channel
    ? `<span class="opsui-threads__channel-tag">${esc(thread.channel)}</span>`
    : '';

  return (
    `<details class="opsui-threads__card" data-thread-id="${esc(thread.id)}"${thread.externalRef ? ` data-ext-id="${esc(thread.externalRef)}"` : ''}>` +
    `<summary class="opsui-threads__card-summary">` +
    `<span class="opsui-threads__card-id">${esc(thread.label)}</span>` +
    channelTag +
    `<span class="opsui-threads__card-title">${esc(title)}</span>` +
    stateBadge +
    (thread.lastOutTs ? `<span class="opsui-threads__summary-ts">${esc(formatTs(thread.lastOutTs))}</span>` : '') +
    `</summary>` +
    `<div class="opsui-threads__card-body">` +
    `<div class="opsui-threads__card-hdr">` +
    `<a class="opsui-threads__card-label" href="${esc(detailHref)}">${esc(thread.label)}</a>` +
    `</div>` +
    parkSubtitle +
    supersededSubtitle +
    lastReply +
    messageList(thread) +
    replyForm(thread) +
    `</div>` +
    `</details>`
  );
}

// ─── Region renderers ─────────────────────────────────────────────────────────

function glanceRegion(metrics: GlanceMetric[]): string {
  const tiles = metrics.map((m) => MetricTile(m)).join('');
  return Card({
    variant: 'glance',
    title: 'Threads',
    subtitle: 'Founder conversations with the conductor',
    body: `<div class="opsui-glancegrid">${tiles}</div>`,
  });
}

/** Exported so Command can render the SAME paginated, state-badged Conversations region
 *  (nav IA rewire) instead of maintaining its own copy — relocation by import, not copy.
 *  `threads` must be the FULL list (glance/header counts total, not just this page);
 *  slicing to `THREADS_PAGE_SIZE` happens here. `hrefFor` is caller-owned (spec: the
 *  surface owns its query string) since the standalone route and the folded-in Command
 *  region page via different query params. */
export function conversationsRegion(
  threads: ThreadCard[],
  page = 1,
  hrefFor: (p: number) => string = (p) => (p <= 1 ? '/threads' : `/threads?page=${p}`),
): string {
  const total = threads.length;
  const headerAside = StatusBadge({
    state: total ? 'neutral' : 'success',
    label: total ? `${total} thread${total === 1 ? '' : 's'}` : 'No threads',
  });

  if (total === 0) {
    return Card({
      title: 'Conversations',
      subtitle: 'Most recent reply first — reply inline or via the conductor',
      headerAside,
      body: `<p class="opsui-empty">No conversations yet — send a message from the conductor.</p>`,
    });
  }

  const pageCount = Math.max(1, Math.ceil(total / THREADS_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
  const start = (safePage - 1) * THREADS_PAGE_SIZE;
  const pageItems = threads.slice(start, start + THREADS_PAGE_SIZE);
  const pager = Pagination({
    page: safePage,
    pageCount,
    total,
    itemNoun: 'threads',
    label: 'Conversation pages',
    hrefFor,
  });

  return Card({
    title: 'Conversations',
    subtitle: 'Most recent reply first — reply inline or via the conductor',
    headerAside,
    body: pageItems.map(threadCard).join('') + pager,
  });
}

function provenanceRegion<T>(env: ProjectionEnvelope<T>): string {
  const chips = env.evidence
    .map(
      (e) =>
        `<a class="opsui-provenance__chip" data-opsui-action="evidence:${esc(e.id)}"` +
        (e.href ? ` href="${esc(e.href)}"` : '') +
        `>${esc(e.label)}</a>`,
    )
    .join('');
  const meta =
    `fold ${esc(env.foldVersion)} · seq #${esc(String(env.ledgerSequence))} · ` +
    `generated ${esc(env.generatedAt)}`;
  return Card({
    variant: 'inset',
    title: 'Provenance',
    subtitle: 'Every value above traces to the ledger',
    body:
      `<p class="opsui-provenance__meta">${meta}</p>` +
      (chips ? `<div class="opsui-provenance__chips">${chips}</div>` : ''),
  });
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export interface ThreadsProjectionOptions {
  /** 1-based Conversations page (WI-307); defaults to 1. */
  page?: number;
}

/** Render the threads projection workspace from its envelope. A `failed`
 *  envelope renders ProjectionFailure and nothing else. */
export function ThreadsProjection(env: ProjectionEnvelope<ThreadsData>, opts: ThreadsProjectionOptions = {}): string {
  if (env.state === 'failed') {
    const foldEvidence = env.evidence[0];
    return ProjectionFailure({
      projection: 'Threads',
      reason: `fold ${env.foldVersion} did not fold cleanly`,
      lastGoodSequence: env.ledgerSequence,
      lastGoodAt: env.generatedAt,
      retry: 'reactor re-folds on the next beat (30s)',
      ...(foldEvidence
        ? { evidence: { id: foldEvidence.id, label: foldEvidence.label, ...(foldEvidence.href ? { href: foldEvidence.href } : {}) } }
        : {}),
    });
  }

  const d = env.data;
  return (
    `<div class="opsui-threads" data-projection="threads" data-state="${env.state}">` +
    glanceRegion(d.glance) +
    conversationsRegion(d.threads, opts.page ?? 1) +
    provenanceRegion(env) +
    `</div>`
  );
}
