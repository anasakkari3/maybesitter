/**
 * Only what the user actually changed is sent (UC-2.4, #164).
 *
 * The diff decides the confirm request, so it is checkable as a function of two
 * objects rather than inferred from a screen.
 */
import { describe, expect, it } from '@jest/globals';
import { diffEdits, importanceLabelFor, instantFromLocalEdit } from '../diffEdits';
import type { CaptureProposal } from '../../../api/schemas/capture';

const proposal: CaptureProposal = {
  version: 'v1',
  proposalId: 'p1',
  status: 'proposed',
  items: [
    {
      itemId: 'a',
      title: 'Call the clinic',
      resolvedTime: '2026-09-15T07:00:00.000Z',
      needsClarification: false,
      priority: 'normal',
      priorityEstimated: true,
    },
    {
      itemId: 'b',
      title: 'Pay the bill',
      resolvedTime: '2026-09-15T16:00:00.000Z',
      needsClarification: false,
      priority: 'high',
      priorityEstimated: false,
    },
  ],
};

const BERLIN = 'Europe/Berlin';
const all = ['a', 'b'];

describe('diffEdits', () => {
  it('sends nothing when nothing changed', () => {
    expect(diffEdits(proposal, {}, all, BERLIN)).toEqual([]);
  });

  it('sends nothing when an edit matches what the server already proposed', () => {
    // Retyping the same title is not a change, and sending it would ask the
    // server to re-validate a value it produced itself.
    const edits = { a: { title: 'Call the clinic' }, b: { priority: 'high' as const } };
    expect(diffEdits(proposal, edits, all, BERLIN)).toEqual([]);
  });

  it('sends only the fields that changed', () => {
    const edits = { a: { title: 'Ring the clinic', priority: 'high' as const } };
    expect(diffEdits(proposal, edits, all, BERLIN)).toEqual([
      { itemId: 'a', title: 'Ring the clinic', priority: 'high' },
    ]);
  });

  it('trims a title before comparing, so whitespace alone is not a change', () => {
    expect(diffEdits(proposal, { a: { title: '  Call the clinic  ' } }, all, BERLIN)).toEqual([]);
  });

  it('drops edits for items the user deselected', () => {
    const edits = { a: { title: 'Ring the clinic' }, b: { title: 'Settle the bill' } };
    expect(diffEdits(proposal, edits, ['a'], BERLIN)).toEqual([
      { itemId: 'a', title: 'Ring the clinic' },
    ]);
  });

  it('drops edits for items that are not in the proposal at all', () => {
    expect(diffEdits(proposal, { ghost: { title: 'x' } }, ['ghost'], BERLIN)).toEqual([]);
  });

  it('treats the No time switch as a change to null', () => {
    // An empty string is the switch; `undefined` is "not edited". The two must
    // not collapse, or clearing a time would silently do nothing.
    expect(diffEdits(proposal, { a: { localDateTime: '' } }, all, BERLIN)).toEqual([
      { itemId: 'a', resolvedTime: null },
    ]);
  });

  it('resolves a picked wall clock in the device zone', () => {
    // 09:00 in Europe/Berlin on 2026-09-15 is 07:00Z — which is what the server
    // already proposed, so this is not a change.
    expect(diffEdits(proposal, { a: { localDateTime: '2026-09-15T09:00' } }, all, BERLIN)).toEqual([]);

    expect(diffEdits(proposal, { a: { localDateTime: '2026-09-15T10:30' } }, all, BERLIN)).toEqual([
      { itemId: 'a', resolvedTime: '2026-09-15T08:30:00.000Z' },
    ]);
  });

  it('drops an unparseable time rather than sending something else', () => {
    // A wrong instant is worse than no edit.
    expect(diffEdits(proposal, { a: { localDateTime: 'next tuesday' } }, all, BERLIN)).toEqual([]);
  });

  it('sorts by item id, so collection order cannot change the request', () => {
    // The server's idempotency key is a hash of the edits; two confirms that
    // differ only in ordering must share it rather than persisting twice.
    const edits = { b: { title: 'Settle the bill' }, a: { title: 'Ring the clinic' } };
    expect(diffEdits(proposal, edits, all, BERLIN).map(edit => edit.itemId)).toEqual(['a', 'b']);
  });

  it('handles a null proposal without throwing', () => {
    expect(diffEdits(null, { a: { title: 'x' } }, ['a'], BERLIN)).toEqual([]);
  });
});

describe('instantFromLocalEdit', () => {
  it('keeps the wall clock the user picked, in their own zone', () => {
    expect(instantFromLocalEdit('2026-09-15T09:00', 'Europe/Berlin')).toBe('2026-09-15T07:00:00.000Z');
    expect(instantFromLocalEdit('2026-09-15T09:00', 'UTC')).toBe('2026-09-15T09:00:00.000Z');
    expect(instantFromLocalEdit('2026-09-15T09:00', 'Asia/Jerusalem')).toBe('2026-09-15T06:00:00.000Z');
  });

  it('uses the offset in force at that moment, not today\'s', () => {
    // Berlin is +02:00 in September and +01:00 in January. A single-pass
    // conversion is a one-hour error twice a year, on exactly the days a
    // reminder matters.
    expect(instantFromLocalEdit('2026-01-15T09:00', 'Europe/Berlin')).toBe('2026-01-15T08:00:00.000Z');
  });

  it('refuses anything that is not a local wall clock', () => {
    for (const bad of ['', 'tomorrow', '2026-09-15', '2026-09-15T09:00:00.000Z', '2026-9-5T9:00']) {
      expect(instantFromLocalEdit(bad, 'UTC')).toBeNull();
    }
  });

  it('refuses an unusable zone rather than guessing one', () => {
    expect(instantFromLocalEdit('2026-09-15T09:00', 'Mars/Phobos')).toBeNull();
  });
});

describe('importanceLabelFor', () => {
  it('maps the three levels the review screen shows', () => {
    expect(importanceLabelFor('high')).toBe('must');
    expect(importanceLabelFor('normal')).toBe('should');
    expect(importanceLabelFor('low')).toBe('nice');
    // An absent level is Should, not a crash: an older server may not send one.
    expect(importanceLabelFor(undefined)).toBe('should');
  });
});
