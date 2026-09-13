/**
 * The Legal group in Settings (UC-4.2, #177).
 *
 * The behaviour worth a test is the absence: with no domain configured the
 * group is not there at all. A greyed-out "Privacy policy" row would still be
 * telling somebody we have one they can read, on the screen they opened
 * *because* they wanted to check.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';
import { AppProvider } from '../../../state/AppContext';
import { LegalLinks } from '../LegalLinks';
import en from '../../../i18n/locales/en.json';
import ar from '../../../i18n/locales/ar.json';
import he from '../../../i18n/locales/he.json';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const BASE = 'EXPO_PUBLIC_LEGAL_BASE_URL';
let saved: string | undefined;
let openBrowser: jest.SpiedFunction<typeof WebBrowser.openBrowserAsync>;

beforeEach(() => {
  saved = process.env[BASE];
  delete process.env[BASE];
  openBrowser = jest.spyOn(WebBrowser, 'openBrowserAsync').mockResolvedValue({ type: 'dismiss' } as never);
});

afterEach(() => {
  if (saved === undefined) delete process.env[BASE];
  else process.env[BASE] = saved;
  jest.restoreAllMocks();
});

async function show() {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider><LegalLinks /></AppProvider>
    </SafeAreaProvider>,
  );
}

describe('with no domain configured', () => {
  it('renders nothing at all', async () => {
    await show();
    expect(screen.queryByText(en.legalSectionTitle)).toBeNull();
    expect(screen.queryByTestId('settings-privacy-policy')).toBeNull();
    expect(screen.queryByTestId('settings-terms')).toBeNull();
  });
});

describe('with a domain configured', () => {
  beforeEach(() => {
    process.env[BASE] = 'https://maybesitter.example';
  });

  it('shows both rows', async () => {
    await show();
    expect(screen.queryByTestId('settings-privacy-policy')).not.toBeNull();
    expect(screen.queryByTestId('settings-terms')).not.toBeNull();
  });

  it('opens the page for the language the app is rendering in', async () => {
    // Not the device's language and not a fixed default: the locale in the URL
    // is the one the screen is actually showing. Under Jest the provider
    // resolves to English (no device locale), so that is what this asserts;
    // `config/__tests__/legalLinks.test.ts` covers ar and he directly.
    await show();
    fireEvent.press(screen.getByTestId('settings-privacy-policy'));
    await waitFor(() => expect(openBrowser).toHaveBeenCalled());
    expect(openBrowser).toHaveBeenCalledWith('https://maybesitter.example/en/privacy');
  });

  it('shows the address when the browser refuses', async () => {
    // Offline, or no browser. A toast saying "something went wrong" would
    // leave somebody with nothing; the address they can write down is more.
    openBrowser.mockRejectedValueOnce(new Error('no browser'));
    await show();
    fireEvent.press(screen.getByTestId('settings-terms'));
    await waitFor(() => expect(screen.queryByTestId('legal-open-failed')).not.toBeNull());
    expect(String(screen.getByTestId('legal-open-failed').props.children)).toContain('/en/terms');
  });

  it('tells a screen reader the row leaves the app', async () => {
    await show();
    expect(screen.queryByLabelText(`${en.legalPrivacyPolicy}. ${en.legalOpensInBrowser}`)).not.toBeNull();
  });
});

describe('the copy', () => {
  it('exists in all three languages', () => {
    for (const bundle of [en, ar, he]) {
      const strings = bundle as unknown as Record<string, string>;
      for (const key of ['legalSectionTitle', 'legalPrivacyPolicy', 'legalTerms',
        'legalOpensInBrowser', 'legalUnavailable']) {
        expect(strings[key]).toBeTruthy();
      }
      // The failure message has to be able to carry the address.
      expect(strings.legalUnavailable).toContain('{url}');
    }
  });
});
