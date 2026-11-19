/**
 * Wave E (QA audit de7fcb8, Google-connected pass 2026-11-19): the Gmail row
 * said «آخر 7 أيام من البريد الرئيسي» while the scan it starts, the M5a one,
 * reads every tab of the last 7 days (no `category:` in its query; bulk mail
 * is skipped after reading the labels), and its own confirm says «كل إيميلات
 * آخر 7 أيام، مش بس الرئيسي». The row says what the scan behind it reads.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { screen, waitFor, within } from '@testing-library/react-native';
import { strings } from '../../../i18n/strings';
import { NOW, initialState, prepare, showGoogle, teardown, type M5aHarness } from '../../../__acceptance__/m5a/harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

let harness: M5aHarness | undefined;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(async () => {
  await teardown(harness);
  harness = undefined;
  jest.useRealTimers();
});

describe('the Gmail row names what the scan reads', () => {
  it.each(['ar', 'en', 'he'] as const)('%s: with the M5a scan, all mail of the last 7 days, matching its confirm', async (language) => {
    harness = await prepare(language, initialState({ emailSources: true }));
    await showGoogle(harness);
    await waitFor(() => expect(screen.queryByTestId('email-scan-button')).not.toBeNull());
    const row = within(screen.getByTestId('google-row-gmail'));
    expect(row.queryByText(strings[language].googleGmailBody)).toBeNull();
    expect(row.getByText(strings[language].googleGmailBodyAllMail)).toBeTruthy();
  });

  it('en: with the legacy scan (Primary only), the Primary line stays', async () => {
    harness = await prepare('en', initialState({ emailSources: false }));
    await showGoogle(harness);
    await waitFor(() => expect(screen.queryByTestId('google-gmail-scan')).not.toBeNull());
    expect(within(screen.getByTestId('google-row-gmail')).getByText(strings.en.googleGmailBody)).toBeTruthy();
  });
});
