/**
 * M2a: how the «هيك فهمت» summary reaches a screen reader — the kind before the
 * words, the time a commitment's card shows, and on iOS (where the list is one
 * element and hides its lines) a custom action per line that shows its card.
 */
import React from 'react';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider } from '../../../state/AppContext';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import { UnderstoodMessage } from '../UnderstoodMessage';
import type { CaptureProposal } from '../../../api/schemas/capture';
import ar from '../../../i18n/locales/ar.json';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'UTC' }]),
  getLocales: jest.fn(() => [{ languageCode: 'ar', languageTag: 'ar', textDirection: 'rtl' }]),
}));

const proposal: CaptureProposal = {
  version: 'v1', proposalId: 'p1', status: 'proposed',
  items: [
    { itemId: 'meeting', title: 'اجتماع', resolvedTime: '2030-01-07T16:00:00.000Z', endTime: '2030-01-07T20:00:00.000Z', needsClarification: false },
    { itemId: 'call', title: 'اتصل بسارة', resolvedTime: null, needsClarification: true },
  ],
  seeds: [{ seedItemId: 'travel', kind: 'consideration', summary: 'السفر الصيف الجاي' }],
};
const points = [
  { kind: 'commitment' as const, itemId: 'meeting', text: 'اجتماع' },
  { kind: 'consideration' as const, seedItemId: 'travel', text: 'عم تفكّر تسافر الصيف الجاي' },
  { kind: 'commitment' as const, itemId: 'call', text: 'تتصل بسارة' },
];
const plain = (value: unknown) => String(value).replace(/[⁦-⁩]/g, '');

afterEach(async () => { await AsyncStorage.clear(); });

async function show(onOpen = jest.fn(), edits = {}) {
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
  await render(<AppProvider><UnderstoodMessage proposal={proposal} points={points} edits={edits} onOpen={onOpen} /></AppProvider>);
  await waitFor(() => expect(screen.queryByTestId('understood-line-1')).not.toBeNull());
  return onOpen;
}

describe('the understood summary', () => {
  it('speaks each line as its number, its kind, its words — and a timed commitment its range', async () => {
    await show();
    expect(plain(screen.getByTestId('understood-line-1').props.accessibilityLabel)).toMatch(/^1\. التزام: اجتماع, .*16:00–20:00$/);
    expect(plain(screen.getByTestId('understood-line-2').props.accessibilityLabel)).toBe(`2. ${ar.seedKindConsideration}: عم تفكّر تسافر الصيف الجاي`);
    // No time yet: the line says nothing about one; its card will ask.
    expect(plain(screen.getByTestId('understood-line-3').props.accessibilityLabel)).toBe('3. التزام: تتصل بسارة');
    expect(screen.queryByTestId('understood-when-i:call')).toBeNull();
  });

  it('offers every line to VoiceOver as an action on the list, which shows that line\'s card', async () => {
    const onOpen = await show();
    const list = screen.getByTestId('understood-list');
    expect(list.props.accessibilityActions.map((action: { label: string }) => plain(action.label)))
      .toEqual([0, 1, 2].map((n) => plain(screen.getByTestId(`understood-line-${n + 1}`).props.accessibilityLabel)));
    await fireEvent(list, 'accessibilityAction', { nativeEvent: { actionName: 'open-1' } });
    expect(onOpen).toHaveBeenLastCalledWith({ seedItemId: 'travel' });
    await fireEvent(list, 'accessibilityAction', { nativeEvent: { actionName: 'activate' } });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('shows the time the card will show: a moved range keeps its length', async () => {
    await show(jest.fn(), { meeting: { localDateTime: '2030-01-07T18:00' } });
    expect(plain(screen.getByTestId('understood-line-1').props.accessibilityLabel)).toMatch(/18:00–22:00$/);
  });
});
