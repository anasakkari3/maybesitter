import { describe, expect, it } from '@jest/globals';
import { NetworkError, WeeklyBlockRefusedError } from '../../../api/errors';
import { userFacingMessageKey } from '../../../api/ui/userFacingMessage';
import type { WeeklyBlock } from '../../../api/schemas/weeklyBlocks';
import { patchFor, validateWeeklyDraft, weeklyErrorKey } from '../weeklyForm';

const BLOCK: WeeklyBlock = {
  id: 'b1', title: 'تدريب', weekdays: [6], start: '10:00', end: '16:00', timezone: 'Asia/Jerusalem', status: 'active', source: 'manual',
  createdAt: '2026-09-29T09:00:00.000Z', updatedAt: '2026-09-29T09:00:00.000Z', confirmedAt: '2026-09-29T09:00:00.000Z', startsOn: '2026-10-01', deviceEvent: null,
};

describe('validateWeeklyDraft', () => {
  const ok = { title: 'Gym', weekdays: [1], start: '07:00', end: '08:00' };
  it('accepts a same-day block', () => expect(validateWeeklyDraft(ok)).toBeNull());
  it('asks for a name and a day', () => {
    expect(validateWeeklyDraft({ ...ok, title: '   ' })).toBe('wbErrNoTitle');
    expect(validateWeeklyDraft({ ...ok, weekdays: [] })).toBe('wbErrNoDay');
  });
  it('says overnight for an end at or before the start', () => {
    expect(validateWeeklyDraft({ ...ok, start: '22:00', end: '06:00' })).toBe('wbErrOvernight');
    expect(validateWeeklyDraft({ ...ok, start: '10:00', end: '10:00' })).toBe('wbErrOvernight');
    expect(validateWeeklyDraft({ ...ok, start: '10:00', end: '10:05' })).toBeNull();
  });
});

describe('patchFor', () => {
  it('names only what changed', () => {
    expect(patchFor(BLOCK, { title: 'تدريب', weekdays: [6], start: '10:00', end: '16:00' })).toEqual({});
    expect(patchFor(BLOCK, { title: ' تدريب قدم ', weekdays: [6], start: '10:00', end: '17:00' })).toEqual({ title: 'تدريب قدم', end: '17:00' });
    expect(patchFor(BLOCK, { title: 'تدريب', weekdays: [6, 0], start: '09:00', end: '16:00' })).toEqual({ weekdays: [0, 6], start: '09:00' });
  });
});

describe('weeklyErrorKey', () => {
  it('says the server\'s overnight refusal in the person\'s words', () => {
    expect(weeklyErrorKey(new WeeklyBlockRefusedError('overnight_not_supported'))).toBe('wbErrOvernight');
    expect(weeklyErrorKey(new WeeklyBlockRefusedError('something_new'))).toBe('errorsGeneric');
    expect(weeklyErrorKey(new NetworkError('x'))).toBe(userFacingMessageKey(new NetworkError('x')));
  });
});
