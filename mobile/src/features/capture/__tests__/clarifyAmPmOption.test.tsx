/**
 * «أي 5 قصدت؟» is answered in the reader's words, not the server's (UAT r6, shot 582).
 *
 * The am/pm question's two options arrive as `labelKey: 'amPmOption'` with
 * `labelParams: { hour, period: 'am' | 'pm' }`. The phone used to render them
 * through one template, `{hour} {period}`, in every language — so the server's
 * internal token went straight onto the chip, and an Arabic reader was offered
 * «am 5» / «pm 5» (bidi put the Latin word first). `clarificationCopy.ts`
 * promises that nothing the server sends is ever displayed; `period` is a
 * token, and these pin that it is turned into the phone's own words:
 *
 *   ar  «5 الصبح» / «5 المسا»   — the words the other clarify chips use
 *   en  «5 am» / «5 pm»
 *   he  «5 בבוקר» / «5 בערב»
 *
 * The expected strings are written out here, not read from the locale files,
 * so a template that goes back to echoing `{period}` cannot pass by agreeing
 * with itself.
 *
 * A `period` this build does not know is not shown at all: the chip is left
 * out, as an unknown label key already is. Falling back to the hour alone would
 * offer two chips that both read «5» and apply different times — a guess
 * dressed as a choice — and the sheet's skip pill keeps the question from
 * becoming a wall.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { cleanup, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider } from '../../../state/AppContext';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import { ClarifySheet } from '../ClarifySheet';
import { optionLabel } from '../clarificationCopy';
import type { CaptureProposalItem } from '../../../api/schemas/capture';
import ar from '../../../i18n/locales/ar.json';
import en from '../../../i18n/locales/en.json';
import he from '../../../i18n/locales/he.json';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const LOCALES = { ar, en, he } as unknown as Record<'ar' | 'en' | 'he', Record<string, string>>;

const EXPECTED = {
  ar: { question: 'أي 5 قصدت؟', am: '5 الصبح', pm: '5 المسا' },
  en: { question: 'Which 5 did you mean?', am: '5 am', pm: '5 pm' },
  he: { question: 'לאיזו 5 התכוונת?', am: '5 בבוקר', pm: '5 בערב' },
} as const;

const day = '2099-01-02';

function amPmItem(periods: { optionId: string; period: string; localTime: string }[]): CaptureProposalItem {
  return {
    itemId: 'item-bank',
    title: 'أروح عالبنك',
    resolvedTime: null,
    needsClarification: true,
    clarification: {
      questionId: 'q-ampm',
      field: 'time_period',
      questionKey: 'ask_am_pm',
      params: { hour: '5', title: 'أروح عالبنك' },
      options: periods.map(({ optionId, period, localTime }) => ({
        optionId,
        labelKey: 'amPmOption',
        labelParams: { hour: '5', period },
        value: { localTime, localDate: day },
      })),
      allowFreeText: false,
    },
  } as unknown as CaptureProposalItem;
}

const BOTH = [
  { optionId: 'am', period: 'am', localTime: '05:00' },
  { optionId: 'pm', period: 'pm', localTime: '17:00' },
];

async function show(lang: 'ar' | 'en' | 'he', item: CaptureProposalItem) {
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <ClarifySheet item={item} position={1} total={1} busy={false} onAnswer={() => {}} onSkip={() => {}} />
      </AppProvider>
    </SafeAreaProvider>,
  );
  // The stored language is read asynchronously; wait until the sheet speaks it.
  await waitFor(() => expect(screen.getByTestId('clarify-question')).toHaveTextContent(EXPECTED[lang].question));
}

beforeEach(async () => {
  await AsyncStorage.clear();
});

afterEach(async () => {
  await cleanup();
  await AsyncStorage.clear();
});

describe('the am/pm chips', () => {
  for (const lang of ['ar', 'en', 'he'] as const) {
    it(`${lang}: reads «${EXPECTED[lang].am}» / «${EXPECTED[lang].pm}», never the raw period`, async () => {
      await show(lang, amPmItem(BOTH));
      const am = screen.getByTestId('clarify-option-am');
      const pm = screen.getByTestId('clarify-option-pm');
      expect(am).toHaveTextContent(EXPECTED[lang].am);
      expect(pm).toHaveTextContent(EXPECTED[lang].pm);
      // What VoiceOver / TalkBack announce is the same localised words.
      expect(am.props.accessibilityLabel).toBe(EXPECTED[lang].am);
      expect(pm.props.accessibilityLabel).toBe(EXPECTED[lang].pm);
      if (lang !== 'en') {
        // No Latin letters inside an Arabic or Hebrew chip: the defect was «am 5».
        expect(am.props.accessibilityLabel).not.toMatch(/[a-z]/i);
        expect(pm.props.accessibilityLabel).not.toMatch(/[a-z]/i);
      }
    });
  }

  it('an unknown period is never shown: that chip is left out, the known one stays', async () => {
    await show('ar', amPmItem([
      { optionId: 'am', period: 'am', localTime: '05:00' },
      { optionId: 'odd', period: 'noon', localTime: '12:00' },
    ]));
    expect(screen.getByTestId('clarify-option-am')).toHaveTextContent(EXPECTED.ar.am);
    expect(screen.queryByTestId('clarify-option-odd')).toBeNull();
    expect(screen.queryByText(/noon/)).toBeNull();
    // The question is not a wall: skipping it is still offered.
    expect(screen.getByTestId('clarify-skip')).toBeTruthy();
  });
});

describe('optionLabel for amPmOption', () => {
  for (const lang of ['ar', 'en', 'he'] as const) {
    it(`${lang}: maps each known period to the phone's words`, () => {
      expect(optionLabel('amPmOption', { hour: '5', period: 'am' }, LOCALES[lang])).toBe(EXPECTED[lang].am);
      expect(optionLabel('amPmOption', { hour: '5', period: 'pm' }, LOCALES[lang])).toBe(EXPECTED[lang].pm);
    });

    it(`${lang}: returns null for a period it has no words for, or none at all`, () => {
      expect(optionLabel('amPmOption', { hour: '5', period: 'noon' }, LOCALES[lang])).toBeNull();
      expect(optionLabel('amPmOption', { hour: '5', period: 'AM' }, LOCALES[lang])).toBeNull();
      expect(optionLabel('amPmOption', { hour: '5' }, LOCALES[lang])).toBeNull();
    });
  }
});
