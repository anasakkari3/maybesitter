/**
 * Combining clarification options into the free-text answer (closure CL2b,
 * complaint #3: "I can't combine the suggested options").
 *
 * The options are mutually exclusive by contract — one `optionId` is one slot.
 * So where the question takes no free text (am/pm) a tap is still the answer.
 * Where it does take free text, a tap writes the option into the field instead
 * of sending it, so "morning, evening" can be said; «تمام» sends. A field that
 * holds exactly one option still goes as that option, so the structured answer
 * is kept whenever it is what the user picked. "No specific time" is not a
 * slot and cannot be combined with one: it is still answered on tap.
 */
import React from 'react';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { AppProvider } from '../../../state/AppContext';
import { ClarifySheet } from '../ClarifySheet';
import type { CaptureProposalItem } from '../../../api/schemas/capture';
import en from '../../../i18n/locales/en.json';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

afterEach(() => {
  cleanup();
});

const day = '2099-01-02';

function timeItem(): CaptureProposalItem {
  return {
    itemId: 'item-a',
    title: 'Call Dana',
    resolvedTime: null,
    needsClarification: true,
    clarification: {
      questionId: 'q-time',
      field: 'time',
      questionKey: 'ask_time',
      params: { title: 'Call Dana' },
      options: [
        { optionId: 'morning', labelKey: 'morning', labelParams: {}, value: { localTime: '09:00', localDate: day } },
        { optionId: 'evening', labelKey: 'evening', labelParams: {}, value: { localTime: '19:00', localDate: day } },
        { optionId: 'none', labelKey: 'noTime', labelParams: {}, value: {} },
      ],
      allowFreeText: true,
    },
  } as unknown as CaptureProposalItem;
}

function amPmItem(): CaptureProposalItem {
  return {
    itemId: 'item-b',
    title: 'Gym',
    resolvedTime: null,
    needsClarification: true,
    clarification: {
      questionId: 'q-ampm',
      field: 'time_period',
      questionKey: 'ask_am_pm',
      params: { hour: '5', title: 'Gym' },
      options: [
        { optionId: 'am', labelKey: 'amPmOption', labelParams: { hour: '5', period: 'am' }, value: { localTime: '05:00', localDate: day } },
        { optionId: 'pm', labelKey: 'amPmOption', labelParams: { hour: '5', period: 'pm' }, value: { localTime: '17:00', localDate: day } },
      ],
      allowFreeText: false,
    },
  } as unknown as CaptureProposalItem;
}

async function show(item: CaptureProposalItem) {
  const onAnswer = jest.fn<(answer: { optionId?: string; freeText?: string }) => void>();
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <ClarifySheet item={item} position={1} total={1} busy={false} onAnswer={onAnswer} onSkip={() => {}} />
      </AppProvider>
    </SafeAreaProvider>,
  );
  return onAnswer;
}

const field = () => screen.getByTestId('clarify-free-text').props.value as string;
const checked = (testID: string) =>
  (screen.getByTestId(testID).props.accessibilityState as { checked?: boolean } | undefined)?.checked;

describe('a question that takes free text', () => {
  it('two option taps combine in the field and nothing is sent until «تمام»', async () => {
    const onAnswer = await show(timeItem());
    await fireEvent.press(screen.getByTestId('clarify-option-morning'));
    await fireEvent.press(screen.getByTestId('clarify-option-evening'));
    expect(onAnswer).not.toHaveBeenCalled();
    expect(field()).toBe(`${en.clarifyMorning}, ${en.clarifyEvening}`);
    expect(checked('clarify-option-morning')).toBe(true);
    expect(checked('clarify-option-evening')).toBe(true);

    await fireEvent.press(screen.getByTestId('clarify-send'));
    expect(onAnswer).toHaveBeenCalledWith({ freeText: `${en.clarifyMorning}, ${en.clarifyEvening}` });
  });

  it('one option alone is still sent as that option, not as words', async () => {
    const onAnswer = await show(timeItem());
    await fireEvent.press(screen.getByTestId('clarify-option-evening'));
    await fireEvent.press(screen.getByTestId('clarify-send'));
    expect(onAnswer).toHaveBeenCalledWith({ optionId: 'evening' });
  });

  it('a second tap takes the option back out', async () => {
    const onAnswer = await show(timeItem());
    await fireEvent.press(screen.getByTestId('clarify-option-morning'));
    await fireEvent.press(screen.getByTestId('clarify-option-evening'));
    await fireEvent.press(screen.getByTestId('clarify-option-morning'));
    expect(field()).toBe(en.clarifyEvening);
    expect(checked('clarify-option-morning')).toBe(false);
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('options are checkboxes here', async () => {
    await show(timeItem());
    expect(screen.getByTestId('clarify-option-morning').props.accessibilityRole).toBe('checkbox');
  });

  it('"No specific time" is not a slot: it answers on tap', async () => {
    const onAnswer = await show(timeItem());
    await fireEvent.press(screen.getByTestId('clarify-option-none'));
    expect(onAnswer).toHaveBeenCalledWith({ optionId: 'none' });
  });
});

describe('a question that takes no free text', () => {
  it('stays a single choice: a tap is the answer', async () => {
    const onAnswer = await show(amPmItem());
    expect(screen.getByTestId('clarify-option-pm').props.accessibilityRole).toBe('radio');
    await fireEvent.press(screen.getByTestId('clarify-option-pm'));
    expect(onAnswer).toHaveBeenCalledWith({ optionId: 'pm' });
  });
});
