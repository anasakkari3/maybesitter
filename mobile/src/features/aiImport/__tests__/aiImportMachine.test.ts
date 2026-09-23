/**
 * The order the import flow can actually happen in.
 *
 * ── Why a reducer and not five booleans on a screen ──────────────
 *
 * Every step here is a step where something must *not* happen: the clipboard
 * must not be read before the user presses paste, the server must not be called
 * before there is text, and a confirm must not be sent twice. Five independent
 * booleans is five ways for two of those to be true at once. A single status is
 * one.
 */
import { describe, expect, it } from '@jest/globals';
import { acceptedFrom, initialImport, reduceImport, type ImportState } from '../aiImportMachine';

const CANDIDATE = {
  kind: 'fact' as const, category: 'work_study' as const, content: 'Is a nursing student',
  targetDate: null, confidence: 0.9, relation: 'new' as const, relatesToId: null,
};

const PROPOSAL = {
  success: true as const,
  proposalId: 'imp_1',
  assistant: 'chatgpt' as const,
  candidates: [CANDIDATE, { ...CANDIDATE, content: 'Sleeps late', relation: 'conflict' as const, relatesToId: 'mem_9' }],
  summary: { new: 1, updates: 0, conflicts: 1 },
  existingConsidered: 1,
  existingTotal: 1,
  existingTruncated: false,
  createdAt: '2026-09-23T09:00:00.000Z',
  promptVersion: 'ai-context-import-v1',
  model: 'gemini-2.5-flash',
};

function walkToPaste(): ImportState {
  return reduceImport(reduceImport(initialImport, { type: 'pick', assistant: 'chatgpt' }), { type: 'handedOff' });
}

describe('the flow starts with nothing chosen', () => {
  it('begins on the picker with no assistant and no text', () => {
    expect(initialImport.status).toBe('pick');
    expect(initialImport.assistant).toBeNull();
    expect(initialImport.text).toBe('');
  });
});

describe('picking an assistant', () => {
  it('moves to the handoff and remembers which one', () => {
    const next = reduceImport(initialImport, { type: 'pick', assistant: 'gemini' });
    expect(next.status).toBe('handoff');
    expect(next.assistant).toBe('gemini');
  });

  it('records that the assistant could not be opened without leaving the step', () => {
    const picked = reduceImport(initialImport, { type: 'pick', assistant: 'claude' });
    const failed = reduceImport(picked, { type: 'openFailed' });
    expect(failed.status).toBe('handoff');
    expect(failed.openFailed).toBe(true);
  });
});

describe('pasting', () => {
  it('will not read before the user has been handed off', () => {
    // Nothing between `pick` and `handoff` may accept text: the paste button
    // does not exist yet, so text arriving here is a bug somewhere else.
    const pasted = reduceImport(initialImport, { type: 'pasted', text: 'a profile' });
    expect(pasted.status).toBe('pick');
    expect(pasted.text).toBe('');
  });

  it('accepts text once the user is back', () => {
    const pasted = reduceImport(walkToPaste(), { type: 'pasted', text: 'a profile' });
    expect(pasted.status).toBe('paste');
    expect(pasted.text).toBe('a profile');
  });

  it('says so when the clipboard had nothing in it, and keeps any earlier text', () => {
    const pasted = reduceImport(walkToPaste(), { type: 'pasted', text: 'a profile' });
    const empty = reduceImport(pasted, { type: 'pasteEmpty' });
    expect(empty.status).toBe('paste');
    expect(empty.pasteEmpty).toBe(true);
    expect(empty.text).toBe('a profile');
  });

  it('clears the empty notice on the next real paste', () => {
    const empty = reduceImport(walkToPaste(), { type: 'pasteEmpty' });
    const again = reduceImport(empty, { type: 'pasted', text: 'a profile' });
    expect(again.pasteEmpty).toBe(false);
  });
});

describe('reading and reviewing', () => {
  const withText = () => reduceImport(walkToPaste(), { type: 'pasted', text: 'a profile' });

  it('will not read an empty paste', () => {
    const asked = reduceImport(walkToPaste(), { type: 'read' });
    expect(asked.status).toBe('paste');
  });

  it('reads when there is something to read', () => {
    expect(reduceImport(withText(), { type: 'read' }).status).toBe('reading');
  });

  it('moves to review and starts every candidate kept', () => {
    const reviewing = reduceImport(reduceImport(withText(), { type: 'read' }), { type: 'proposed', proposal: PROPOSAL });
    expect(reviewing.status).toBe('review');
    expect(reviewing.kept).toEqual([true, true]);
    expect(reviewing.expanded).toBe(false);
  });

  it('defaults every conflict to keeping both', () => {
    const reviewing = reduceImport(reduceImport(withText(), { type: 'read' }), { type: 'proposed', proposal: PROPOSAL });
    // Index 1 is the conflict. Nothing is resolved until the user says so, and
    // the absence of a choice must mean "destroy nothing".
    expect(reviewing.resolutions[1]).toBe('keep_both');
  });

  it('goes back to the paste step when reading failed', () => {
    const failed = reduceImport(reduceImport(withText(), { type: 'read' }), { type: 'readFailed' });
    expect(failed.status).toBe('paste');
    expect(failed.readFailed).toBe(true);
    expect(failed.text).toBe('a profile');
  });

  it('forgets the pasted text the moment there are candidates', () => {
    // The screen has no further use for it, and the longest piece of text about
    // a person this app holds should not outlive its purpose in a reducer.
    const reviewing = reduceImport(reduceImport(withText(), { type: 'read' }), { type: 'proposed', proposal: PROPOSAL });
    expect(reviewing.text).toBe('');
  });
});

describe('choosing', () => {
  const reviewing = () => reduceImport(
    reduceImport(reduceImport(walkToPaste(), { type: 'pasted', text: 'a profile' }), { type: 'read' }),
    { type: 'proposed', proposal: PROPOSAL },
  );

  it('reveals the rows without changing any choice', () => {
    const expanded = reduceImport(reviewing(), { type: 'expand' });
    expect(expanded.expanded).toBe(true);
    expect(expanded.kept).toEqual([true, true]);
  });

  it('drops one row', () => {
    const toggled = reduceImport(reviewing(), { type: 'toggle', index: 0 });
    expect(toggled.kept).toEqual([false, true]);
  });

  it('records an edit', () => {
    const edited = reduceImport(reviewing(), { type: 'edit', index: 0, content: 'Studies nursing' });
    expect(edited.edits[0]).toBe('Studies nursing');
  });

  it('records a conflict resolution', () => {
    const resolved = reduceImport(reviewing(), { type: 'resolve', index: 1, resolve: 'replace' });
    expect(resolved.resolutions[1]).toBe('replace');
  });

  it('sends only the kept rows, with their edits and resolutions', () => {
    let state = reviewing();
    state = reduceImport(state, { type: 'edit', index: 0, content: 'Studies nursing' });
    state = reduceImport(state, { type: 'resolve', index: 1, resolve: 'replace' });
    expect(acceptedFrom(state)).toEqual([
      { index: 0, content: 'Studies nursing' },
      { index: 1, resolve: 'replace' },
    ]);
  });

  it('sends nothing for a row the user dropped', () => {
    const state = reduceImport(reviewing(), { type: 'toggle', index: 0 });
    expect(acceptedFrom(state).map((entry) => entry.index)).toEqual([1]);
  });

  it('omits an edit that is only whitespace, or the same words back', () => {
    let state = reduceImport(reviewing(), { type: 'edit', index: 0, content: '   ' });
    expect(acceptedFrom(state)[0]).toEqual({ index: 0 });
    state = reduceImport(reviewing(), { type: 'edit', index: 0, content: CANDIDATE.content });
    expect(acceptedFrom(state)[0]).toEqual({ index: 0 });
  });
});
