/**
 * The saved «انحفظت ✓» line stays inside the chat column (simulator
 * 2026-10-24, P2, screens 32 and 34).
 *
 * At the default size, with no text-size change, the saved bubble ran off the
 * screen's start edge: its border was cut off and its words started at x 10
 * while every other bubble's started at x 35. The check and the words were a
 * row, so the words fitted only by shrinking (`flexShrink: 1` on them). Yoga
 * skips that shrink when it measures the row at an exact height — the
 * bubble measures its stretched children that way (`canSkipFlex` in
 * CalculateLayout.cpp) — and the row came back at icon + gap + one unbroken
 * line, 26 points wider than the 88 % column; the bubble took that width.
 * `minWidth: 0` or a shrink on the row changes nothing there. (Checked with
 * yoga-layout 3.2.1 and `Errata.All`, as React Native configures it: the row
 * gave a 351-point bubble in a 326-point column, the line below a 326-point
 * bubble with the words wrapped to two lines.)
 *
 * Now the line is a column: the check sits out of flow in the line's start
 * padding, and the words fill what is left, so nothing in it needs a shrink
 * and the words wrap within the bubble. Both places a save is drawn are
 * covered: the newest reply's always-mounted slot (#780) and an older saved
 * message. Offsets are logical (`start`), never `left`/`right`, so the line
 * mirrors in Arabic and English alike.
 */
import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { describe, expect, it } from '@jest/globals';
import { render, screen, within } from '@testing-library/react-native';
import { SayItChatPage, type SayItChatPageProps } from '../SayItChatPage';

const SAVED = 'انحفظت ✓ «روح عالبنك»، «اتصل بسامي»';
const NEXT = 'في إشي تاني؟ احكيلي.';

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
  text: '', canSend: false,
  onChangeText: () => {}, onSend: () => {}, onClose: () => {}, onMore: () => {}, onPaste: () => {},
};

const back = <Pressable testID="probe-today" accessibilityRole="button" accessibilityLabel="ارجع لليوم" onPress={() => {}}>
  <Text>ارجع لليوم</Text>
</Pressable>;

type Style = Record<string, unknown>;
const flat = (node: ReturnType<typeof screen.getByTestId>) => (StyleSheet.flatten(node.props.style) ?? {}) as Style;
const PHYSICAL = ['left', 'right', 'marginLeft', 'marginRight', 'paddingLeft', 'paddingRight'];

/**
 * A saved line whose words never depend on a shrink: not a row, the check out
 * of flow at the start edge, its room reserved by the line's start padding,
 * and the words a plain block that fills the rest and wraps.
 */
function expectFits(line: ReturnType<typeof screen.getByTestId>, id: string) {
  const lineStyle = flat(line);
  expect(lineStyle.flexDirection ?? 'column').toBe('column');
  const check = within(line).getByTestId(`${id}-check`, { includeHiddenElements: true });
  const checkStyle = flat(check);
  expect(checkStyle).toEqual(expect.objectContaining({ position: 'absolute', start: 0, top: 0 }));
  expect(lineStyle.paddingStart as number).toBeGreaterThanOrEqual((checkStyle.width as number) + 8);
  expect(lineStyle.minHeight as number).toBeGreaterThanOrEqual(checkStyle.height as number);
  // The words' own box: the paragraph's parent. It is in flow and takes no
  // fixed or content-held width, so the line's width is the bubble's.
  const words = within(line).getByTestId(`${id}-text-0`).parent!;
  const wordsStyle = flat(words);
  expect(wordsStyle.position).toBeUndefined();
  expect(wordsStyle.width).toBeUndefined();
  expect(wordsStyle.flexDirection ?? 'column').toBe('column');
  expect(within(line).getByTestId(`${id}-text-0`).props.children).toBe(SAVED);
  for (const style of [lineStyle, checkStyle, wordsStyle]) {
    for (const key of PHYSICAL) expect(style[key]).toBeUndefined();
  }
}

describe('the saved line inside the chat column', () => {
  for (const rtl of [true, false]) {
    describe(rtl ? 'Arabic (RTL)' : 'English (LTR)', () => {
      it('the newest reply: the live slot\'s words view is the line, and the check sits in its start padding', async () => {
        await render(<SayItChatPage {...baseProps} rtl={rtl} history={[
          { role: 'user', text: 'لازم اتصل بسامي بعد بكرا' },
          { role: 'assistant', id: 'chat-saved-1', tone: 'saved', text: SAVED, tail: NEXT, actions: back },
        ]} />);
        const live = screen.getByTestId('chat-live');
        const words = within(live).getByTestId('chat-saved-1-words');
        // #780: the region still holds only the words; the controls sit beside it.
        expect(words.props.accessible).toBe(true);
        expect(words.props.accessibilityLabel).toBe(`${SAVED}\n\n${NEXT}`);
        expect(within(live).queryByRole('button')).toBeNull();
        expectFits(words, 'chat-saved-1');
      });

      it('an older saved message: its line is the same column, with the words its own element', async () => {
        await render(<SayItChatPage {...baseProps} rtl={rtl} history={[
          { role: 'user', text: 'لازم اتصل بسامي بعد بكرا' },
          { role: 'assistant', id: 'chat-saved-1', tone: 'saved', text: SAVED, tail: NEXT, actions: back },
          { role: 'user', text: 'بدي روح عالبنك بكرا' },
        ]} />);
        const saved = screen.getByTestId('chat-saved-1');
        expect(within(screen.getByTestId('chat-live')).queryByTestId('chat-saved-1-words')).toBeNull();
        expect(within(saved).getByTestId('chat-saved-1-said').props.accessibilityLabel).toBe(SAVED);
        expectFits(within(saved).getByTestId('chat-saved-1-line'), 'chat-saved-1');
      });
    });
  }

  it('the check is decoration: hidden from a screen reader, which hears the words', async () => {
    await render(<SayItChatPage {...baseProps} rtl history={[
      { role: 'assistant', id: 'chat-saved-1', tone: 'saved', text: SAVED, tail: NEXT, actions: back },
    ]} />);
    const check = screen.getByTestId('chat-saved-1-check', { includeHiddenElements: true });
    expect(check.props.accessibilityElementsHidden).toBe(true);
    expect(check.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(screen.queryByTestId('chat-saved-1-check')).toBeNull();
  });
});
