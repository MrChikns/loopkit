import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Button } from '../src/components/Button.ts';
import { Card } from '../src/components/Card.ts';
import { EventRow } from '../src/components/EventRow.ts';
import { IntentComposer, IntentComposerModal } from '../src/components/IntentComposer.ts';
import { MetricTile } from '../src/components/MetricTile.ts';
import { StatusBadge } from '../src/components/StatusBadge.ts';
import { linkifyDecisionRefs } from '../src/render/html.ts';

test('Button renders variant class and escapes its label', () => {
  const html = Button({ label: '<b>go</b>', variant: 'primary' });
  assert.match(html, /class="opsui-btn opsui-btn--primary opsui-btn--md"/);
  assert.match(html, /&lt;b&gt;go&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>go<\/b>/);
});

test('Button carries the action data attribute and disabled flag', () => {
  const html = Button({ label: 'x', action: 'answer:D-1', disabled: true });
  assert.match(html, /data-opsui-action="answer:D-1"/);
  assert.match(html, /disabled/);
});

test('StatusBadge derives colour class from state and always adds a marker', () => {
  const html = StatusBadge({ state: 'critical', label: 'Blocking', emphasis: 'blocking' });
  assert.match(html, /opsui-status--critical/);
  assert.match(html, /opsui-status--blocking/);
  assert.match(html, /opsui-status__marker--diamond/);
  assert.match(html, /data-state="critical"/);
});

test('StatusBadge recommended emphasis uses a star, not success colour', () => {
  const html = StatusBadge({ state: 'info', label: 'Recommended', emphasis: 'recommended' });
  assert.match(html, /opsui-status--info/);
  assert.match(html, /opsui-status__marker--star/);
});

test('Card renders header only when a title or aside is supplied', () => {
  const withHeader = Card({ title: 'T', subtitle: 'S', body: 'B' });
  assert.match(withHeader, /opsui-card__header/);
  assert.match(withHeader, /opsui-card__title">T</);
  assert.match(withHeader, /opsui-card__subtitle">S</);

  const bodyOnly = Card({ body: 'B', variant: 'inset' });
  assert.doesNotMatch(bodyOnly, /opsui-card__header/);
  assert.match(bodyOnly, /opsui-card--inset/);
});

test('MetricTile is an actionable button with an open target', () => {
  const html = MetricTile({
    label: 'Latency',
    value: '4.2s',
    footnote: 'p95',
    state: 'success',
    open: { kind: 'projection', id: 'observability' },
  });
  assert.match(html, /^<button/);
  assert.match(html, /data-opsui-action="projection:observability"/);
  assert.match(html, /opsui-metric--success/);
  assert.match(html, /opsui-metric__value">4.2s</);
});

test('linkifyDecisionRefs renders plain escaped text (no anchor) with no base configured', () => {
  const html = linkifyDecisionRefs('See D-42 & <D-99>');
  assert.match(html, /See D-42 &amp; &lt;D-99&gt;/);
  assert.doesNotMatch(html, /<a/);
  assert.doesNotMatch(html, /opsui-dref/);
});

test('linkifyDecisionRefs links each D-NNN to the caller-provided base when configured', () => {
  const html = linkifyDecisionRefs('D-42 and D-7', { drefBaseHref: '/company#' });
  assert.match(html, /<a class="opsui-dref" href="\/company#d-42">D-42<\/a>/);
  assert.match(html, /<a class="opsui-dref" href="\/company#d-7">D-7<\/a>/);
});

test('linkifyDecisionRefs escapes both the surrounding text and the base href', () => {
  const html = linkifyDecisionRefs('<script>D-1', { drefBaseHref: '/c#"x' });
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /href="\/c#&quot;xd-1"/);
});

test('EventRow summary renders D-NNN plain when no drefBaseHref is passed', () => {
  const html = EventRow({ state: 'neutral', title: 'WI-9', metadata: [], summary: 'blocked by D-5' });
  assert.match(html, /opsui-eventrow__summary">blocked by D-5</);
  assert.doesNotMatch(html, /opsui-dref/);
});

test('EventRow summary linkifies D-NNN when drefBaseHref is supplied', () => {
  const html = EventRow({
    state: 'neutral',
    title: 'WI-9',
    metadata: [],
    summary: 'blocked by D-5',
    drefBaseHref: '/company#',
  });
  assert.match(html, /<a class="opsui-dref" href="\/company#d-5">D-5<\/a>/);
});

test('EventRow rail colour class follows state and appends the evidence action', () => {
  const html = EventRow({
    state: 'success',
    title: 'WI-1',
    metadata: ['shipped', '11:00'],
    badge: { state: 'success', label: 'Delivered' },
    evidence: { id: 'r1', label: 'Deploy receipt' },
  });
  assert.match(html, /opsui-eventrow--success/);
  assert.match(html, /opsui-eventrow__rail/);
  assert.match(html, /data-opsui-action="evidence:r1"/);
  assert.match(html, /Deploy receipt/);
  assert.match(html, /opsui-eventrow__metaitem">shipped</);
});

test('IntentComposer renders multipart form with file input and count chip', () => {
  const html = IntentComposer({ action: '/intent' });
  assert.match(html, /enctype="multipart\/form-data"/);
  assert.match(html, /name="attachment"/);
  assert.match(html, /type="file"/);
  assert.match(html, /accept="image\/\*/);
  assert.match(html, /opsui-composer__count/);
  assert.match(html, /opsui-composer__chips/);
  assert.match(html, /opsui-composer__file-label/);
});

test('IntentComposer escapes action URL and capturedId', () => {
  const html = IntentComposer({ action: '/intent?next=/command', capturedId: 'WI-<1>' });
  assert.match(html, /opsui-composer__captured/);
  assert.match(html, /WI-&lt;1&gt;/);
  assert.doesNotMatch(html, /WI-<1>/);
});

test('IntentComposer captured chip is PLAIN TEXT (no anchor) when capturedHref is absent', () => {
  const html = IntentComposer({ action: '/intent', capturedId: 'WI-42' });
  assert.match(html, /opsui-composer__captured/);
  assert.match(html, /<strong>WI-42<\/strong>/);
  // No hardcoded/dead link: the chip must not become an anchor without an app-resolved href.
  assert.doesNotMatch(html, /opsui-composer__captured-link/);
  assert.doesNotMatch(html, /<a[^>]*WI-42/);
});

test('IntentComposer captured chip links to the app-resolved capturedHref when provided', () => {
  const html = IntentComposer({ action: '/intent', capturedId: 'WI-42', capturedHref: '/item/WI-42' });
  assert.match(html, /<a class="opsui-composer__captured-link" href="\/item\/WI-42"><strong>WI-42<\/strong><\/a>/);
});

test('IntentComposer escapes capturedHref', () => {
  const html = IntentComposer({ action: '/intent', capturedId: 'WI-1', capturedHref: '/item/"onmouseover=x' });
  assert.match(html, /href="\/item\/&quot;onmouseover=x"/);
  assert.doesNotMatch(html, /href="\/item\/"onmouseover/);
});

test('IntentComposerModal ships hidden as a labelled dialog wrapping the form, with a close affordance', () => {
  const html = IntentComposerModal({ action: '/intent?next=/missions' });
  assert.match(html, /data-opsui-shell="composer"[^>]* hidden/);
  assert.match(html, /role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, /aria-label="Drop intent"/);
  assert.match(html, /data-opsui-shell="composer-close"/);
  assert.match(html, /class="opsui-composer-modal__backdrop" data-opsui-shell="composer-close"/);
  assert.match(html, /class="opsui-composer-modal__close"[^>]*data-opsui-shell="composer-close"[^>]*aria-label="[^"]+"/);
  // The composer form itself is nested inside, action preserved.
  assert.match(html, /class="opsui-composer"[\s\S]*action="\/intent\?next=\/missions"/);
  // Namespaced field ids: a page can carry both the modal AND another IntentComposer
  // instance (e.g. the Command page's own inline composer) without a duplicate-id collision.
  assert.match(html, /id="opsui-modal-intent"/);
  assert.doesNotMatch(html, /id="opsui-intent"/);
});

test('IntentComposerModal forwards capturedHref through to the nested composer chip', () => {
  const html = IntentComposerModal({ action: '/intent', capturedId: 'WI-7', capturedHref: '/item/WI-7' });
  assert.match(html, /<a class="opsui-composer__captured-link" href="\/item\/WI-7"><strong>WI-7<\/strong><\/a>/);
});

test('IntentComposer defaults to the unprefixed field ids when idPrefix is omitted', () => {
  const html = IntentComposer({ action: '/intent' });
  assert.match(html, /id="opsui-intent"/);
  assert.match(html, /id="opsui-attachment"/);
});
