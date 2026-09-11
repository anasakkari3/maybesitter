import { describe, expect, it } from '@jest/globals';
import { buildTimePatch } from '../timePatch';

// The retired Flutter client sent dueDate and reminderTime on every edit, so
// fixing a typo collapsed a reminder onto the due time. The RN client sends
// only the time field that actually moved, and lets the server carry the lead.
describe('buildTimePatch', () => {
  const twoHoursAhead = { dueAt: '2026-09-20T12:00:00.000Z', remindAt: '2026-09-20T10:00:00.000Z' };

  it('(a) sends no time keys for a title, description or priority edit', () => {
    expect(buildTimePatch(twoHoursAhead)).toEqual({});
  });

  it('(b) moves only dueDate, so the server shifts the reminder by the same delta', () => {
    expect(buildTimePatch(twoHoursAhead, '2026-09-20T13:00:00.000Z')).toEqual({
      dueDate: '2026-09-20T13:00:00.000Z',
    });
  });

  it('(c) sends nothing when the edited time is the same instant as the shown one', () => {
    // Same moment, written with an offset: equality is by instant, not by string.
    expect(buildTimePatch(twoHoursAhead, '2026-09-20T15:00:00+03:00')).toEqual({});
  });

  it('(d) edits reminderTime on an item that has only a reminder', () => {
    expect(buildTimePatch({ dueAt: null, remindAt: '2026-09-20T10:00:00.000Z' }, '2026-09-20T11:00:00.000Z')).toEqual({
      reminderTime: '2026-09-20T11:00:00.000Z',
    });
  });
});
