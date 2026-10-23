/**
 * «هيك فهمت» follows a text-size change made while it is on screen
 * (simulator 2026-10-23, follow-up to #740).
 *
 * Repro: «بدي روح عالبنك بكرا», then «لازم اتصل بسامي بعد بكرا»; the text size
 * goes to AX5 and back to the default with the screen open. Back at the
 * default the card kept its AX5 rows — «اتصل بسامي» drawn over «فهمت منك:»,
 * «التزام» under «هيك صح», «عدّل» cut off at the start edge — and only the
 * keyed «هيك صح» pill resized. A paragraph React commits with unchanged props
 * keeps its Yoga measurement from the earlier scale; only a new paragraph is
 * measured from scratch (see `RemeasureOnTextScale`).
 *
 * The scale changes the way it does on a phone — `Dimensions` emits a change
 * and the real `useWindowDimensions` hears it — as in pillLiveTextScale.test.
 * The global jest setup replaces that hook with a fixed reading; this file
 * restores the real one (per-file, so other files keep the global mock) and
 * puts the reading back to the default after each test.
 */
import React from 'react';
import { Dimensions, StyleSheet } from 'react-native';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider } from '../../../state/AppContext';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import { UnderstoodMessage } from '../UnderstoodMessage';
import { Txt } from '../../../ui/primitives';
import type { CaptureProposal } from '../../../api/schemas/capture';

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () =>
  jest.requireActual('react-native/Libraries/Utilities/useWindowDimensions'),
);
jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'UTC' }]),
  getLocales: jest.fn(() => [{ languageCode: 'ar', languageTag: 'ar', textDirection: 'rtl' }]),
}));

const AX5 = 3.12;

const proposal: CaptureProposal = {
  version: 'v1', proposalId: 'p1', status: 'proposed', revision: 2,
  items: [
    { itemId: 'bank', title: 'روح عالبنك', resolvedTime: null, needsClarification: true },
    { itemId: 'sami', title: 'اتصل بسامي', resolvedTime: '2030-01-08T09:00:00.000Z', needsClarification: false },
  ],
  seeds: [],
};
const withRemoved: CaptureProposal = { ...proposal, removedItems: [{ itemId: 'gym', kind: 'commitment', text: 'روح عالنادي' }] };
const points = [
  { kind: 'commitment' as const, itemId: 'bank', text: 'روح عالبنك' },
  { kind: 'commitment' as const, itemId: 'sami', text: 'اتصل بسامي' },
];

function setFontScale(fontScale: number, width = 390, height = 844) {
  const window = { width, height, scale: 3, fontScale };
  Dimensions.set({ window, screen: window });
}

afterEach(async () => {
  await cleanup();
  setFontScale(1);
  await AsyncStorage.clear();
});

type Host = ReturnType<typeof screen.getByTestId>;

/** Every paragraph of the card's rows, by what it says. */
function rowText(): Record<string, Host> {
  const byId = (id: string) => screen.getByTestId(id);
  return {
    kind1: byId('understood-kind-i:bank'), text1: byId('understood-text-i:bank'),
    kind2: byId('understood-kind-i:sami'), text2: byId('understood-text-i:sami'), when2: byId('understood-when-i:sami'),
    badge2: within(screen.getByTestId('understood-line-2')).getByText('2'),
    edit2: within(screen.getByTestId('understood-edit-2')).getByText('عدّل'),
  };
}

/** The direction of the box that holds line 2 and its «عدّل». */
function pairDirection(): string {
  const pair = screen.getByTestId('understood-line-2').parent!.parent!;
  return (StyleSheet.flatten(pair.props.style)?.flexDirection as string | undefined) ?? 'column';
}

/** What a screen reader meets: each control's name, role and hint. */
function accessibleNames() {
  return ['understood-line-1', 'understood-line-2', 'understood-edit-1', 'understood-edit-2'].map((id) => {
    const node = screen.getByTestId(id);
    return [node.props.accessibilityLabel, node.props.accessibilityRole, node.props.accessibilityHint ?? null];
  });
}

async function mount(fontScale: number, which: CaptureProposal = proposal) {
  setFontScale(fontScale);
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
  await render(<AppProvider>
    <UnderstoodMessage proposal={which} points={points} edits={{}} onOpen={jest.fn()} editable onEdit={jest.fn()} onRestore={jest.fn()} />
    <Txt testID="outside">فهمت منك:</Txt>
  </AppProvider>);
  await waitFor(() => expect(screen.queryByTestId('understood-edit-2')).not.toBeNull());
}

describe('the understood card re-measures after a live text-size change', () => {
  it.each([
    ['without removed points', proposal],
    ['with a removed point', withRemoved],
  ])('default → AX5 → default gives every row a fresh paragraph and the default layout (%s)', async (_label, which) => {
    await mount(1, which);
    const fresh = rowText();
    const names = accessibleNames();
    expect(pairDirection()).toBe('row');
    const restoreFresh = which.removedItems ? screen.getByText('رجّعها') : null;

    await act(async () => { setFontScale(AX5); });
    const atAx5 = rowText();
    expect(pairDirection()).toBe('column');
    for (const key of Object.keys(fresh)) expect(atAx5[key]!).not.toBe(fresh[key]!);

    await act(async () => { setFontScale(1); });
    const back = rowText();
    // Every row's words, kind, time, number and «عدّل» are new paragraphs —
    // native measures each from scratch at the default size, not the AX5
    // measurement the old ones carried.
    for (const key of Object.keys(back)) expect(back[key]!).not.toBe(atAx5[key]!);
    if (restoreFresh) expect(screen.getByText('رجّعها')).not.toBe(restoreFresh);
    // …and the card takes the layout it has opened fresh at the default size.
    expect(pairDirection()).toBe('row');
    expect(screen.queryByTestId('understood-edit-indent-2', { includeHiddenElements: true })).toBeNull();
    expect(StyleSheet.flatten(screen.getByTestId('understood-line-2').parent!.props.style)).toEqual(expect.objectContaining({ flex: 1 }));
    // Same words at base metrics (the native renderer applies the scale once).
    expect(back.text2!.props.children).toBe('اتصل بسامي');
    expect((StyleSheet.flatten(back.text2!.props.style) as { fontSize: number }).fontSize).toBe(15);
    // Names, roles and hints are what they were.
    expect(accessibleNames()).toEqual(names);
  });

  it('keeps the buttons themselves mounted, so a screen reader\'s focus stays put', async () => {
    await mount(1);
    const line = screen.getByTestId('understood-line-2');
    const edit1 = screen.getByTestId('understood-edit-1');
    await act(async () => { setFontScale(1.12); });
    // Within one layout mode only the text is replaced.
    expect(screen.getByTestId('understood-line-2')).toBe(line);
    expect(screen.getByTestId('understood-edit-1')).toBe(edit1);
  });

  it('re-measures within the accessibility sizes too (AX1 → AX5, same layout mode)', async () => {
    await mount(1.64);
    const before = rowText();
    await act(async () => { setFontScale(AX5); });
    const after = rowText();
    for (const key of Object.keys(before)) expect(after[key]!).not.toBe(before[key]!);
  });

  it('replaces nothing when the scale did not change (a rotation), and leaves text outside the card alone', async () => {
    await mount(AX5);
    const before = rowText();
    const outside = screen.getByTestId('outside');
    await act(async () => { setFontScale(AX5, 844, 390); });
    const after = rowText();
    for (const key of Object.keys(before)) expect(after[key]!).toBe(before[key]!);
    await act(async () => { setFontScale(1); });
    expect(screen.getByTestId('outside')).toBe(outside);
  });
});
