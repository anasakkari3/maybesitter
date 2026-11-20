import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, screen, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
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

/* ── review of #885 ─────────────────────────────────────────────────── */

const SUMMARY = /^\/api\/mobile\/memory\/summary$/;
const requests = () => harness!.server.matching('GET', SUMMARY).length;

describe('what each line means', () => {
  const locales = { en, ar, he } as unknown as Record<string, Record<string, string>>;
  const meaning: Record<string, Record<string, RegExp[]>> = {
    m5bSummaryBusyNow: { en: [/minute/i], ar: [/دقيقة/], he: [/דקה/] },
    m5bSummaryDailyCap: { en: [/today/i, /tomorrow/i], ar: [/اليوم/, /بكرا/], he: [/היום/, /מחר/] },
    m5bSummaryMonthlyCap: { en: [/month/i, /next month/i], ar: [/لهالشهر/, /الشهر الجاي/], he: [/לחודש הזה/, /החודש הבא/] },
    m5bSummaryNotIncluded: { en: [/Features/], ar: [/«الميزات»/], he: [/«תכונות»/] },
  };
  it('says when it clears, or where to look', () => {
    for (const [key, byLocale] of Object.entries(meaning)) {
      for (const [locale, patterns] of Object.entries(byLocale)) {
        for (const pattern of patterns) expect([key, locale, locales[locale]![key]]).toEqual([key, locale, expect.stringMatching(pattern)]);
      }
    }
  });
});

describe('a refusal with a reason is not a final answer', () => {
  it('busy_now asks once more after a minute, and only once', async () => {
    harness = await prepare('en', initialState({ summary: { status: 'unavailable', reason: 'busy_now' } }));
    await showKnows(harness);
    await waitFor(() => expect(screen.queryByTestId('memory-summary-unavailable')).not.toBeNull());
    expect(requests()).toBe(1);
    await act(async () => { await jest.advanceTimersByTimeAsync(59_000); });
    expect(requests()).toBe(1);
    await act(async () => { await jest.advanceTimersByTimeAsync(7_000); });
    await waitFor(() => expect(requests()).toBe(2));
    await act(async () => { await jest.advanceTimersByTimeAsync(10 * 60_000); });
    expect(requests()).toBe(2);
  });

  it('a later mount asks again for a refusal with a reason, never for a bare unavailable', async () => {
    for (const [summary, expected] of [
      [{ status: 'unavailable', reason: 'daily_cap' }, 2],
      [{ status: 'unavailable' }, 1],
    ] as const) {
      harness = await prepare('en', initialState({ summary: summary as Record<string, unknown> }));
      const first = await showKnows(harness);
      await waitFor(() => expect(screen.queryByTestId('memory-item-memory-1')).not.toBeNull());
      await waitFor(() => expect(requests()).toBe(1));
      first.unmount();
      await showKnows(harness);
      await waitFor(() => expect(screen.queryByTestId('memory-item-memory-1')).not.toBeNull());
      await act(async () => { await jest.advanceTimersByTimeAsync(1_000); });
      expect([summary, requests()]).toEqual([summary, expected]);
      await teardown(harness);
      harness = undefined;
    }
  });
});

describe('the line reaches a screen reader', () => {
  it('sits in a polite live region and is announced on iOS', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
    announce.mockClear();
    try {
      harness = await prepare('en', initialState({ summary: { status: 'unavailable', reason: 'monthly_cap' } }));
      await showKnows(harness);
      await waitFor(() => expect(screen.queryByTestId('memory-summary-unavailable')).not.toBeNull());
      let node: { props: Record<string, unknown> } | null = screen.getByTestId('memory-summary-unavailable') as never;
      let polite = false;
      while (node) {
        if (node.props.accessibilityLiveRegion === 'polite') { polite = true; break; }
        node = (node as unknown as { parent: typeof node }).parent;
      }
      expect(polite).toBe(true);
      expect(announce).toHaveBeenCalledWith(en.m5bSummaryMonthlyCap);
    } finally {
      announce.mockRestore();
    }
  });
});
