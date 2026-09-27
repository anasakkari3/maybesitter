/**
 * A clarification time option is the answer, in one tap (closure CL2b, round 1).
 *
 * The options are mutually exclusive by contract: one `optionId`, one time.
 * CL2b first let time options be combined into the free-text field
 * («الصبح، المسا»), but a commitment holds one time, so the server read the
 * combination back as a single time (morning, 09:00) — silent data loss, for
 * an extra tap. The controller ruled it out: multi-select lives only in the
 * onboarding setup chips. These pin that a time option on a question that
 * *also* takes free text still submits on its own, immediately, as its id.
 */
import React from 'react';
import { afterEach, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { AppProvider } from '../../../state/AppContext';
import { ClarifySheet } from '../ClarifySheet';
import type { CaptureProposalItem } from '../../../api/schemas/capture';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

afterEach(() => {
  cleanup();
});

const day = '2099-01-02';

const item = {
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
    // Free text is allowed here too — the case CL2b had turned into a toggle.
    allowFreeText: true,
  },
} as unknown as CaptureProposalItem;

async function show() {
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

it('a time option submits on one tap, as its id, on a question that also takes free text', async () => {
  const onAnswer = await show();
  await fireEvent.press(screen.getByTestId('clarify-option-evening'));
  expect(onAnswer).toHaveBeenCalledTimes(1);
  expect(onAnswer).toHaveBeenCalledWith({ optionId: 'evening' });
  // Nothing was written into the free-text field on the way.
  expect(screen.getByTestId('clarify-free-text').props.value).toBe('');
});

it('the options stay a single choice: radios, not checkboxes', async () => {
  await show();
  expect(screen.getByTestId('clarify-option-morning').props.accessibilityRole).toBe('radio');
});
