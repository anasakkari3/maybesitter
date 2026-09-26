/**
 * One question at a time (UC-3.17, #469).
 *
 * ── What the screen is for ───────────────────────────────────────
 *
 * The step's job is to get an answer where a blank box got none, without
 * ever trapping anyone: a chip fills the field, Back always exists, and
 * "Skip for now" is on every question rather than hidden behind the last one.
 *
 * ── Why the callbacks are spied rather than the flow driven ──────
 *
 * The flow test (`onboardingFlow.test.tsx`) proves the answers reach the
 * describe endpoint. This one proves the screen's own contract: which
 * callback each button calls, on which question, with what on screen. The
 * two together make "Read my answers" mean something; neither does alone.
 */
import React, { useState } from 'react';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { AppProvider } from '../../../state/AppContext';
import { SetupChatStep } from '../SetupChatStep';
import { EMPTY_SETUP_ANSWERS, type SetupAnswers } from '../setupChat';
import en from '../../../i18n/locales/en.json';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

afterEach(() => {
  cleanup();
});

/** Mounts the step with every callback spied; the answers are what the caller says. */
async function renderStep(
  overrides: Partial<{ answers: SetupAnswers; index: number; reading: boolean; failed: boolean }> = {},
) {
  const onChange = jest.fn<(update: (previous: SetupAnswers) => SetupAnswers) => void>();
  const onIndexChange = jest.fn<(index: number) => void>();
  const onRead = jest.fn<() => void>();
  const onSkip = jest.fn<() => void>();
  const onBack = jest.fn<() => void>();
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <SetupChatStep
          answers={overrides.answers ?? EMPTY_SETUP_ANSWERS}
          index={overrides.index ?? 0}
          onChange={onChange}
          onIndexChange={onIndexChange}
          onRead={onRead}
          onSkip={onSkip}
          onBack={onBack}
          reading={overrides.reading ?? false}
          failed={overrides.failed ?? false}
        />
      </AppProvider>
    </SafeAreaProvider>,
  );
  return { onChange, onIndexChange, onRead, onSkip, onBack };
}

async function press(label: string) {
  await fireEvent.press(screen.getByLabelText(label));
}

describe('the first question', () => {
  // Its own screen now; its contract is in setupLifeStep.test.tsx. Here only
  // that the step hands it over and the short-question furniture is gone.
  it('is the life narrative, not a short question', async () => {
    await renderStep();
    expect(screen.queryByText(en.obSetupLifeTitle)).not.toBeNull();
    expect(screen.queryByTestId('setup-life-input')).not.toBeNull();
    expect(screen.queryByTestId('setup-question-of')).toBeNull();
    expect(screen.queryByTestId('setup-answer-count')).toBeNull();
  });
});

describe('a later question', () => {
  it('says which question it is', async () => {
    await renderStep({ index: 1 });
    expect(screen.queryByText(en.obSetupDayPrompt)).not.toBeNull();
    expect(screen.getByTestId('setup-question-of').props.children).toBe('Question 2 of 5');
  });
});

describe('answering', () => {
  it('fills the field with the chip that was tapped', async () => {
    const { onChange } = await renderStep({ index: 1 });
    await fireEvent.press(screen.getByTestId('setup-chip-day-2'));
    expect(onChange).toHaveBeenCalledTimes(1);
    // The updater form, so two quick taps cannot lose one another.
    const next = onChange.mock.calls[0]![0](EMPTY_SETUP_ANSWERS);
    expect(next).toEqual({ ...EMPTY_SETUP_ANSWERS, day: en.obSetupDayChip2 });
  });

  it('shows the chip as selected once the field holds its text', async () => {
    await renderStep({ index: 1, answers: { ...EMPTY_SETUP_ANSWERS, day: en.obSetupDayChip2 } });
    // The chip whose text is in the field is filled; the others are outlined.
    const background = (testID: string) =>
      (StyleSheet.flatten(screen.getByTestId(testID).props.style) as { backgroundColor?: string }).backgroundColor;
    expect(background('setup-chip-day-2')).not.toBe('transparent');
    expect(background('setup-chip-day-1')).toBe('transparent');
    expect(screen.getByTestId('setup-answer-input').props.value).toBe(en.obSetupDayChip2);
  });

  it('takes typing too, clamped to the answer cap, and counts it', async () => {
    const { onChange } = await renderStep({ index: 1 });
    await fireEvent.changeText(screen.getByTestId('setup-answer-input'), 'I teach');
    const next = onChange.mock.calls[0]![0](EMPTY_SETUP_ANSWERS);
    expect(next.day).toBe('I teach');
    expect(screen.getByTestId('setup-answer-input').props.maxLength).toBe(150);
  });

  it('shows how much of the cap is used', async () => {
    await renderStep({ index: 1, answers: { ...EMPTY_SETUP_ANSWERS, day: 'I teach' } });
    expect(screen.getByTestId('setup-answer-count').props.children).toBe('7 / 150');
  });

  it('shows the smaller cap when a long narrative has used the budget', async () => {
    const answers: SetupAnswers = {
      life: 'l'.repeat(600), day: 'd'.repeat(150), places: 'p'.repeat(150), done: '', habits: '',
    };
    await renderStep({ index: 3, answers });
    const cap = screen.getByTestId('setup-answer-input').props.maxLength as number;
    expect(cap).toBeLessThan(150);
    expect(screen.getByTestId('setup-answer-count').props.children).toBe(`0 / ${cap}`);
  });
});

/**
 * The chips combine (closure CL2b, complaint #3).
 *
 * On the 2026-09-26 simulator run the second chip tapped on "What does a
 * typical day look like?" replaced the first (evidence shot 22). A day can be
 * "long hours" *and* "every day is different"; the literal repro is two taps
 * on the same question, so these drive a stateful harness rather than a spy.
 */
function Harness({ initial = EMPTY_SETUP_ANSWERS }: { initial?: SetupAnswers }) {
  const [answers, setAnswers] = useState<SetupAnswers>(initial);
  return (
    <SetupChatStep
      answers={answers}
      index={1}
      onChange={(update) => setAnswers(update)}
      onIndexChange={() => {}}
      onRead={() => {}}
      onSkip={() => {}}
      onBack={() => {}}
    />
  );
}

async function renderHarness(initial?: SetupAnswers) {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <Harness {...(initial ? { initial } : {})} />
      </AppProvider>
    </SafeAreaProvider>,
  );
}

const fieldValue = () => screen.getByTestId('setup-answer-input').props.value as string;
const checked = (testID: string) =>
  (screen.getByTestId(testID).props.accessibilityState as { checked?: boolean } | undefined)?.checked;

describe('combining chips', () => {
  it('a second chip adds to the first instead of replacing it, in the order tapped', async () => {
    await renderHarness();
    await fireEvent.press(screen.getByTestId('setup-chip-day-3'));
    await fireEvent.press(screen.getByTestId('setup-chip-day-2'));
    expect(fieldValue()).toBe(`${en.obSetupDayChip3}, ${en.obSetupDayChip2}`);
  });

  it('is a checkbox, and both chips read as checked', async () => {
    await renderHarness();
    await fireEvent.press(screen.getByTestId('setup-chip-day-3'));
    await fireEvent.press(screen.getByTestId('setup-chip-day-2'));
    expect(screen.getByTestId('setup-chip-day-3').props.accessibilityRole).toBe('checkbox');
    expect(checked('setup-chip-day-3')).toBe(true);
    expect(checked('setup-chip-day-2')).toBe(true);
    expect(checked('setup-chip-day-1')).toBe(false);
  });

  it('tapping a checked chip takes it out and leaves the others', async () => {
    await renderHarness();
    await fireEvent.press(screen.getByTestId('setup-chip-day-1'));
    await fireEvent.press(screen.getByTestId('setup-chip-day-3'));
    await fireEvent.press(screen.getByTestId('setup-chip-day-4'));
    await fireEvent.press(screen.getByTestId('setup-chip-day-3'));
    expect(fieldValue()).toBe(`${en.obSetupDayChip1}, ${en.obSetupDayChip4}`);
    expect(checked('setup-chip-day-3')).toBe(false);
  });

  it('keeps what was typed and adds the chip after it', async () => {
    await renderHarness();
    await fireEvent.changeText(screen.getByTestId('setup-answer-input'), 'I teach');
    await fireEvent.press(screen.getByTestId('setup-chip-day-4'));
    expect(fieldValue()).toBe(`I teach, ${en.obSetupDayChip4}`);
    expect(checked('setup-chip-day-4')).toBe(true);
  });

  it('does not light a chip whose words only sit inside a longer sentence', async () => {
    await renderHarness({ ...EMPTY_SETUP_ANSWERS, day: `Honestly ${en.obSetupDayChip4.toLowerCase()} and ${en.obSetupDayChip4}ish` });
    expect(checked('setup-chip-day-4')).toBe(false);
  });
});

describe('over the cap', () => {
  // The chips are not cut to fit any more: a cut chip would be words the user
  // never chose. So the whole text is shown, the counter says it is over, and
  // Next waits until they trim it.
  const overCap = { ...EMPTY_SETUP_ANSWERS, day: `${'x'.repeat(140)}` };

  it('shows the whole combined text, says it is too long, and blocks Next', async () => {
    await renderHarness(overCap);
    await fireEvent.press(screen.getByTestId('setup-chip-day-3'));
    const value = fieldValue();
    expect(value).toBe(`${'x'.repeat(140)}, ${en.obSetupDayChip3}`);
    expect(Array.from(value).length).toBeGreaterThan(150);
    // The field must not truncate what it is showing.
    expect(screen.getByTestId('setup-answer-input').props.maxLength).toBeGreaterThanOrEqual(Array.from(value).length);
    expect(screen.getByTestId('setup-answer-count').props.children).toBe(`${Array.from(value).length} / 150`);
    expect(screen.queryByTestId('setup-answer-too-long')).not.toBeNull();
    expect(screen.getByLabelText(en.obSetupNext).props.accessibilityState).toMatchObject({ disabled: true });
  });

  it('blocks Read on the last question the same way', async () => {
    const { onRead } = await renderStep({ index: 4, answers: { ...EMPTY_SETUP_ANSWERS, habits: 'h'.repeat(151) } });
    expect(screen.queryByTestId('setup-answer-too-long')).not.toBeNull();
    await press(en.obSetupRead);
    expect(onRead).not.toHaveBeenCalled();
  });

  it('lets Next through again once trimmed back under the cap', async () => {
    await renderHarness(overCap);
    await fireEvent.press(screen.getByTestId('setup-chip-day-3'));
    await fireEvent.press(screen.getByTestId('setup-chip-day-3'));
    expect(screen.queryByTestId('setup-answer-too-long')).toBeNull();
    expect(screen.getByLabelText(en.obSetupNext).props.accessibilityState).toMatchObject({ disabled: false });
  });
});

describe('moving between questions', () => {
  it('Next moves to the following question', async () => {
    const { onIndexChange, onRead } = await renderStep({ index: 1 });
    await press(en.obSetupNext);
    expect(onIndexChange).toHaveBeenCalledWith(2);
    expect(onRead).not.toHaveBeenCalled();
  });

  it('Back on a later question moves to the previous one, not out of the step', async () => {
    const { onIndexChange, onBack } = await renderStep({ index: 2 });
    await press(en.obBack);
    expect(onIndexChange).toHaveBeenCalledWith(1);
    expect(onBack).not.toHaveBeenCalled();
  });

  // One `it` per question rather than a loop with a `cleanup()` inside it:
  // a mid-test cleanup leaves the next render mounting nothing (RNTL v14).
  it.each([0, 1, 2, 3, 4])('offers Skip on question %i', async (index) => {
    const { onSkip } = await renderStep({ index });
    expect(screen.queryByTestId('setup-skip')).not.toBeNull();
    await fireEvent.press(screen.getByTestId('setup-skip'));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });
});

describe('the last question', () => {
  it('reads the answers when there is at least one', async () => {
    const { onRead, onSkip } = await renderStep({
      index: 4, answers: { ...EMPTY_SETUP_ANSWERS, places: 'The gym' },
    });
    expect(screen.queryByText(en.obSetupHabitsPrompt)).not.toBeNull();
    expect(screen.queryByText(en.obSetupNext)).toBeNull();
    await press(en.obSetupRead);
    expect(onRead).toHaveBeenCalledTimes(1);
    expect(onSkip).not.toHaveBeenCalled();
  });

  it('finishes without answers when there are none — which is a skip', async () => {
    const { onRead, onSkip } = await renderStep({ index: 4 });
    expect(screen.queryByText(en.obSetupRead)).toBeNull();
    await press(en.obSetupFinish);
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onRead).not.toHaveBeenCalled();
  });

  it('says it is reading, and will not send twice', async () => {
    const { onRead } = await renderStep({
      index: 4, answers: { ...EMPTY_SETUP_ANSWERS, places: 'The gym' }, reading: true,
    });
    expect(screen.queryByText(en.obSetupRead)).toBeNull();
    await press(en.obAboutReading);
    expect(onRead).not.toHaveBeenCalled();
  });

  it('says when the read failed, and that nothing was saved', async () => {
    await renderStep({ index: 4, answers: { ...EMPTY_SETUP_ANSWERS, places: 'The gym' }, failed: true });
    expect(screen.queryByText(en.obAboutFailed)).not.toBeNull();
  });
});
