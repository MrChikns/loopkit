// Item hub projection — WI-349 Slice 1.
// One canonical per-item page: state header → actions → timeline → conversation →
// evidence. Composed ONLY from shared components + the SAME region renderers the
// timeline/thread-detail/artifacts pages already use (maximal reuse — no copy-pasted
// markup). A failed envelope renders ProjectionFailure and nothing else;
// every region below renders an honest empty state on its own, never a crash, for
// items with no thread / no artifacts / a terminal state.

import { Card } from '../components/Card.ts';
import { EventRow, type EventRowMetaItem } from '../components/EventRow.ts';
import { ProjectionFailure } from '../components/ProjectionFailure.ts';
import { StatusBadge } from '../components/StatusBadge.ts';
import { esc } from '../render/html.ts';
import type { ProjectionEnvelope } from './projection-types.ts';
import type { ItemHubData, ItemHubHeader } from './item-hub-adapter.ts';
import { timelineRegion } from './timeline-projection.ts';
import { ThreadDetailProjection } from './thread-detail-projection.ts';
import { artifactRow } from './artifacts-projection.ts';

// ─── Region renderers ─────────────────────────────────────────────────────────

function headerRegion(h: ItemHubHeader): string {
  const metadata: EventRowMetaItem[] = [];
  if (h.tier) metadata.push(`tier: ${h.tier}`);
  if (h.model) metadata.push(`model: ${h.model}`);
  metadata.push(h.touches.length ? `${h.touches.length} touch${h.touches.length === 1 ? '' : 'es'}` : 'no touches');
  if (h.createdAt) metadata.push(`created ${h.createdAt}`);
  if (h.updatedAt) metadata.push(`updated ${h.updatedAt}`);

  const touchesList = h.touches.length
    ? `<ul class="opsui-itemhub__touches">${h.touches.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`
    : `<p class="opsui-empty">No file touches recorded.</p>`;

  const body =
    EventRow({
      state: h.operationalState,
      title: h.spec ?? h.id,
      metadata,
      // Park reason renders as the row summary — EventRow link-sweeps any D-NNN mention
      // inside it to the Knowledge decision anchor (linkifyDecisionRefs, WI-349).
      ...(h.parkReason ? { summary: h.parkReason } : {}),
      badge: { state: h.operationalState, label: h.stateLabel },
      ...(h.origin ? { originChip: h.origin } : {}),
    }) + touchesList;

  return Card({
    title: h.id,
    subtitle: 'State, tier, origin, model and touches — the fold summary for this item',
    headerAside: StatusBadge({ state: h.operationalState, label: h.stateLabel }),
    body,
  });
}

function actionsRegion(actions: ItemHubData['actions']): string {
  if (actions.length === 0) {
    return Card({
      title: 'Actions',
      subtitle: 'Verbs valid for the current state',
      body: `<p class="opsui-empty">No action needed right now.</p>`,
    });
  }
  const buttons = actions
    .map((a) => {
      if (!a.form) return '';
      const btnClass = `opsui-btn opsui-btn--${a.emphasis === 'primary' ? 'primary' : a.emphasis === 'danger' ? 'danger' : 'secondary'} opsui-btn--sm`;
      const confirmAttr = a.form.confirm ? ` data-opsui-confirm="${esc(a.form.confirm)}"` : '';
      return (
        `<form class="opsui-itemhub__actionform" method="post" action="${esc(a.form.action)}"${confirmAttr}>` +
        `<input type="hidden" name="intent" value="${esc(a.form.intent)}">` +
        `<button class="${btnClass}" type="submit">${esc(a.label)}</button></form>`
      );
    })
    .join('');
  return Card({
    title: 'Actions',
    subtitle: 'Verbs valid for the current state',
    body: `<div class="opsui-itemhub__actions">${buttons}</div>`,
  });
}

function conversationRegion(thread: ItemHubData['thread']): string {
  if (!thread) {
    return Card({
      title: 'Conversation',
      subtitle: 'Founder ↔ conductor messages for this item',
      body: `<p class="opsui-empty">This item has no conversation thread — it was captured without a founder message, or the thread is not yet synced.</p>`,
    });
  }
  return ThreadDetailProjection(thread);
}

function evidenceRegion(data: ItemHubData): string {
  const { artifacts, artifactsTruncated, deployReceipt } = data;
  const artifactsBody = artifacts.length === 0
    ? `<p class="opsui-empty">No build artifacts yet for this item.</p>`
    : artifacts.map(artifactRow).join('') +
      (artifactsTruncated ? `<p class="opsui-empty">Showing the newest ${artifacts.length} — older artifacts exist but are capped.</p>` : '');

  const deployBody = deployReceipt
    ? EventRow({
        state: 'success',
        title: 'Deploy receipt',
        metadata: [deployReceipt.commit.slice(0, 7)],
        badge: { state: 'success', label: deployReceipt.deployed ? 'deployed' : 'merged' },
      })
    : `<p class="opsui-empty">No deploy receipt yet.</p>`;

  return Card({
    title: 'Evidence',
    subtitle: 'Gate logs, diffs, salvage patches and the deploy receipt for this item',
    headerAside: StatusBadge({
      state: artifacts.length ? 'neutral' : 'success',
      label: artifacts.length ? `${artifacts.length}${artifactsTruncated ? '+' : ''} artifacts` : 'None yet',
    }),
    body: artifactsBody + deployBody,
  });
}

function provenanceRegion(env: ProjectionEnvelope<ItemHubData>): string {
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

/** Render the item hub from its envelope: state header → actions → timeline →
 *  conversation → evidence, top to bottom (spec order). A `failed` envelope renders
 *  ProjectionFailure and nothing else. */
export function ItemHubProjection(env: ProjectionEnvelope<ItemHubData>): string {
  if (env.state === 'failed') {
    const foldEvidence = env.evidence[0];
    return ProjectionFailure({
      projection: 'Item hub',
      reason: `fold ${env.foldVersion} did not fold cleanly`,
      lastGoodSequence: env.ledgerSequence,
      lastGoodAt: env.generatedAt,
      retry: 'wire-up re-reads the fold on the next request',
      ...(foldEvidence
        ? { evidence: { id: foldEvidence.id, label: foldEvidence.label, ...(foldEvidence.href ? { href: foldEvidence.href } : {}) } }
        : {}),
    });
  }

  const d = env.data;
  return (
    `<div class="opsui-itemhub" data-projection="item-hub" data-state="${env.state}">` +
    headerRegion(d.header) +
    actionsRegion(d.actions) +
    timelineRegion(d.timeline, false) +
    conversationRegion(d.thread) +
    evidenceRegion(d) +
    provenanceRegion(env) +
    `</div>`
  );
}
