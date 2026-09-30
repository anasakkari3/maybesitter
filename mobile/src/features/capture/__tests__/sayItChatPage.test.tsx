import React from 'react';
import { describe, expect, it, jest } from '@jest/globals';
import { Pressable, StyleSheet, Text } from 'react-native';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { ChatMicrophone, SayItChatPage, type SayItChatPageProps } from '../SayItChatPage';

const baseProps: SayItChatPageProps = {
  colors: {
    bg: '#17191b', sf: '#222426', sf2: '#282a2d', tx: '#f7f5f5', mu: '#b5b3ba',
    ln: '#303236', lnStrong: '#424448', ac: '#fd7b94', acd: '#ff93a8', acs: '#6d3745',
    onAccent: '#17191b', dis: '#343538', disTx: '#b5b3ba', success: '#2ed889',
  },
  fonts: { regular: 'Outfit-Regular', semibold: 'Outfit-SemiBold', lineRatio: 1.3 },
  copy: {
    title: 'Say it', subtitle: 'Here to help you make it happen', placeholder: 'Just say it…',
    closeLabel: 'Back', moreLabel: 'More options', pasteLabel: 'Paste',
    sendLabel: 'Understand it', confirmLabel: 'Add to my schedule',
    editLabel: 'Change', notIncludedLabel: 'Not included',
  },
  text: '', canSend: false,
  onChangeText: () => {}, onSend: () => {}, onClose: () => {}, onMore: () => {}, onPaste: () => {},
};

const CHECK_PATH = 'M5 12l4 4L19 6';

describe('SayItChatPage', () => {
  it('keeps the microphone controller mounted as speech fills the draft and the send control appears', async () => {
    const mounted = jest.fn();
    const unmounted = jest.fn();
    const onVoicePress = jest.fn();
    const onSend = jest.fn();
    function MicrophoneProbe({ listening }: { listening: boolean }) {
      React.useEffect(() => {
        mounted();
        return () => { unmounted(); };
      }, []);
      return <ChatMicrophone colors={baseProps.colors} listening={listening}
        label={listening ? 'Stop listening' : 'Start listening'} onPress={onVoicePress} />;
    }
    const page = (text: string, listening: boolean) => <SayItChatPage {...baseProps}
      text={text} canSend={!!text} listening={listening} onSend={onSend}
      microphone={<MicrophoneProbe listening={listening} />} />;

    const view = await render(page('', false));
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Start listening' })).toBeTruthy();

    // A typed prefix still offers dictation alongside Send.
    await view.rerender(page('Doctor', false));
    await fireEvent.press(screen.getByRole('button', { name: 'Start listening' }));
    expect(onVoicePress).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('capture-analyze')).toBeTruthy();

    // The first partial transcript must not unmount the recognizer or hide Stop.
    await view.rerender(page('Doctor at nine', true));
    expect(screen.getByTestId('voice-stop-glyph')).toBeTruthy();
    expect(screen.queryByTestId('capture-analyze')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Stop listening' }));
    expect(onVoicePress).toHaveBeenCalledTimes(2);

    // After listening ends, another dictation remains available alongside Send.
    await view.rerender(page('Doctor at nine', false));
    expect(screen.getByRole('button', { name: 'Start listening' })).toBeTruthy();
    await fireEvent.press(screen.getByTestId('capture-analyze'));
    expect(onSend).toHaveBeenCalledTimes(1);

    await view.rerender(page('', false));
    expect(screen.getByRole('button', { name: 'Start listening' })).toBeTruthy();
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();
    await view.unmount();
    expect(unmounted).toHaveBeenCalledTimes(1);
  });

  it('keeps row selection, editing, and recurring metadata controls independently accessible', async () => {
    const onToggle = jest.fn();
    const onEdit = jest.fn();
    const onWeekly = jest.fn();
    await render(<SayItChatPage {...baseProps} onRowToggle={onToggle} onRowPress={onEdit}
      scheduleGroups={[{
        id: 'tomorrow', title: 'Tomorrow', rows: [{
          id: 'doctor', title: 'Doctor', subtitle: '9:00 AM – 9:30 AM', selected: true,
          accessibilityLabel: 'Doctor, selected, tomorrow at 9:00 AM',
          extra: <Pressable testID="weekly-doctor" accessibilityRole="button"
            accessibilityLabel="Repeat weekly" onPress={onWeekly}><Text>Repeat weekly</Text></Pressable>,
        }],
      }]} />);

    const card = screen.getByTestId('review-card-doctor');
    const selection = within(card).getByRole('checkbox', { name: 'Doctor, selected, tomorrow at 9:00 AM' });
    expect(selection.props.accessibilityState.checked).toBe(true);
    expect(within(card).getByTestId('review-when-doctor').props.children).toBe('9:00 AM – 9:30 AM');
    expect(within(selection).queryByTestId('weekly-doctor')).toBeNull();
    await fireEvent.press(within(card).getByRole('button', { name: 'Repeat weekly' }));
    expect(onWeekly).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
    // The row's "…" opens the edit sheet, so it is named for that, not "More options".
    expect(within(card).queryByRole('button', { name: 'More options: Doctor' })).toBeNull();
    await fireEvent.press(within(card).getByRole('button', { name: 'Change: Doctor' }));
    expect(onEdit).toHaveBeenCalledWith('doctor');
    expect(onToggle).not.toHaveBeenCalled();
    await fireEvent.press(selection);
    expect(onToggle).toHaveBeenCalledWith('doctor');
  });

  it('marks selection with a glyph and a text tag, never colour alone', async () => {
    const row = (selected: boolean) => <SayItChatPage {...baseProps} onRowToggle={() => {}}
      scheduleGroups={[{ id: 'g', title: 'Tomorrow', rows: [{ id: 'doctor', title: 'Doctor', selected }] }]} />;
    const view = await render(row(true));
    const checkbox = screen.getByTestId('review-item-doctor');
    expect(checkbox.props.accessibilityState.checked).toBe(true);
    expect(within(checkbox).getByTestId('review-check-doctor')).toBeTruthy();
    expect(screen.getByTestId('review-check-doctor').queryAll(node => node.props.d === CHECK_PATH)).toHaveLength(1);
    expect(screen.queryByTestId('review-not-included-doctor')).toBeNull();
    expect(screen.queryByText('Not included')).toBeNull();

    await view.rerender(row(false));
    expect(screen.getByTestId('review-item-doctor').props.accessibilityState.checked).toBe(false);
    expect(screen.getByTestId('review-check-doctor').queryAll(node => node.props.d === CHECK_PATH)).toHaveLength(0);
    expect(within(screen.getByTestId('review-item-doctor')).getByText('Not included')).toBeTruthy();
  });

  it('claims no live presence in the header: the subtitle stands alone, with no status dot', async () => {
    await render(<SayItChatPage {...baseProps} />);
    const header = screen.getByTestId('chat-header');
    expect(within(header).getByTestId('chat-subtitle').props.children).toBe(baseProps.copy.subtitle);
    const successDots = header.queryAll(node => {
      const style = node.props.style;
      const flat = Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : style;
      return typeof node.type === 'string' && flat?.backgroundColor === baseProps.colors.success;
    });
    expect(successDots).toHaveLength(0);
  });

  it('prevents typing, pasting, and header actions while input is disabled', async () => {
    const onChangeText = jest.fn();
    const onPaste = jest.fn();
    const onMore = jest.fn();
    const onClose = jest.fn();
    const callbacks = { onChangeText, onPaste, onMore, onClose };
    const view = await render(<SayItChatPage {...baseProps} {...callbacks} inputDisabled />);
    const input = screen.getByTestId('capture-input');
    expect(input.props.editable).toBe(false);
    expect(input.props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(input, 'New text');
    expect(onChangeText).not.toHaveBeenCalled();
    for (const id of ['capture-paste', 'chat-more', 'capture-cancel']) {
      const action = screen.getByTestId(id);
      expect(action.props.accessibilityState.disabled).toBe(true);
      await fireEvent.press(action);
    }
    expect(onPaste).not.toHaveBeenCalled();
    expect(onMore).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    await view.rerender(<SayItChatPage {...baseProps} {...callbacks} />);
    await fireEvent.changeText(screen.getByTestId('capture-input'), 'New text');
    await fireEvent.press(screen.getByTestId('capture-paste'));
    expect(onChangeText).toHaveBeenCalledWith('New text');
    expect(onPaste).toHaveBeenCalledTimes(1);
  });

  it('offers a disabled send action when voice is unavailable and enables it for a typed draft', async () => {
    const onSend = jest.fn();
    const view = await render(<SayItChatPage {...baseProps} onSend={onSend} />);
    expect(screen.getByTestId('capture-analyze').props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(screen.getByTestId('capture-analyze'));
    expect(onSend).not.toHaveBeenCalled();
    await view.rerender(<SayItChatPage {...baseProps} text="Doctor at nine" canSend onSend={onSend} />);
    await fireEvent.press(screen.getByTestId('capture-analyze'));
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});

/*
 * UAT 2026-09-30, round of small ones on the chat page:
 *  u28  the selection check read as a ~15dp target; the row it marks and the
 *       row's «…» must each be at least 44 tall on their own;
 *  u27  an English sentence in the Arabic composer (and in the bubble it
 *       became) was set in Noto Naskh's serif Latin, not the app's Outfit;
 *  u27  the paste control said «الصق» and drew "+".
 */
describe('chat page details (UAT 2026-09-30)', () => {
  const flat = (id: string) => StyleSheet.flatten(screen.getByTestId(id).props.style) as Record<string, unknown>;
  const PLUS_PATH = 'M12 5v14M5 12h14';
  const faces = {
    ...baseProps.fonts,
    regular: 'NotoNaskhArabic_400Regular', semibold: 'NotoNaskhArabic_600SemiBold', lineRatio: 1.6,
    forText: (value: string, weight: 'regular' | 'semibold') => /[\u0600-\u06FF]/.test(value) || !/[A-Za-z]/.test(value)
      ? { fontFamily: weight === 'semibold' ? 'NotoNaskhArabic_600SemiBold' : 'NotoNaskhArabic_400Regular', lineRatio: 1.6 }
      : { fontFamily: weight === 'semibold' ? 'Outfit_600SemiBold' : 'Outfit_400Regular', lineRatio: 1.4 },
  };

  it('the row checkbox and its «…» are each at least 44 tall', async () => {
    await render(<SayItChatPage {...baseProps} onRowToggle={() => {}} onRowPress={() => {}}
      scheduleGroups={[{ id: 'g', title: 'Tomorrow', rows: [{ id: 'doctor', title: 'Doctor', selected: true }] }]} />);
    expect(flat('review-item-doctor').minHeight as number).toBeGreaterThanOrEqual(44);
    expect(flat('review-edit-doctor').minHeight as number).toBeGreaterThanOrEqual(44);
  });

  it('a Latin draft, message and title are set in the Latin face inside the Arabic page', async () => {
    const view = await render(<SayItChatPage {...baseProps} rtl fonts={faces} text="Dentist tomorrow at 5pm"
      outgoing={{ text: 'Dentist tomorrow at 5pm' }} onRowToggle={() => {}}
      scheduleGroups={[{ id: 'g', title: 'بكرا', rows: [{ id: 'd', title: 'Dentist', selected: true }] }]} />);
    expect(flat('capture-input').fontFamily).toBe('Outfit_400Regular');
    expect(flat('chat-outgoing-text').fontFamily).toBe('Outfit_400Regular');
    expect(flat('review-title-d').fontFamily).toBe('Outfit_400Regular');
    // Arabic words, and the empty field under its Arabic placeholder, keep Naskh.
    await view.rerender(<SayItChatPage {...baseProps} rtl fonts={faces} text="" />);
    expect(flat('capture-input').fontFamily).toBe('NotoNaskhArabic_400Regular');
    await view.rerender(<SayItChatPage {...baseProps} rtl fonts={faces} text="موعد مع Sami" />);
    expect(flat('capture-input').fontFamily).toBe('NotoNaskhArabic_400Regular');
  });

  it('a finished reply is read out as its words, never as the typing bubble\u2019s «بنفهمها…»', async () => {
    const typingLabel = 'بنفهمها…';
    const user = { role: 'user' as const, text: 'Dentist on Friday at 4pm' };
    const view = await render(<SayItChatPage {...baseProps} rtl fonts={faces} history={[user]}
      typing={<Text>…</Text>} typingLabel={typingLabel} />);
    expect(screen.getByTestId('chat-typing').props.accessibilityLabel).toBe(typingLabel);

    const reply = 'Dentist on Friday at 4 PM. Confirm below.';
    await view.rerender(<SayItChatPage {...baseProps} rtl fonts={faces} history={[user, { role: 'assistant', text: reply }]} />);
    expect(screen.queryByTestId('chat-typing')).toBeNull();
    expect(screen.getByTestId('chat-turn-assistant-1').props.accessibilityLabel).toBe(reply);
    expect(screen.queryAllByLabelText(typingLabel)).toHaveLength(0);

    // The next message: the older reply moves up and keeps its own words; the new one has its own.
    const next = 'تمام، غيّرتها. أي ساعة بدك «Call Sara»؟';
    await view.rerender(<SayItChatPage {...baseProps} rtl fonts={faces}
      history={[user, { role: 'assistant', text: reply }, { role: 'user', text: 'make it 5' }]} typing={<Text>…</Text>} typingLabel={typingLabel} />);
    await view.rerender(<SayItChatPage {...baseProps} rtl fonts={faces}
      history={[user, { role: 'assistant', text: reply }, { role: 'user', text: 'make it 5' }, { role: 'assistant', text: next }]} />);
    expect(screen.getByTestId('chat-turn-assistant-1').props.accessibilityLabel).toBe(reply);
    expect(screen.getByTestId('chat-turn-assistant-3').props.accessibilityLabel).toBe(next);
    expect(screen.queryAllByLabelText(typingLabel)).toHaveLength(0);
  });

  it('an assistant reply is set in the face of its own alphabet, as the person\u2019s message is', async () => {
    await render(<SayItChatPage {...baseProps} rtl fonts={faces} history={[
      { role: 'user', text: 'Dentist on Friday at 4pm' },
      { role: 'assistant', text: 'Dentist on Friday at 4 PM. Confirm below.' },
      { role: 'user', text: 'بكرا الساعة 5' },
      { role: 'assistant', text: 'تمام، بكرا الساعة 5 المسا. أكّد من تحت.' },
    ]} />);
    expect(flat('chat-turn-assistant-1-text-0').fontFamily).toBe('Outfit_400Regular');
    expect(flat('chat-turn-assistant-3-text-0').fontFamily).toBe('NotoNaskhArabic_400Regular');
  });

  it('the paste control draws a clipboard, not a plus', async () => {
    await render(<SayItChatPage {...baseProps} />);
    const paste = screen.getByTestId('capture-paste');
    expect(paste.props.accessibilityLabel).toBe('Paste');
    expect(paste.queryAll(node => node.props.d === PLUS_PATH)).toHaveLength(0);
    expect(paste.queryAll(node => node.props.d === 'M9 11h6M9 15h4')).toHaveLength(1);
  });
});
