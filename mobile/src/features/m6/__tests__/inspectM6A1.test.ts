import { describe, expect, it } from '@jest/globals';
import { firstStrongDirection } from '../../../i18n/bidi';
import { needleOf, rankCommitments } from '../../things/searchModel';
import type { Commitment } from '../../../api/schemas/common';

/** Regressions for Codex's M6a-1 Task A inspection r1 (`runs/m6a1-inspectA1`). */
describe('M6A-INSPECT-001 first strong letter skips digits, marks and punctuation', () => {
  it.each<[string, 'ltr' | 'rtl']>([
    ['٣ Dentist', 'ltr'], // «٣ Dentist»
    ['، Dentist', 'ltr'], // «، Dentist»
    ['ً Dentist', 'ltr'], // a haraka first
    ['ֹ Dentist', 'ltr'], // a niqqud first
    ['12 موعد', 'rtl'], // «12 موعد»
    ['(שלום)', 'rtl'], // «(שלום)»
    ['123', 'rtl'], // no letter: the fallback
  ])('%s → %s', (text, expected) => {
    expect(firstStrongDirection(text, 'rtl')).toBe(expected);
  });
});

function item(id: string, over: { postponedUntil?: string; timeSpec?: Partial<Commitment['timeSpec']> }): Commitment {
  return {
    id, kind: 'task', title: `Gym ${id}`, description: null, person: null, status: 'active',
    priority: { level: 'normal', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' },
    category: null, categorySource: 'inferred',
    timeSpec: { kind: 'due_by', dueAt: null, endAt: null, remindAt: null, allDay: false, timezone: 'Asia/Jerusalem', ...over.timeSpec },
    currentAckState: 'not_seen', postponedUntil: over.postponedUntil ?? null,
    createdAt: '2030-01-01T09:00:00.000Z', updatedAt: '2030-01-01T09:00:00.000Z', confirmedAt: '2030-01-01T09:00:00.000Z',
    completedAt: null, droppedAt: null, rank: 0, reasonCodes: [], deviceCalendarLink: null,
  } as unknown as Commitment;
}

describe('M6A-INSPECT-005 local ranking is the server\'s: nearest resolved time to now, postponedUntil first', () => {
  it('an item due tomorrow ranks before one overdue since last year; a postponed item ranks by where it was postponed to', () => {
    const now = Date.parse('2030-03-29T09:00:00.000Z');
    const overdue = item('overdue', { timeSpec: { dueAt: '2029-03-01T09:00:00.000Z' } });
    const tomorrow = item('tomorrow', { timeSpec: { dueAt: '2030-03-30T09:00:00.000Z' } });
    const postponed = item('postponed', { timeSpec: { dueAt: '2029-01-01T09:00:00.000Z' }, postponedUntil: '2030-03-29T12:00:00.000Z' });
    const ranked = rankCommitments([overdue, tomorrow, postponed], [], needleOf('gym'), now).map(c => c.id);
    expect(ranked).toEqual(['postponed', 'tomorrow', 'overdue']);
  });
});
