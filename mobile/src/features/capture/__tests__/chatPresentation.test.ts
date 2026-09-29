import { expect, it } from '@jest/globals';
import type { CaptureProposalItem } from '../../../api/schemas/capture';
import { strings } from '../../../i18n/strings';
import { chatItemPresentation } from '../chatPresentation';

const item: CaptureProposalItem = {
  itemId: 'appointment', title: 'Doctor appointment', resolvedTime: '2026-10-02T06:00:00.000Z',
  needsClarification: false, priority: 'normal', priorityEstimated: true, timeEstimated: true,
};

it('shows the backend start time in the user timezone without inventing an end or duration', () => {
  const row = chatItemPresentation(item, undefined, 'en', 'Asia/Jerusalem', strings.en);
  expect(row.date).toBe('2026-10-02');
  expect(row.subtitle.replace(/[\u2066-\u2069]/g, '')).toContain('09:00');
  expect(row.subtitle).not.toMatch(/[–-]/);
});

it('renders the explicit title, time and priority edits that confirmation will submit', () => {
  const row = chatItemPresentation(item, {
    title: 'Dental appointment', localDateTime: '2026-10-03T10:30', priority: 'high',
  }, 'en', 'Asia/Jerusalem', strings.en);
  expect(row).toMatchObject({ title: 'Dental appointment', date: '2026-10-03', priority: 'high', timeEstimated: false, priorityEstimated: false });
  expect(row.subtitle.replace(/[\u2066-\u2069]/g, '')).toContain('10:30');
});

it('keeps an all-day appointment on its real day when its hour is explicitly cleared', () => {
  const row = chatItemPresentation({ ...item, eventOnDay: true, resolvedDate: '2026-10-02' },
    { localDateTime: '' }, 'ar', 'Asia/Jerusalem', strings.ar);
  expect(row.date).toBe('2026-10-02');
  expect(row.instant).toBeNull();
  expect(row.subtitle).toContain(strings.ar.noTimeYet);
});

it('leaves an unresolved work item untimed instead of implying it follows an appointment', () => {
  const row = chatItemPresentation({ itemId: 'work', title: 'Work', resolvedTime: null, needsClarification: true },
    undefined, 'en', 'UTC', strings.en);
  expect(row.date).toBeUndefined();
  expect(row.subtitle).toBe(strings.en.noTimeYet);
});
