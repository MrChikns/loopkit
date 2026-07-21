/**
 * notes.js — a tiny, pure notes module.
 *
 * This is the demo TARGET's application code: the smallest thing the loopkit plane can drive
 * (build → gate → merge) in a repo that is NOT the plane's own home. Deliberately dependency-free
 * and pure so the gate (`node --test`) runs anywhere with just Node.
 */

/**
 * Return a new notes array with `text` appended as a note. Pure — never mutates its input.
 * @param {string[]} notes existing notes
 * @param {string} text the note to add
 * @returns {string[]} a new array with the note appended
 */
export function addNote(notes, text) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('addNote: text must be a non-empty string');
  }
  return [...notes, text];
}

/**
 * List notes. Returns a shallow copy so callers can't mutate internal state.
 * @param {string[]} notes
 * @returns {string[]}
 */
export function listNotes(notes) {
  return [...notes];
}
