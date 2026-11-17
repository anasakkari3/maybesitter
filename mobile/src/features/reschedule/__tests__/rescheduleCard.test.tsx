/**
 * Lane E4: missed work's new plan on Today. The card says it is a suggestion,
 * changes nothing until «اقبل», words what changed and why from the server's
 * reason (templates, in all three languages), and offers «رجّعها» after.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import { AppProvider } from '../../../state/AppContext';
import { strings } from '../../../i18n/strings';
import { rescheduleListSchema, type RescheduleList } from '../../../api/schemas/reschedule';
import listed from '../../../api/__fixtures__/reschedule.json';
import acceptedFixture from '../../../api/__fixtures__/reschedule.accepted.json';
import { rescheduleLine } from '../rescheduleLine';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'ar', languageTag: 'ar', textDirection: 'rtl' }]),
}));

const mockMutate = jest.fn();
let mockData: RescheduleList | undefined;
jest.mock('../useReschedule', () => ({
  useReschedule: () => ({ data: mockData }),
  useDecideReschedule: () => ({ mutate: mockMutate, isPending: false }),
}));

// Imported after the mock is declared (jest hoists `jest.mock`).
// eslint-disable-next-line import/first
import { RescheduleCard } from '../RescheduleCard';

const t = strings.ar;
const proposalList = rescheduleListSchema.parse(listed);
const acceptedList = rescheduleListSchema.parse(acceptedFixture);

beforeEach(() => { mockMutate.mockClear(); });
afterEach(() => { mockData = undefined; });

describe('RescheduleCard', () => {
  it('shows nothing when there is nothing missed', async () => {
    mockData = { success: true, proposal: null, accepted: [] };
    const view = await render(<AppProvider><RescheduleCard /></AppProvider>);
    expect(view.queryByTestId('reschedule-card')).toBeNull();
    expect(view.queryByTestId('reschedule-accepted')).toBeNull();
  });

  it('says it is a suggestion, says what changed and why, and changes nothing before «اقبل»', async () => {
    mockData = proposalList;
    const view = await render(<AppProvider><RescheduleCard /></AppProvider>);
    expect(view.getByTestId('reschedule-tag')).toBeTruthy();
    expect(view.getByText(t.rsTag)).toBeTruthy();
    expect(view.getByText(t.suggestionNote)).toBeTruthy();
    expect(view.getByText(t.rsLineFirst)).toBeTruthy();
    expect(view.getByTestId('reschedule-session-0')).toBeTruthy();
    expect(mockMutate).not.toHaveBeenCalled();
    await fireEvent.press(view.getByTestId('reschedule-accept'));
    expect(mockMutate).toHaveBeenCalledTimes(1);
    expect(mockMutate.mock.calls[0]![0]).toEqual({
      commitmentId: proposalList.proposal!.commitmentId, action: 'accept', proposalId: proposalList.proposal!.proposalId,
    });
  });

  it('«مش هلّق» dismisses without a proposal id', async () => {
    mockData = proposalList;
    const view = await render(<AppProvider><RescheduleCard /></AppProvider>);
    await fireEvent.press(view.getByTestId('reschedule-dismiss'));
    expect(mockMutate.mock.calls[0]![0]).toEqual({ commitmentId: proposalList.proposal!.commitmentId, action: 'dismiss' });
  });

  it('after accepting, offers «رجّعها»', async () => {
    mockData = acceptedList;
    const view = await render(<AppProvider><RescheduleCard /></AppProvider>);
    expect(view.getByText(t.rsAcceptedLine)).toBeTruthy();
    expect(view.getByText(t.rsUndoHint)).toBeTruthy();
    await fireEvent.press(view.getByTestId('reschedule-undo'));
    expect(mockMutate.mock.calls[0]![0]).toEqual({ commitmentId: acceptedList.accepted[0]!.commitmentId, action: 'undo' });
  });
});

describe('rescheduleLine', () => {
  const base = { fromDayPart: 'evening', toDayPart: 'morning' } as const;
  it.each(['ar', 'en', 'he'] as const)('words every reason in %s, and never says "overdue"', (lang) => {
    const s = strings[lang];
    expect(rescheduleLine({ ...base, reason: 'first_miss', changes: ['new_time'] }, s)).toBe(s.rsLineFirst);
    expect(rescheduleLine({ ...base, reason: 'missed_again', changes: ['smaller_pieces'] }, s)).toBe(s.rsLineSplit);
    expect(rescheduleLine({ ...base, reason: 'deadline_near', changes: ['earlier_start'] }, s)).toBe(s.rsLineEarlier);
    const other = rescheduleLine({ ...base, reason: 'same_time_again', changes: ['other_time_of_day'] }, s);
    expect(other).toContain(s.rsPartEvening);
    expect(other).toContain(s.rsPartMorning);
    const both = rescheduleLine({ ...base, reason: 'same_time_again', changes: ['other_time_of_day', 'smaller_pieces'] }, s);
    expect(both).not.toBe(other);
    for (const line of [other, both, s.rsLineFirst, s.rsLineSplit, s.rsLineEarlier]) {
      expect(line).not.toMatch(/متأخر|overdue|late|באיחור/i);
      expect(line).not.toMatch(/\{/);
    }
  });
});
