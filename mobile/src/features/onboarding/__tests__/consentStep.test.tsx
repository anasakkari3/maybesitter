/**
 * The consent controls themselves (UC-2.R1 #171).
 *
 * Rendered directly, with the flow's plumbing replaced by props, so what is
 * being checked is the *screen's* promises: nothing pre-selected, and AI
 * processing disclosed rather than asked (owner decision 2026-09-30) — no
 * allow/decline, and nothing to answer before Continue.
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

const EMPTY: ConsentChoices = { recommendations: false, analytics: false };

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
  await fireEvent.press(screen.getByLabelText(label));
  await waitFor(() => expect(screen.queryByLabelText(label)).not.toBeNull());
}

async function toggle(label: string, value: boolean): Promise<void> {
  await fireEvent(screen.getByLabelText(label), 'valueChange', value);
  await waitFor(() => expect(screen.getByLabelText(label).props.value).toBe(value));
}

describe('nothing is chosen for the user', () => {
  it('leaves both switches off', async () => {
    await show();
    expect(screen.getByLabelText(en.obRecTitle).props.value).toBe(false);
    expect(screen.getByLabelText(en.obAnalyticsTitle).props.value).toBe(false);
  });

  it('continues with nothing answered: staying off is a complete answer', async () => {
    const onContinue = jest.fn();
    await show({ onContinue });
    await press(en.obContinue);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });
});

describe('two quick taps', () => {
  it('do not lose the first answer', async () => {
    // The defect this pins: each control used to build its next state from the
    // `choices` captured at render, so a second answer in the same batch
    // clobbered the first.
    const onContinue = jest.fn();
    await show({ onContinue });
    await toggle(en.obRecTitle, true);
    await toggle(en.obAnalyticsTitle, true);

    expect(screen.getByLabelText(en.obRecTitle).props.value).toBe(true);
    expect(screen.getByLabelText(en.obAnalyticsTitle).props.value).toBe(true);
    await press(en.obContinue);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });
});

describe('AI processing is disclosed, not asked (owner decision 2026-09-30)', () => {
  it('shows the disclosure, before the first capture, with nothing to press', async () => {
    await show();
    const card = screen.getByTestId('onboarding-ai-disclosure');
    expect(card).toBeTruthy();
    expect(screen.queryByText(en.aiDisclosureTitle)).not.toBeNull();
    expect(screen.queryByText(en.aiDisclosure)).not.toBeNull();
    expect(screen.queryByText(en.aiDisclosureKept)).not.toBeNull();
    // No allow/decline, no radio group: the AI question is gone.
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('names Google’s Gemini (Vertex AI) and the EU, and claims nothing is optional', async () => {
    for (const bundle of [en, ar, he]) {
      const line = (bundle as unknown as Record<string, string>).aiDisclosure!;
      expect(line).toContain('Gemini');
      expect(line).toContain('Vertex AI');
      expect(line).toContain('Google');
      for (const key of ['aiDisclosureTitle', 'aiDisclosure', 'aiDisclosureKept', 'obRecTitle', 'obAnalyticsTitle'] as const) {
        expect((bundle as unknown as Record<string, string>)[key]).toBeTruthy();
      }
    }
    // The old card said "changeable in Settings" about AI; that is no longer true.
    for (const text of [en.aiDisclosure, en.aiDisclosureKept]) expect(text).not.toMatch(/settings|optional|turn (it )?off/i);
  });
});

describe('waiting for the server', () => {
  it('does not offer Continue before the consent versions have arrived', async () => {
    const onContinue = jest.fn();
    await show({ ready: false, onContinue });
    await press(en.obContinue);
    expect(onContinue).not.toHaveBeenCalled();
  });

  it('says nothing was changed and offers a retry when a write failed', async () => {
    await show({ failed: true });
    expect(screen.queryByText(en.obConsentFailed)).not.toBeNull();
    expect(screen.queryByLabelText(en.obConsentRetry)).not.toBeNull();
  });

  it('does not accept a second press while the first is still in flight', async () => {
    const onContinue = jest.fn();
    await show({ saving: true, onContinue });
    await press(en.obConsentSaving);
    expect(onContinue).not.toHaveBeenCalled();
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

  it('makes the disclosure title a header', async () => {
    await show();
    expect(screen.getByText(en.aiDisclosureTitle).props.accessibilityRole).toBe('header');
  });
});
