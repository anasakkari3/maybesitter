/**
 * «هيك فهمت» at large text (M2b, simulator AX5 under load, F2): beside its
 * line, «عدّل» left the words a column one or two words wide and «المدير»
 * broke inside itself as «المدي/ر». From the large layout on, «عدّل» and
 * «رجّعها» sit under their line, and the line keeps the bubble's width.
 */
import React from 'react';
import { afterEach, expect, it, jest } from '@jest/globals';
import { StyleSheet } from 'react-native';
import { cleanup, render, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider } from '../../../state/AppContext';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import { UnderstoodMessage } from '../UnderstoodMessage';
import { LAYOUT_MODE_FROM } from '../../../theme/textScale';
import type { CaptureProposal } from '../../../api/schemas/capture';

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({ __esModule: true, default: jest.fn() }));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const useWindowDimensions = require('react-native/Libraries/Utilities/useWindowDimensions').default as jest.Mock;
jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'UTC' }]),
  getLocales: jest.fn(() => [{ languageCode: 'ar', languageTag: 'ar', textDirection: 'rtl' }]),
}));

const proposal: CaptureProposal = {
  version: 'v1', proposalId: 'p1', status: 'proposed', revision: 2,
  items: [
    { itemId: 'dinner', title: 'عشا مع العيلة', resolvedTime: '2030-01-07T17:00:00.000Z', needsClarification: false },
    { itemId: 'reply', title: 'أرد على إيميل المدير', resolvedTime: '2030-01-07T07:00:00.000Z', needsClarification: false },
  ],
  seeds: [],
  removedItems: [{ itemId: 'call', kind: 'commitment', text: 'اتصل بالبنك' }],
};
const points = [
  { kind: 'commitment' as const, itemId: 'dinner', text: 'عشا مع العيلة' },
  { kind: 'commitment' as const, itemId: 'reply', text: 'أرد على إيميل المدير' },
];

afterEach(async () => { await cleanup(); await AsyncStorage.clear(); });

/** The direction of the nearest styled row or column that holds `testID`. */
function directionAround(testID: string): string {
  let node = screen.getByTestId(testID).parent;
  while (node) {
    const style = StyleSheet.flatten(node.props.style);
    if (style && (style.flexDirection !== undefined || style.gap !== undefined)) return (style.flexDirection as string | undefined) ?? 'column';
    node = node.parent;
  }
  return 'column';
}

it.each([
  [1, 'row'],
  [LAYOUT_MODE_FROM.large, 'column'],
  [3.12, 'column'],
])('at font scale %s «عدّل» and «رجّعها» lay out as a %s with their line', async (fontScale, direction) => {
  useWindowDimensions.mockReturnValue({ width: 390, height: 844, scale: 3, fontScale });
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
  await render(<AppProvider><UnderstoodMessage proposal={proposal} points={points} edits={{}} onOpen={jest.fn()}
    editable onEdit={jest.fn()} onRestore={jest.fn()} /></AppProvider>);
  await waitFor(() => expect(screen.queryByTestId('understood-edit-2')).not.toBeNull());
  expect(directionAround('understood-edit-2')).toBe(direction);
  expect(directionAround('understood-restore-call')).toBe(direction);
  // Stacked, the line itself is not squeezed beside a control.
  const lineBox = StyleSheet.flatten(screen.getByTestId('understood-line-2').parent!.props.style);
  if (direction === 'column') expect(lineBox).toEqual(expect.objectContaining({ alignSelf: 'stretch' }));
  else expect(lineBox).toEqual(expect.objectContaining({ flex: 1 }));
});
