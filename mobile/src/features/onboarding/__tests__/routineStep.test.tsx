/**
 * The routine survey screen (UC-2.R1 #171, reused by Settings in #174).
 *
 * The disclosure line is the one thing here that is not a preference control:
 * these five answers leave the device, and that line is the only notice the
 * user gets. It has a test of its own, in all three languages, and one that
 * fails if it stops being rendered at all.
 */
import React, { useState } from 'react';
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { readFileSync } from 'fs';
import { join } from 'path';
import { I18nManager } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { AppProvider } from '../../../state/AppContext';
import { RoutineStep } from '../RoutineStep';
import { EMPTY_ANSWERS, toRoutinePayload, type RoutineAnswers } from '../../routine/routineProfile';
import en from '../../../i18n/locales/en.json';
import ar from '../../../i18n/locales/ar.json';
import he from '../../../i18n/locales/he.json';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

/**
 * The answers the screen currently holds, published through a callback rather
 * than assigned from the render body — the React Compiler lint rightly refuses
 * a component that writes to a variable outside itself.
 */
let latest: RoutineAnswers = EMPTY_ANSWERS;

function Harness(props: Partial<React.ComponentProps<typeof RoutineStep>>) {
  const [answers, setAnswers] = useState<RoutineAnswers>(EMPTY_ANSWERS);
  const publish = (update: (previous: RoutineAnswers) => RoutineAnswers) => {
    setAnswers(previous => {
      const next = update(previous);
      latest = next;
      return next;
    });
  };
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <RoutineStep
          answers={answers}
          onChange={publish}
          onContinue={() => {}}
          {...props}
        />
      </AppProvider>
    </SafeAreaProvider>
  );
}

async function show(props: Partial<React.ComponentProps<typeof RoutineStep>> = {}) {
  latest = EMPTY_ANSWERS;
  return render(<Harness {...props} />);
}

/** React 19 schedules rather than applies; every event has to be awaited. */
async function press(label: string): Promise<void> {
  fireEvent.press(screen.getByLabelText(label));
  await waitFor(() => expect(screen.queryByLabelText(label)).not.toBeNull());
}

describe('the account-sync disclosure', () => {
  it('is on the screen, above the questions', async () => {
    await show();
    expect(screen.queryByTestId('routine-sync-disclosure')).not.toBeNull();
    expect(screen.queryByText(en.obRoutineSync)).not.toBeNull();
  });

  it('says both halves: where the answers go, and how to remove them', async () => {
    // A notice that only said "saved to your account" would be half of it.
    expect(en.obRoutineSync).toMatch(/account/i);
    expect(en.obRoutineSync).toMatch(/Settings/i);
  });

  it('exists in all three languages', async () => {
    for (const bundle of [en, ar, he]) {
      expect((bundle as unknown as Record<string, string>).obRoutineSync).toBeTruthy();
      expect((bundle as unknown as Record<string, string>).obRoutineSync!.length).toBeGreaterThan(30);
    }
  });
});

describe('answering', () => {
  it('records the chosen chip', async () => {
    await show();
    await press(en.obRoutineSleepStandard);
    expect(latest.sleep).toBe('standard');
  });

  it('lets a mistap be undone by pressing the same chip again', async () => {
    // The survey is skippable, so "I would rather not answer this one" has to
    // stay reachable after a wrong tap.
    await show();
    await press(en.obRoutineQuietLate);
    expect(latest.quiet).toBe('late');
    await press(en.obRoutineQuietLate);
    expect(latest.quiet).toBeNull();
  });

  it('keeps answers to different questions independent', async () => {
    await show();
    await press(en.obRoutineSleepEarly);
    await press(en.obRoutineReminderStrong);
    expect(latest.sleep).toBe('early');
    expect(latest.reminder).toBe('strong');
  });

  it('turns the chosen chips into the windows the server stores', async () => {
    await show();
    await press(en.obRoutineSleepEarly);
    await press(en.obRoutineFocusAfternoon);
    expect(toRoutinePayload(latest, 'Asia/Jerusalem')).toMatchObject({
      sleepWindow: { start: '22:30', end: '06:30' },
      focusWindows: [{ start: '12:00', end: '18:00', label: 'work_study' }],
    });
  });
});

describe('skipping', () => {
  it('is offered, and is not the same button as Continue', async () => {
    const onSkip = jest.fn();
    const onContinue = jest.fn();
    await show({ onSkip, onContinue });
    await press(en.obSkip);
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onContinue).not.toHaveBeenCalled();
  });
});

describe('reuse from Settings', () => {
  it('renders the questions without the onboarding chrome', async () => {
    // UC-2.R4 (#174) shows the same five questions inside the settings screen,
    // so the step has to be usable without its footer and progress bar.
    await show({ mode: 'settings' });
    expect(screen.queryByText(en.obRoutineSleep)).not.toBeNull();
    expect(screen.queryByLabelText(en.obContinue)).toBeNull();
    expect(screen.queryByTestId('onboarding-progress-routine')).toBeNull();
  });

  it('still shows the disclosure there', async () => {
    // Changing an answer in Settings syncs it too, so the notice belongs on
    // both surfaces.
    await show({ mode: 'settings' });
    expect(screen.queryByTestId('routine-sync-disclosure')).not.toBeNull();
  });
});

describe('right-to-left', () => {
  it('lays the chips out from the writing direction, with no left/right offsets', () => {
    // The root view sets `direction: 'rtl'` once and every row mirrors from it
    // (src/i18n/README.md). A `left`/`right` offset anywhere in this screen
    // would survive that flip and land on the wrong side in Arabic.
    for (const file of ['RoutineStep.tsx', 'ConsentStep.tsx', 'OnboardingChrome.tsx', 'WelcomeStep.tsx', 'NotificationsStep.tsx']) {
      const source = readFileSync(join(__dirname, '..', file), 'utf8');
      expect(source).not.toMatch(/(?:^|[^a-zA-Z])(?:left|right):\s/m);
      expect(source).not.toMatch(/marginLeft|marginRight|paddingLeft|paddingRight|borderLeftWidth|borderRightWidth/);
    }
  });

  it('renders in Arabic without the layout being rewritten', async () => {
    expect(I18nManager.isRTL).toBe(false);
    // The app never calls forceRTL — asserted by the lint rule in
    // eslint.config.js and relied on here: these screens work in both
    // directions from one tree, which is why a language switch needs no
    // restart.
    await show();
    expect(screen.queryByText(en.obRoutineSleep)).not.toBeNull();
  });
});
