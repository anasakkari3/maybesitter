/**
 * M2a: how the «هيك فهمت» summary reaches a screen reader — each line its own
 * button, said as its place in the list, its kind, its words and the time its
 * card shows (M2A-REV-002).
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
    expect(plain(screen.getByTestId('understood-line-1').props.accessibilityLabel)).toMatch(/^1 من 3\. التزام: اجتماع, .*16:00–20:00$/);
    expect(plain(screen.getByTestId('understood-line-2').props.accessibilityLabel)).toBe(`2 من 3. ${ar.seedKindConsideration}: عم تفكّر تسافر الصيف الجاي`);
    // No time yet: the line says nothing about one; its card will ask.
    expect(plain(screen.getByTestId('understood-line-3').props.accessibilityLabel)).toBe('3 من 3. التزام: تتصل بسارة');
    expect(screen.queryByTestId('understood-when-i:call')).toBeNull();
  });

  it('makes every line its own button that shows its card, inside a list that is not one element', async () => {
    const onOpen = await show();
    const list = screen.getByTestId('understood-list');
    expect(list.props.accessibilityRole).toBe('list');
    // An accessible wrapper would hide the lines from VoiceOver.
    expect(list.props.accessible).not.toBe(true);
    for (const n of [1, 2, 3]) {
      const line = screen.getByTestId(`understood-line-${n}`);
      expect(line.props.accessibilityRole).toBe('button');
      expect(line.props.accessibilityHint).toBe(ar.understoodLineHint);
    }
    await fireEvent.press(screen.getByTestId('understood-line-2'));
    expect(onOpen).toHaveBeenLastCalledWith({ seedItemId: 'travel' });
  });

  it('shows the time the card will show: a moved range keeps its length', async () => {
    await show(jest.fn(), { meeting: { localDateTime: '2030-01-07T18:00' } });
    expect(plain(screen.getByTestId('understood-line-1').props.accessibilityLabel)).toMatch(/18:00–22:00$/);
  });

  it('one point is one line, without a list or a position', async () => {
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
    await render(<AppProvider><UnderstoodMessage proposal={proposal} points={[points[1]!]} edits={{}} onOpen={jest.fn()} /></AppProvider>);
    await waitFor(() => expect(screen.queryByTestId('understood-line-1')).not.toBeNull());
    expect(screen.queryByTestId('understood-list')).toBeNull();
    expect(plain(screen.getByTestId('understood-line-1').props.accessibilityLabel)).toBe(`${ar.seedKindConsideration}: عم تفكّر تسافر الصيف الجاي`);
  });
});
