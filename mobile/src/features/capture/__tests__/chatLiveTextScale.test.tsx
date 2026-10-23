/**
 * The «احكيها» reply bubble follows a text-size change made while it is open
 * (simulator 2026-10-23, screens 13 and 14).
 *
 * Back at the default size after AX5 the bubble stayed 332 pt wide instead of
 * 292 and its first line, «هيك فهمت لحد هلّق…», was cut off at the start
 * edge; reopened, it was fine. Two causes, both covered here:
 *
 * - the chat sets its own text styles with React Native's `Text`, outside
 *   #786's boundary, so the reply's paragraphs kept the AX5 measurement.
 *   They are `RemeasuredText` now under a boundary of their own, always
 *   inside an accessible element that stays (the `-words` view of the newest
 *   reply, the `-said` view of an older message whose bubble holds controls);
 * - the «هيك فهمت» lines inside the bubble came back to `flex: 1`, and Yoga
 *   on Fabric kept the basis it measured for them stacked (their AX5 height),
 *   so each row overflowed the bubble. They grow without a basis now
 *   as `fillRow` now — `flex: 1`'s grow 1, shrink 0 and zero basis, from
 *   `width: 0`, which Yoga recomputes on every layout — and so does the
 *   expanded column.
 *
 * The host passes the live layout mode as CaptureScreen does. Real
 * `useWindowDimensions` and `Dimensions.set`, as in understoodLiveTextScale.test.
 */
import React from 'react';
import { Dimensions, Pressable, StyleSheet, Text } from 'react-native';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider } from '../../../state/AppContext';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import { DirectionRoot } from '../../../ui/DirectionRoot';
import { useLayoutMode } from '../../../theme/textScale';
import { SayItChatPage, type SayItChatPageProps } from '../SayItChatPage';
import { UnderstoodMessage } from '../UnderstoodMessage';
import type { CaptureProposal } from '../../../api/schemas/capture';

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () =>
  jest.requireActual('react-native/Libraries/Utilities/useWindowDimensions'),
);
jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'UTC' }]),
  getLocales: jest.fn(() => [{ languageCode: 'ar', languageTag: 'ar', textDirection: 'rtl' }]),
}));

const AX5 = 3.12;
const REPLY = 'هيك فهمت لحد هلّق. أي ساعة بدك «روح عالبنك»؟';

const proposal: CaptureProposal = {
  version: 'v1', proposalId: 'p1', status: 'proposed', revision: 2,
  items: [
    { itemId: 'bank', title: 'روح عالبنك', resolvedTime: null, needsClarification: true },
    { itemId: 'sami', title: 'اتصل بسامي', resolvedTime: '2030-01-08T09:00:00.000Z', needsClarification: false },
  ],
  seeds: [],
};
const points = [
  { kind: 'commitment' as const, itemId: 'bank', text: 'روح عالبنك' },
  { kind: 'commitment' as const, itemId: 'sami', text: 'اتصل بسامي' },
];

const baseProps: SayItChatPageProps = {
  colors: {
    bg: '#17191b', sf: '#222426', sf2: '#282a2d', tx: '#f7f5f5', mu: '#b5b3ba',
    ln: '#303236', lnStrong: '#424448', ac: '#fd7b94', acd: '#ff93a8', acs: '#6d3745',
    onAccent: '#17191b', dis: '#343538', disTx: '#b5b3ba', success: '#2ed889',
  },
  fonts: { regular: 'NotoKufiArabic-Regular', semibold: 'NotoKufiArabic-SemiBold', lineRatio: 1.6 },
  copy: {
    title: 'احكيها', subtitle: 'احكيلي شو عندك', placeholder: 'اكتب…',
    closeLabel: 'رجوع', moreLabel: 'كمان', pasteLabel: 'الصق',
    sendLabel: 'افهمها', confirmLabel: 'ضيفها', editLabel: 'عدّل', includeLabel: 'ينحفظ',
  },
  text: '', canSend: false, rtl: true,
  onChangeText: () => {}, onSend: () => {}, onClose: () => {}, onMore: () => {}, onPaste: () => {},
};

function Host() {
  const mode = useLayoutMode();
  const [draft, setDraft] = React.useState('');
  return <SayItChatPage {...baseProps} mode={mode} text={draft} onChangeText={setDraft} history={[
    { role: 'user', text: 'بدي روح عالبنك بكرا، ولازم اتصل بسامي بعد بكرا' },
    { role: 'assistant', id: 'reply', text: REPLY,
      body: <UnderstoodMessage proposal={proposal} points={points} edits={{}} onOpen={jest.fn()} editable onEdit={jest.fn()} /> },
  ]} />;
}

function setFontScale(fontScale: number) {
  const window = { width: 390, height: 844, scale: 3, fontScale };
  Dimensions.set({ window, screen: window });
}

afterEach(async () => {
  await cleanup();
  setFontScale(1);
  await AsyncStorage.clear();
});

type HostNode = ReturnType<typeof screen.getByTestId>;
type Style = Record<string, unknown>;

/** The bubble's column: the nearest box above the reply's words that caps its width. */
function column(): Style {
  let node: HostNode | null = screen.getByTestId('reply-words');
  while (node) {
    const style = StyleSheet.flatten(node.props.style) as Style | undefined;
    if (style && 'maxWidth' in style) return style;
    node = node.parent;
  }
  throw new Error('no column above the reply');
}

const lineBox = (n: number) => StyleSheet.flatten(screen.getByTestId(`understood-line-${n}`).parent!.props.style) as Style;

async function mount() {
  setFontScale(1);
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
  await render(<AppProvider><DirectionRoot><Host /></DirectionRoot></AppProvider>);
  await waitFor(() => expect(screen.queryByTestId('understood-edit-2')).not.toBeNull());
}

describe('the reply bubble after a live text-size change', () => {
  it('default → AX5 → default: its first line is a new paragraph, and the column and rows take the fresh default layout', async () => {
    await mount();
    const header = screen.getByTestId('reply-text-0');
    const words = screen.getByTestId('reply-words');
    expect(header.props.children).toBe(REPLY);
    const freshColumn = column();
    const freshLines = [lineBox(1), lineBox(2)];
    const kept = ['understood-line-1', 'understood-line-2', 'understood-edit-1', 'understood-edit-2'].map((id) => screen.getByTestId(id));
    // At the default size the bubble is capped at 88 % and never grows to fill.
    expect(freshColumn.maxWidth).toBe('88%');
    expect(freshColumn.flexGrow).toBeUndefined();
    expect(freshColumn.flex).toBeUndefined();

    await act(async () => { setFontScale(AX5); });
    const atAx5 = screen.getByTestId('reply-text-0');
    expect(atAx5).not.toBe(header);
    // Expanded, the column takes the whole row as `flex: 1` did — grow 1 over
    // its own shrink 1, basis 0 from `width: 0` — never with a `flex` basis,
    // which Yoga on Fabric would keep.
    expect(column()).toEqual(expect.objectContaining({ maxWidth: '100%', flexGrow: 1, flexShrink: 1, width: 0 }));
    expect(column().flex).toBeUndefined();

    await act(async () => { setFontScale(1); });
    // A new paragraph, measured at the default size, not the AX5 one cut off.
    const back = screen.getByTestId('reply-text-0');
    expect(back).not.toBe(atAx5);
    expect(back.props.children).toBe(REPLY);
    // The column and the «هيك فهمت» rows are what a fresh open gives.
    expect(column()).toEqual(freshColumn);
    expect([lineBox(1), lineBox(2)]).toEqual(freshLines);
    for (const box of freshLines) {
      expect(box).toEqual(expect.objectContaining({ flexGrow: 1, flexShrink: 0, width: 0 }));
      expect(box.flex).toBeUndefined();
      expect(box.flexBasis).toBeUndefined();
    }
    // The words' element, the lines and «عدّل» — what a screen reader is on —
    // never remounted.
    expect(screen.getByTestId('reply-words')).toBe(words);
    expect(words.props.accessible).toBe(true);
    ['understood-line-1', 'understood-line-2', 'understood-edit-1', 'understood-edit-2']
      .forEach((id, i) => expect(screen.getByTestId(id)).toBe(kept[i]));
  });

  it('an older message whose bubble holds a summary: its words are said by a wrapper that stays, the paragraphs replaced', async () => {
    setFontScale(1);
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
    function Older() {
      const mode = useLayoutMode();
      return <SayItChatPage {...baseProps} mode={mode} history={[
        { role: 'assistant', id: 'older', text: REPLY,
          body: <UnderstoodMessage proposal={proposal} points={points} edits={{}} onOpen={jest.fn()} editable onEdit={jest.fn()} /> },
        { role: 'user', text: 'الساعة عشرة' },
      ]} />;
    }
    await render(<AppProvider><Older /></AppProvider>);
    await waitFor(() => expect(screen.queryByTestId('older-said')).not.toBeNull());
    const said = screen.getByTestId('older-said');
    expect(said.props.accessible).toBe(true);
    expect(said.props.accessibilityLabel).toBe(REPLY);
    let paragraph = screen.getByTestId('older-text-0');
    for (const scale of [AX5, 1]) {
      await act(async () => { setFontScale(scale); });
      expect(screen.getByTestId('older-said')).toBe(said);
      expect(screen.getByTestId('older-text-0')).not.toBe(paragraph);
      paragraph = screen.getByTestId('older-text-0');
    }
  });

  it('Q-LIVE-R2-001 a saved message tail is re-measured too: replaced on each change, said by a wrapper that stays', async () => {
    setFontScale(1);
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
    const TAIL = 'في إشي تاني؟ احكيلي.';
    function Saved() {
      const mode = useLayoutMode();
      return <SayItChatPage {...baseProps} mode={mode} history={[
        // An older saved message whose bubble holds controls, so its tail has its own element.
        { role: 'assistant', id: 'saved', text: 'انحفظت.', tone: 'saved', tail: TAIL,
          actions: <Pressable testID="saved-undo" accessibilityRole="button" onPress={jest.fn()}><Text>تراجع</Text></Pressable> },
        { role: 'user', text: 'تمام' },
      ]} />;
    }
    await render(<AppProvider><Saved /></AppProvider>);
    await waitFor(() => expect(screen.queryByTestId('saved-tail-said')).not.toBeNull());
    const said = screen.getByTestId('saved-tail-said');
    expect(said.props.accessible).toBe(true);
    expect(said.props.accessibilityLabel).toBe(TAIL);
    const undo = screen.getByTestId('saved-undo');
    let tail = screen.getByTestId('saved-text-1');
    for (const scale of [AX5, 1]) {
      await act(async () => { setFontScale(scale); });
      expect(screen.getByTestId('saved-tail-said')).toBe(said);
      expect(screen.getByTestId('saved-undo')).toBe(undo);
      expect(screen.getByTestId('saved-text-1')).not.toBe(tail);
      tail = screen.getByTestId('saved-text-1');
    }
  });

  it('keeps the composer and what is typed in it across the change', async () => {
    await mount();
    await act(async () => { await fireEvent.changeText(screen.getByTestId('capture-input'), 'لازم اتصل بسامي'); });
    const input = screen.getByTestId('capture-input');
    for (const scale of [AX5, 1]) {
      await act(async () => { setFontScale(scale); });
      expect(screen.getByTestId('capture-input')).toBe(input);
      expect(screen.getByTestId('capture-input').props.value).toBe('لازم اتصل بسامي');
    }
  });
});
