import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { screen, waitFor } from '@testing-library/react-native';
import { NOW, initialState, prepare, showKnows, teardown, type M5bHarness } from '../../../__acceptance__/m5b/harness';
import { memorySummaryResponseSchema } from '../../../api/schemas/m5b';
import en from '../../../i18n/locales/en.json';
import ar from '../../../i18n/locales/ar.json';
import he from '../../../i18n/locales/he.json';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

/**
 * Staging 2026-11-20 (qa-v3-recheck1120): the summary came back
 * `unavailable` with no word on screen about why; it was the per-user minute
 * cap. A refusal the person can act on now carries a `reason`, and the
 * memory card says it in one honest line above the rows. With no reason the
 * card is unchanged: the rows, no paragraph, no apology.
 */
let harness: M5bHarness | undefined;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(async () => {
  await teardown(harness);
  harness = undefined;
  jest.useRealTimers();
});

const REASONS = [
  ['busy_now', 'm5bSummaryBusyNow'],
  ['daily_cap', 'm5bSummaryDailyCap'],
  ['monthly_cap', 'm5bSummaryMonthlyCap'],
  ['not_included', 'm5bSummaryNotIncluded'],
] as const;

describe('the summary schema', () => {
  it('reads each reason and a bare unavailable; refuses a reason it does not know', () => {
    for (const [reason] of REASONS) {
      expect(memorySummaryResponseSchema.safeParse({ success: true, summary: { status: 'unavailable', reason } }).success).toBe(true);
    }
    expect(memorySummaryResponseSchema.safeParse({ success: true, summary: { status: 'unavailable' } }).success).toBe(true);
    expect(memorySummaryResponseSchema.safeParse({ success: true, summary: { status: 'unavailable', reason: 'other' } }).success).toBe(false);
    expect(memorySummaryResponseSchema.safeParse({ success: true, summary: { status: 'empty', reason: 'busy_now' } }).success).toBe(false);
  });

  it('has every reason line in all three languages', () => {
    for (const [, key] of REASONS) {
      for (const locale of [en, ar, he] as unknown as Array<Record<string, string>>) {
        expect(typeof locale[key]).toBe('string');
        expect(locale[key]!.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('an unavailable summary with a reason', () => {
  for (const [reason, key] of REASONS) {
    it(`says ${reason} in one line and keeps the rows`, async () => {
      harness = await prepare('en', initialState({ summary: { status: 'unavailable', reason } }));
      await showKnows(harness);
      await waitFor(() => expect(screen.queryByTestId('memory-summary-unavailable')).not.toBeNull());
      expect(screen.getByTestId('memory-summary-unavailable').props.children).toBe((en as unknown as Record<string, string>)[key]);
      expect(screen.queryByTestId('memory-item-memory-1')).not.toBeNull();
      expect(screen.queryByTestId('memory-summary')).toBeNull();
    });
  }

  it('says nothing when the answer carries no reason', async () => {
    harness = await prepare('en', initialState({ summary: { status: 'unavailable' } }));
    await showKnows(harness);
    await waitFor(() => expect(screen.queryByTestId('memory-item-memory-1')).not.toBeNull());
    expect(screen.queryByTestId('memory-summary-unavailable')).toBeNull();
    expect(screen.queryByTestId('memory-summary')).toBeNull();
  });
});
