/**
 * verbs.test.ts — replyToItem: the shared verb behind the console's per-item reply box (and
 * any future CLI reply command). Mirrors the setup style of target-id.test.ts's captureIntent
 * tests: a real on-disk ledger under a temp dir, appended through `withLock`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { fold } from '../src/fold.js';
import { makeEvent } from '../src/schema.js';
import { appendEvents, loadAllEvents } from '../src/ledger.js';
import { replyToItem, captureFeedback, VerbError } from '../src/verbs.js';

function withTempLedger<T>(fn: (ledgerDir: string) => Promise<T>): Promise<T> {
  const base = mkdtempSync(join(tmpdir(), 'loopkit-verbs-reply-'));
  const ledgerDir = join(base, 'ledger');
  return (async () => {
    try {
      return await fn(ledgerDir);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  })();
}

test('replyToItem: appends msg.in and threads it onto ItemRecord.messages', () =>
  withTempLedger(async (ledgerDir) => {
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'add a widget' }),
    ]);
    const res = await replyToItem(ledgerDir, 'WI-001', { text: 'sounds good, go ahead' });
    assert.equal(res.wiId, 'WI-001');

    const events = await loadAllEvents(ledgerDir);
    const msgs = events.filter((e) => e.item === 'WI-001' && e.type === 'msg.in');
    assert.equal(msgs.length, 1);
    assert.equal((msgs[0]?.data as { text?: string }).text, 'sounds good, go ahead');
    assert.equal(msgs[0]?.actor, 'operator');

    const result = fold(events);
    assert.deepEqual(
      result.items.get('WI-001')?.messages.map((m) => m.text),
      ['sounds good, go ahead'],
    );
  }));

test('replyToItem: a caller-supplied actor is stamped instead of the operator default', () =>
  withTempLedger(async (ledgerDir) => {
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'add a widget' }),
    ]);
    await replyToItem(ledgerDir, 'WI-001', { text: 'hello', actor: 'cli' });
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.find((e) => e.type === 'msg.in')?.actor, 'cli');
  }));

test('replyToItem: blank/whitespace-only text is rejected, nothing appended', () =>
  withTempLedger(async (ledgerDir) => {
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'add a widget' }),
    ]);
    await assert.rejects(() => replyToItem(ledgerDir, 'WI-001', { text: '   ' }), VerbError);
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter((e) => e.type === 'msg.in').length, 0);
  }));

test('replyToItem: an id absent from the ledger throws VerbError, nothing appended', () =>
  withTempLedger(async (ledgerDir) => {
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'add a widget' }),
    ]);
    await assert.rejects(() => replyToItem(ledgerDir, 'WI-999', { text: 'hi' }), VerbError);
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.length, 1);
  }));

test('replyToItem: a reply on a terminal (merged) item still threads — messages are not state', () =>
  withTempLedger(async (ledgerDir) => {
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'add a widget' }),
      makeEvent('reactor', 'WI-001', 'item.merged', { commit: 'abc1234' }),
    ]);
    await replyToItem(ledgerDir, 'WI-001', { text: 'nice work' });
    const events = await loadAllEvents(ledgerDir);
    const result = fold(events);
    const rec = result.items.get('WI-001');
    assert.equal(rec?.state, 'merged', 'a reply must never move the item off its current state');
    assert.deepEqual(rec?.messages.map((m) => m.text), ['nice work']);
  }));

test('captureFeedback: appends item.feedback and opens a linked follow-up item via captureIntent', () =>
  withTempLedger(async (ledgerDir) => {
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'add a widget' }),
      makeEvent('reactor', 'WI-001', 'item.merged', { commit: 'abc1234' }),
    ]);
    const res = await captureFeedback(ledgerDir, 'WI-001', { text: 'the widget is the wrong colour' });
    assert.equal(res.wiId, 'WI-001');
    assert.notEqual(res.followUpId, 'WI-001');

    const events = await loadAllEvents(ledgerDir);
    const feedbackEvs = events.filter((e) => e.item === 'WI-001' && e.type === 'item.feedback');
    assert.equal(feedbackEvs.length, 1);
    assert.equal((feedbackEvs[0]?.data as { text?: string }).text, 'the widget is the wrong colour');

    const result = fold(events);
    assert.equal(result.items.get('WI-001')?.state, 'merged', 'feedback must never move the item off merged');
    const followUp = result.items.get(res.followUpId);
    assert.ok(followUp, 'the follow-up item must exist in the fold');
    assert.match(followUp!.sourceText ?? '', /WI-001/, 'the follow-up must reference the origin item');
  }));

test('captureFeedback: attachments are recorded on item.feedback, mirroring captureIntent', () =>
  withTempLedger(async (ledgerDir) => {
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'add a widget' }),
      makeEvent('reactor', 'WI-001', 'item.merged', { commit: 'abc1234' }),
    ]);
    await captureFeedback(ledgerDir, 'WI-001', {
      text: 'the widget is the wrong colour',
      attachments: ['attachments/1-screenshot.png'],
    });

    const events = await loadAllEvents(ledgerDir);
    const feedbackEv = events.find((e) => e.item === 'WI-001' && e.type === 'item.feedback');
    assert.deepEqual((feedbackEv?.data as { attachments?: string[] }).attachments, ['attachments/1-screenshot.png']);
  }));

test('captureFeedback: an item that has not merged is rejected, nothing appended', () =>
  withTempLedger(async (ledgerDir) => {
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'add a widget' }),
    ]);
    await assert.rejects(
      () => captureFeedback(ledgerDir, 'WI-001', { text: 'wrong colour' }),
      VerbError,
    );
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.length, 1, 'no item.feedback and no follow-up capture on a rejected call');
  }));

test('captureFeedback: blank/whitespace-only text is rejected, nothing appended', () =>
  withTempLedger(async (ledgerDir) => {
    await appendEvents(ledgerDir, [
      makeEvent('cli', 'WI-001', 'item.captured', { source: 'cli', text: 'add a widget' }),
      makeEvent('reactor', 'WI-001', 'item.merged', { commit: 'abc1234' }),
    ]);
    await assert.rejects(() => captureFeedback(ledgerDir, 'WI-001', { text: '   ' }), VerbError);
    const events = await loadAllEvents(ledgerDir);
    assert.equal(events.filter((e) => e.type === 'item.feedback').length, 0);
  }));
