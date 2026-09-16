/**
 * Narrowing the list to one category (#415).
 *
 * The case that carries the feature is the last one: a commitment with no
 * category is *not* hidden by every filter. "All" is where it belongs and
 * where the user finds it, and the only alternative — hiding it whenever a
 * filter is on — would mean the day a user taps "Work" the app quietly stops
 * showing them commitments it was never sure about. That is the failure the
 * whole `null`-is-not-a-category decision exists to prevent, and this is where
 * it is visible.
 *
 * The chips are built from the intersection of what the user enabled and what
 * is actually in the list, because a chip that filters to an empty screen is a
 * chip that should not be there. "All" is always first and always present.
 */
import { describe, expect, it } from '@jest/globals';
import { categoryChipsFor, filterByCategory } from '../categoryFilter';
import type { Commitment } from '../../../api/schemas/common';

function commitment(id: string, category: Commitment['category']): Commitment {
  return {
    id,
    kind: 'task',
    title: id,
    description: null,
    person: null,
    status: 'active',
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
    category,
    categorySource: 'inferred',
    timeSpec: { kind: 'due_by', dueAt: '2026-09-13T12:00:00.000Z', endAt: null, remindAt: null, allDay: false, timezone: 'UTC' },
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:00:00.000Z',
    confirmedAt: '2026-09-01T09:00:00.000Z',
    completedAt: null,
    droppedAt: null,
  };
}

const LIST = [
  commitment('a', 'work'),
  commitment('b', 'family'),
  commitment('c', null),
  commitment('d', 'work'),
];

describe('filterByCategory', () => {
  it('shows everything under All, including the uncategorised', () => {
    expect(filterByCategory(LIST, 'all').map((c) => c.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('narrows to one category', () => {
    expect(filterByCategory(LIST, 'work').map((c) => c.id)).toEqual(['a', 'd']);
  });

  it('keeps the order the server sent', () => {
    const reversed = [...LIST].reverse();
    expect(filterByCategory(reversed, 'work').map((c) => c.id)).toEqual(['d', 'a']);
  });

  it('an uncategorised commitment is found under All and nowhere else', () => {
    expect(filterByCategory(LIST, 'all').map((c) => c.id)).toContain('c');
    expect(filterByCategory(LIST, 'work').map((c) => c.id)).not.toContain('c');
    expect(filterByCategory(LIST, 'family').map((c) => c.id)).not.toContain('c');
  });

  it('a category with nothing in it filters to an empty list rather than to everything', () => {
    expect(filterByCategory(LIST, 'health')).toEqual([]);
  });
});

describe('categoryChipsFor', () => {
  it('puts All first and offers only the categories present in the list', () => {
    expect(categoryChipsFor(LIST, ['work', 'family', 'health'])).toEqual(['all', 'work', 'family']);
  });

  it('offers nothing the user turned off, even when the list has it', () => {
    expect(categoryChipsFor(LIST, ['family'])).toEqual(['all', 'family']);
  });

  it('follows the catalog order, not the order the list happens to be in', () => {
    const familyFirst = [commitment('x', 'family'), commitment('y', 'work')];
    expect(categoryChipsFor(familyFirst, ['work', 'family'])).toEqual(['all', 'work', 'family']);
  });

  it('is All alone when nothing in the list is categorised', () => {
    expect(categoryChipsFor([commitment('z', null)], ['work', 'family'])).toEqual(['all']);
  });

  it('is All alone for an empty list, so the bar never claims a category the user cannot see', () => {
    expect(categoryChipsFor([], ['work', 'family'])).toEqual(['all']);
  });
});
