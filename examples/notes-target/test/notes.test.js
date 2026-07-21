/**
 * notes.test.js — the demo target's gate. `npm test` (node --test) runs these; the loopkit
 * plane runs this exact command in a worktree of the target repo as the deterministic proof.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addNote, listNotes } from '../src/notes.js';

test('addNote appends a note and does not mutate the input', () => {
  const start = [];
  const next = addNote(start, 'buy milk');
  assert.deepEqual(next, ['buy milk']);
  assert.deepEqual(start, [], 'input array must be unchanged (pure function)');
});

test('addNote rejects an empty note', () => {
  assert.throws(() => addNote([], ''), /non-empty string/);
});

test('listNotes returns a copy', () => {
  const notes = addNote([], 'first');
  const listed = listNotes(notes);
  assert.deepEqual(listed, ['first']);
  listed.push('mutation');
  assert.deepEqual(listNotes(notes), ['first'], 'listNotes copy must not leak into internal state');
});
