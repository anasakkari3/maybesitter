/**
 * The consent controls themselves (UC-2.R1 #171).
 *
 * Rendered directly, with the flow's plumbing replaced by props, so what is
 * being checked is the *screen's* promises: nothing pre-selected, no way past
 * it without an answer, and no dark pattern in either direction.
 */
import React, { useState } from 'react';
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { AppProvider } from '../../../state/AppContext';
import { ConsentStep, type ConsentChoices } from '../ConsentStep';
import en from '../../../i18n/locales/en.json';
import ar from '../../../i18n/locales/ar.json';
import he from '../../../i18n/locales/he.json';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const EMPTY: ConsentChoices = { ai: null, recommendations: false, analytics: false };

/** Holds the choices in state, the way the flow does, so updates are real. */
function Harness({
  initial = EMPTY, onContinue = () => {}, ...rest
}: Partial<React.ComponentProps<typeof ConsentStep>> & { initial?: ConsentChoices }) {
  const [choices, setChoices] = useState(initial);
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <ConsentStep
          choices={choices}
          onChange={setChoices}
          onContinue={onContinue}
          onBack={() => {}}
          {...rest}
        />
      </AppProvider>
    </SafeAreaProvider>
  );
}

async function show(props: Parameters<typeof Harness>[0] = {}) {
  return render(<Harness {...props} />);
}

/**
 * Press, then let React settle.
 *
 * React 19 renders concurrently: `fireEvent` schedules the update rather than
 * applying it, so an assertion on the next line reads the tree from *before*
 * the press. Every event in this file goes through here.
 */
async function press(label: string): Promise<void> {
  fireEvent.press(screen.getByLabelText(label));
  await waitFor(() => expect(screen.queryByLabelText(label)).not.toBeNull());
}

async function toggle(label: string, value: boolean): Promise<void> {
  fireEvent(screen.getByLabelText(label), 'valueChange', value);
  await waitFor(() => expect(screen.getByLabelText(label).props.value).toBe(value));
}

describe('nothing is chosen for the user', () => {
  it('leaves both switches off and neither AI answer selected', async () => {
    await show();
    expect(screen.getByLabelText(en.obRecTitle).props.value).toBe(false);
    expect(screen.getByLabelText(en.obAnalyticsTitle).props.value).toBe(false);
    // The absence of an answer is visible rather than implied: the screen says
    // what it is waiting for.
    expect(screen.queryByText(en.obConsentNeedAi)).not.toBeNull();
  });

  it('will not continue until the AI question is answered', async () => {
    const onContinue = jest.fn();
    await show({ onContinue });
    await press(en.obContinue);
    expect(onContinue).not.toHaveBeenCalled();
  });

  it('continues once it is answered, whichever answer was given', async () => {
    const onContinue = jest.fn();
    await show({ onContinue });
    await press(en.obAiAllow);
    await press(en.obContinue);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('continues on a decline just as readily as on an allow', async () => {
    const onContinue = jest.fn();
    await show({ onContinue });
    await press(en.obAiDecline);
    await press(en.obContinue);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });
});

describe('two quick taps', () => {
  it('do not lose the first answer', async () => {
    // The defect this pins: each control used to build its next state from the
    // `choices` captured at render, so a switch flicked right after the AI
    // answer clobbered it — and the answer that vanished was the AI one.
    const onContinue = jest.fn();
    await show({ onContinue });
    await press(en.obAiAllow);
    await toggle(en.obRecTitle, true);
    await toggle(en.obAnalyticsTitle, true);

    expect(screen.getByLabelText(en.obRecTitle).props.value).toBe(true);
    expect(screen.getByLabelText(en.obAnalyticsTitle).props.value).toBe(true);
    // And the AI answer survived both switches: Continue is reachable.
    await press(en.obContinue);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });
});

describe('declining AI', () => {
  it('says what still works, rather than what is lost', async () => {
    await show();
    expect(screen.queryByText(en.obAiDeclinedNote)).toBeNull();
    await press(en.obAiDecline);
    await waitFor(() => expect(screen.queryByText(en.obAiDeclinedNote)).not.toBeNull());
  });

  it('is offered as an equal choice, not a smaller one', async () => {
    // Both answers are buttons in the same row with the same role. A decline
    // rendered as a text link under a filled "Allow" is the dark pattern this
    // guards against.
    await show();
    for (const label of [en.obAiAllow, en.obAiDecline]) {
      expect(screen.getByLabelText(label).props.accessibilityRole).toBe('button');
    }
  });
});

describe('waiting for the server', () => {
  it('does not offer Continue before the consent versions have arrived', async () => {
    const onContinue = jest.fn();
    await show({ initial: { ...EMPTY, ai: 'granted' }, ready: false, onContinue });
    await press(en.obContinue);
    expect(onContinue).not.toHaveBeenCalled();
  });

  it('says nothing was changed and offers a retry when a write failed', async () => {
    await show({ initial: { ...EMPTY, ai: 'granted' }, failed: true });
    expect(screen.queryByText(en.obConsentFailed)).not.toBeNull();
    expect(screen.queryByLabelText(en.obConsentRetry)).not.toBeNull();
  });

  it('does not accept a second press while the first is still in flight', async () => {
    const onContinue = jest.fn();
    await show({ initial: { ...EMPTY, ai: 'granted' }, saving: true, onContinue });
    await press(en.obConsentSaving);
    expect(onContinue).not.toHaveBeenCalled();
  });
});

describe('what the AI card promises', () => {
  it('names what is sent, to whom, why, and what never is', async () => {
    await show();
    for (const line of [en.obAiWhatIsSent, en.obAiToWhom, en.obAiWhy, en.obAiNotSent]) {
      expect(screen.queryByText(line)).not.toBeNull();
    }
  });

  it('has that copy in all three languages', async () => {
    // Hebrew is not selectable yet (no reviewed copy, no Hebrew glyphs in the
    // shipped fonts — see src/i18n/README.md), but the strings exist and stay
    // in parity so enabling it is a font decision, not a translation project.
    for (const bundle of [en, ar, he]) {
      for (const key of ['obAiTitle', 'obAiWhatIsSent', 'obAiToWhom', 'obAiWhy', 'obAiNotSent',
        'obAiAllow', 'obAiDecline', 'obRecTitle', 'obAnalyticsTitle'] as const) {
        expect((bundle as unknown as Record<string, string>)[key]).toBeTruthy();
      }
    }
  });
});

describe('accessibility', () => {
  it('gives each toggle a switch role and a label', async () => {
    await show();
    for (const label of [en.obRecTitle, en.obAnalyticsTitle]) {
      const control = screen.getByLabelText(label);
      expect(control.props.accessibilityRole).toBe('switch');
    }
  });

  it('groups the two AI answers as a radio group', async () => {
    await show();
    expect(screen.getByLabelText(en.obAiTitle).props.accessibilityRole).toBe('radiogroup');
  });
});
