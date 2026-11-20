/**
 * `latin` never sets words in a face that has no letters for them
 * (simulator 2026-11-20, sim-1120 G; shots 11 and 05d).
 *
 * A time slot asks for the Latin face (`latin`) so «07:00» fits its box. When
 * the item has no time the same slot says «بدون وقت» — and Today's rows, the
 * next-step card and the details screen's time row passed `latin` for it too.
 * Plus Jakarta Sans has no Arabic or Hebrew letters, so iOS drew the words in
 * a fallback face, smaller and unlike every other Arabic line. The face now
 * follows the words: Arabic or Hebrew letters keep their own face, digits and
 * Latin keep the Latin one.
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { beforeEach, describe, expect, it } from '@jest/globals';
import { render, waitFor, type RenderResult } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider } from '../../state/AppContext';
import { LANGUAGE_STORAGE_KEY } from '../../i18n/language';
import { LINE_HEIGHT } from '../../theme/fonts';
import ar from '../../i18n/locales/ar.json';
import he from '../../i18n/locales/he.json';
import { Txt } from '../primitives';

type Face = { fontFamily: string; fontSize: number; lineHeight: number };
const faceOf = (view: RenderResult, id: string) => StyleSheet.flatten(view.getByTestId(id).props.style) as Face;

async function show(lang: 'ar' | 'he', children: React.ReactNode) {
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
  const view = await render(<AppProvider>{children}</AppProvider>);
  // The stored preference is read in an effect; wait for the script's face.
  await waitFor(() => expect(faceOf(view, 'plain').fontFamily).toContain(lang === 'ar' ? 'NotoKufiArabic' : 'NotoSansHebrew'));
  return view;
}

beforeEach(async () => { await AsyncStorage.clear(); });

describe('Txt latin', () => {
  it('sets «بدون وقت» in the Arabic face, at the size and line box of the Arabic around it', async () => {
    const view = await show('ar', <>
      <Txt size={13} testID="plain">{ar.todayLoading}</Txt>
      <Txt size={13} latin testID="untimed">{ar.noTimeYet}</Txt>
      <Txt size={13} latin testID="time">07:00</Txt>
    </>);
    const plain = faceOf(view, 'plain');
    const untimed = faceOf(view, 'untimed');
    expect(untimed.fontFamily).toBe(plain.fontFamily);
    expect(untimed.fontSize).toBe(13);
    expect(untimed.lineHeight).toBe(Math.round(13 * LINE_HEIGHT.arabic));
    // A time keeps the Latin face the flag is for.
    expect(faceOf(view, 'time').fontFamily).toContain('PlusJakartaSans');
  });

  it('keeps Hebrew words in the Hebrew face too', async () => {
    const view = await show('he', <>
      <Txt size={13} testID="plain">{he.todayLoading}</Txt>
      <Txt size={13} latin testID="untimed">{he.noTimeYet}</Txt>
    </>);
    expect(faceOf(view, 'untimed').fontFamily).toBe(faceOf(view, 'plain').fontFamily);
  });
});
