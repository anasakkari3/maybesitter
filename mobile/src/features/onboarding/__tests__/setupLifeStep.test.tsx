/**
 * The first setup screen: "tell me about your life" (#469 follow-up).
 *
 * ── What these tests hold ────────────────────────────────────────
 *
 *  1. It reads as a conversation in all three languages: the heading, the
 *     invitation and the helper are the life-story copy, Arabic and Hebrew
 *     align to the right and English to the left, and there is no survey
 *     furniture — no "Question 1 of 5", no `0 / 150`.
 *  2. The narrative is free text and long: several lines, well past the old
 *     150, capped only at the narrative cap.
 *  3. The inspiration prompts are never answers. Tapping one leaves the
 *     answer exactly as it was.
 *  4. The CTA waits for something worth reading; "Not now" is always there
 *     and ends the step; Back leaves the step.
 *  5. Voice, when a recogniser exists, adds to what is written rather than
 *     replacing it, and never presses the CTA by itself.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { AppProvider } from '../../../state/AppContext';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import * as language from '../../../i18n/language';
import { SetupChatStep } from '../SetupChatStep';
import { EMPTY_SETUP_ANSWERS, MAX_LIFE_ANSWER_LENGTH, type SetupAnswers } from '../setupChat';
import type {
  SpeechCaptureCallbacks,
  SpeechCaptureService,
  SpeechStatus,
} from '../../capture/voice/SpeechCaptureService';
import ar from '../../../i18n/locales/ar.json';
import en from '../../../i18n/locales/en.json';
import he from '../../../i18n/locales/he.json';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

/** A recogniser that works, so voice can be driven without a device. */
class FakeSpeech implements SpeechCaptureService {
  readonly locale = 'ar-JO';
  status: SpeechStatus = 'idle';
  private callbacks: SpeechCaptureCallbacks = {};
  async start(callbacks: SpeechCaptureCallbacks): Promise<void> {
    this.callbacks = callbacks;
    this.status = 'listening';
    callbacks.onStatus?.('listening');
  }
  async stop(): Promise<void> {
    this.status = 'idle';
    this.callbacks.onStatus?.('idle');
  }
  partial(text: string) { this.callbacks.onPartial?.(text); }
  final(text: string) { this.callbacks.onFinal?.(text); }
}

/** The recogniser this device does not have. */
const NO_SPEECH: SpeechCaptureService = {
  locale: 'en-US',
  status: 'unavailable',
  start: async () => {},
  stop: async () => {},
};

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.spyOn(language, 'systemLanguageTag').mockReturnValue('en-US');
});

afterEach(async () => {
  cleanup();
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});

/**
 * Mounts the first question with a controlled answer, so a test can watch
 * exactly what the screen writes. `onChange` updates are applied to the
 * held answers and the screen re-rendered, the way the flow does it.
 */
async function renderFirst(options: {
  lang?: 'en' | 'ar' | 'he';
  answers?: SetupAnswers;
  speech?: SpeechCaptureService;
  failed?: boolean;
  reading?: boolean;
} = {}) {
  if (options.lang) await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, options.lang);
  let answers = options.answers ?? EMPTY_SETUP_ANSWERS;
  const onIndexChange = jest.fn<(index: number) => void>();
  const onRead = jest.fn<() => void>();
  const onSkip = jest.fn<() => void>();
  const onBack = jest.fn<() => void>();
  const changes: SetupAnswers[] = [];

  const tree = () => (
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <SetupChatStep
          answers={answers}
          index={0}
          onChange={(update) => {
            answers = update(answers);
            changes.push(answers);
            void view.rerender(tree());
          }}
          onIndexChange={onIndexChange}
          onRead={onRead}
          onSkip={onSkip}
          onBack={onBack}
          reading={options.reading ?? false}
          failed={options.failed ?? false}
          speech={options.speech ?? NO_SPEECH}
        />
      </AppProvider>
    </SafeAreaProvider>
  );
  const view = await render(tree());
  const copy = options.lang === 'ar' ? ar : options.lang === 'he' ? he : en;
  await waitFor(() => expect(screen.queryByText(copy.obSetupLifeTitle)).not.toBeNull());
  return { onIndexChange, onRead, onSkip, onBack, changes, current: () => answers, copy };
}

function alignOf(testID: string): unknown {
  return StyleSheet.flatten(screen.getByTestId(testID).props.style)?.textAlign;
}

describe('it reads as a conversation, in every language', () => {
  const cases: ['en' | 'ar' | 'he', typeof en, 'left' | 'right'][] = [
    ['ar', ar, 'right'],
    ['he', he, 'right'],
    ['en', en, 'left'],
  ];
  it.each(cases)('%s: the life-story copy, aligned to the reading direction', async (lang, copy, align) => {
    await renderFirst({ lang });
    expect(screen.getByText(copy.obSetupLifeTitle)).toBeTruthy();
    expect(screen.getByText(copy.obSetupLifeBody)).toBeTruthy();
    expect(screen.getByText(copy.obSetupLifeHelper)).toBeTruthy();
    expect(screen.getByLabelText(copy.obSetupLifeCta)).toBeTruthy();
    expect(screen.getByLabelText(copy.obSetupLifeSkip)).toBeTruthy();
    expect(screen.getByTestId('setup-life-input').props.placeholder).toBe(copy.obSetupLifePlaceholder);
    // The composer and the invitation read in the language's own direction.
    expect(alignOf('setup-life-input')).toBe(align);
    // TextInput uses physical alignment; Fabric Text resolves a logical edge.
    expect(alignOf('setup-life-body')).toBe('left');
  });

  it.each([
    ['ar', ar, 1.6],
    ['he', he, 1.5],
    ['en', en, 1.3],
  ] as ['en' | 'ar' | 'he', typeof en, number][])(
    '%s: the heading has room for marks above the letters',
    async (lang, copy, multiple) => {
      // On the simulator the Arabic heading lost its shadda and the hamza on
      // «أتعرف»: a 1.3 line box clips Naskh's marks. Arabic and Hebrew keep
      // their script's own line height; only Latin is set tighter.
      await renderFirst({ lang });
      const style = StyleSheet.flatten(screen.getByText(copy.obSetupLifeTitle).props.style);
      expect(style?.lineHeight).toBe(Math.round(28 * multiple));
    },
  );

  it('has none of the survey furniture', async () => {
    await renderFirst({ lang: 'ar' });
    expect(screen.queryByTestId('setup-question-of')).toBeNull();
    expect(screen.queryByTestId('setup-answer-count')).toBeNull();
    expect(screen.queryByTestId('setup-answer-input')).toBeNull();
    expect(screen.queryByText(ar.obSetupNext)).toBeNull();
    // No demographic answer chips from the questions after it.
    expect(screen.queryByText(ar.obSetupDayChip1)).toBeNull();
  });

  it.each([
    ['en', ['1', '2', '3', '4']],
    ['ar', ['4', '3', '2', '1']],
    ['he', ['4', '3', '2', '1']],
  ] as ['en' | 'ar' | 'he', string[]][])('%s: the first prompt is the first one read', async (lang, order) => {
    // The row scrolls horizontally, and a horizontal ScrollView lays its
    // children out left to right even under an RTL root. In Arabic and Hebrew
    // the row opens scrolled to its end, so the children are reversed there to
    // put prompt 1 at the right edge, where reading starts.
    await renderFirst({ lang });
    const ids = screen.getAllByTestId(/^setup-life-prompt-\d$/).map((node) => String(node.props.testID).slice(-1));
    expect(ids).toEqual(order);
  });

  it('offers at most four inspiration prompts', async () => {
    await renderFirst({ lang: 'ar' });
    expect(screen.getAllByTestId(/^setup-life-prompt-/)).toHaveLength(4);
    expect(screen.getByText(ar.obSetupLifePrompt1)).toBeTruthy();
    expect(screen.getByText(ar.obSetupLifePrompt4)).toBeTruthy();
  });
});

describe('the narrative', () => {
  it('takes a long, multiline answer and keeps every line', async () => {
    const { current } = await renderFirst({ lang: 'en' });
    const story = [
      "I'm a nursing student and I work three evenings a week.",
      'University is Sunday to Wednesday, and I try to get to the gym twice.',
      'I have a thesis due in March, my mum needs help on Fridays,',
      'and I keep forgetting to pay the phone bill.',
    ].join('\n');
    expect(Array.from(story).length).toBeGreaterThan(150);
    await fireEvent.changeText(screen.getByTestId('setup-life-input'), story);
    expect(current().life).toBe(story);
    expect(screen.getByTestId('setup-life-input').props.multiline).toBe(true);
    expect(screen.getByTestId('setup-life-input').props.maxLength).toBe(MAX_LIFE_ANSWER_LENGTH);
  });

  it('shows what was already written when the step comes back', async () => {
    await renderFirst({ lang: 'ar', answers: { ...EMPTY_SETUP_ANSWERS, life: 'بدرس وبشتغل بالليل' } });
    expect(screen.getByTestId('setup-life-input').props.value).toBe('بدرس وبشتغل بالليل');
  });
});

describe('the inspiration prompts are not answers', () => {
  it('leaves the answer untouched and offers the prompt as the thing to talk about', async () => {
    const { changes, current } = await renderFirst({ lang: 'ar' });
    await fireEvent.press(screen.getByTestId('setup-life-prompt-2'));
    expect(changes).toHaveLength(0);
    expect(current()).toEqual(EMPTY_SETUP_ANSWERS);
    // The CTA still waits: a tapped prompt is not something to read.
    expect(screen.getByLabelText(ar.obSetupLifeCta).props.accessibilityState).toMatchObject({ disabled: true });
    // The prompt becomes the composer's suggestion instead of the example.
    expect(screen.getByTestId('setup-life-input').props.placeholder).toBe(ar.obSetupLifePrompt2);
  });

  it('does not overwrite an answer in progress', async () => {
    const { changes, current } = await renderFirst({ lang: 'en', answers: { ...EMPTY_SETUP_ANSWERS, life: 'I work nights' } });
    await fireEvent.press(screen.getByTestId('setup-life-prompt-1'));
    expect(changes).toHaveLength(0);
    expect(current().life).toBe('I work nights');
  });
});

describe('the CTA, Skip and Back', () => {
  it('waits for something worth reading', async () => {
    const { onIndexChange } = await renderFirst({ lang: 'en' });
    const cta = () => screen.getByLabelText(en.obSetupLifeCta);
    expect(cta().props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(cta());
    expect(onIndexChange).not.toHaveBeenCalled();

    await fireEvent.changeText(screen.getByTestId('setup-life-input'), '   ');
    expect(cta().props.accessibilityState).toMatchObject({ disabled: true });

    await fireEvent.changeText(screen.getByTestId('setup-life-input'), 'I study and work evenings');
    expect(cta().props.accessibilityState).toMatchObject({ disabled: false });
    await fireEvent.press(cta());
    expect(onIndexChange).toHaveBeenCalledWith(1);
  });

  it('"Not now" is always available and ends the step', async () => {
    const { onSkip, onIndexChange } = await renderFirst({ lang: 'ar' });
    await fireEvent.press(screen.getByLabelText(ar.obSetupLifeSkip));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onIndexChange).not.toHaveBeenCalled();
  });

  it('Back leaves the step for the previous onboarding screen', async () => {
    const { onBack } = await renderFirst({ lang: 'he' });
    await fireEvent.press(screen.getByLabelText(he.obBack));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('says when a read failed, and that nothing was saved', async () => {
    await renderFirst({ lang: 'en', failed: true });
    expect(screen.getByText(en.obAboutFailed)).toBeTruthy();
  });
});

describe('voice', () => {
  it('is not offered where there is no recogniser, and typing still works', async () => {
    const { current } = await renderFirst({ lang: 'en', speech: NO_SPEECH });
    expect(screen.queryByTestId('setup-life-voice')).toBeNull();
    expect(screen.getByText(en.obSetupLifeType)).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('setup-life-input'), 'typed only');
    expect(current().life).toBe('typed only');
  });

  it('is the primary action when a recogniser exists, and adds to what is written', async () => {
    const speech = new FakeSpeech();
    const { current, onIndexChange } = await renderFirst({
      lang: 'ar',
      speech,
      answers: { ...EMPTY_SETUP_ANSWERS, life: 'بدرس تمريض.' },
    });
    expect(screen.getByLabelText(ar.obSetupLifeVoice)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('setup-life-voice'));
    await waitFor(() => expect(speech.status).toBe('listening'));

    speech.partial('وبشتغل');
    await waitFor(() => expect(current().life).toBe('بدرس تمريض. وبشتغل'));
    speech.final('وبشتغل بالليل');
    await waitFor(() => expect(current().life).toBe('بدرس تمريض. وبشتغل بالليل'));

    // A transcript is read by the user, never sent by itself.
    expect(onIndexChange).not.toHaveBeenCalled();
  });
});
