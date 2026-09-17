import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { type Strings } from '../../i18n/strings';
import { Btn, Card, Txt } from '../../ui/primitives';
import { OnboardingChrome } from './OnboardingChrome';
import { VoiceButton } from '../capture/voice/VoiceButton';
import { createSpeechCaptureService, SpeechEventBridge } from '../capture/voice/speechService';
import { speechLanguageForTag } from '../capture/voice/speechLocale';
import type { SpeechCaptureService } from '../capture/voice/SpeechCaptureService';
import { loadSpeechLanguage, type SpeechLanguagePref } from '../../lib/deviceSettings/speechLanguage';
import { MAX_LIFE_ANSWER_LENGTH, SETUP_QUESTIONS, hasMeaningfulAnswer } from './setupChat';

/**
 * The first moment of MaybeSitter after sign-in: "tell me about your life".
 *
 * ── A conversation, not a form ───────────────────────────────────
 *
 * One heading that invites, one line that says what is worth talking about,
 * and one that says it does not have to be tidy. Then a single large composer
 * whose main action is to speak. There is no question counter, no character
 * counter and no demographic chip: this screen wants a paragraph about a life,
 * and the model finds the structure in it later.
 *
 * ── The prompts never answer ─────────────────────────────────────
 *
 * The four prompts are for somebody who does not know where to start, so they
 * sit above the composer where they are seen before the typing starts. Tapping
 * one focuses the composer and offers that prompt as its placeholder. It never
 * writes into the answer — so it cannot count as answered, cannot be sent to
 * the model, and cannot overwrite what the user already wrote.
 *
 * ── Voice adds, it does not replace ──────────────────────────────
 *
 * The recogniser is the one the capture composer uses (#163), through the same
 * `VoiceButton`. On this screen a transcript is appended to what is already
 * written, because a life story is told in more than one breath. It is never
 * sent by itself: the CTA is the user's.
 *
 * ── Skip is quiet ────────────────────────────────────────────────
 *
 * "Not now" sits at the top end, under the progress line, not in the middle
 * of the screen. The footer holds the conversation's own action and Back.
 */
export function SetupLifeStep({
  answer,
  onAnswer,
  onContinue,
  onSkip,
  onBack,
  reading = false,
  failed = false,
  speech,
}: {
  answer: string;
  onAnswer: (next: string) => void;
  onContinue: () => void;
  onSkip: () => void;
  onBack: () => void;
  reading?: boolean;
  failed?: boolean;
  /** Injected in tests; the app's own recogniser otherwise. */
  speech?: SpeechCaptureService | undefined;
}) {
  const { t, p, rtl, lang } = useApp();
  const copy = t as unknown as Record<keyof Strings, string>;
  const promptKeys = SETUP_QUESTIONS[0]!.chipKeys;
  const input = useRef<TextInput>(null);
  const promptRow = useRef<ScrollView>(null);
  const [activePrompt, setActivePrompt] = useState<keyof Strings | null>(null);

  // The same language rule as the capture composer: the one the user last
  // chose for speaking, else the one the app is shown in.
  const [speechLang, setSpeechLang] = useState<SpeechLanguagePref>(() => speechLanguageForTag(lang));
  useEffect(() => {
    let active = true;
    void loadSpeechLanguage().then((stored) => { if (active && stored) setSpeechLang(stored); });
    return () => { active = false; };
  }, []);
  const ownSpeech = useMemo(() => createSpeechCaptureService(() => speechLang), [speechLang]);
  const recogniser = speech ?? ownSpeech;

  // What was written before this utterance started, so partials replace only
  // the words being spoken now. Refs written in effects, not during render.
  const latestAnswer = useRef(answer);
  useEffect(() => { latestAnswer.current = answer; }, [answer]);
  const spokenFrom = useRef<string | null>(null);

  const withSpoken = (base: string, spoken: string) => {
    const joined = base.trim() === '' ? spoken : `${base.replace(/\s+$/, '')} ${spoken}`;
    return Array.from(joined).slice(0, MAX_LIFE_ANSWER_LENGTH).join('');
  };
  const onPartial = (spoken: string) => {
    if (spokenFrom.current === null) spokenFrom.current = latestAnswer.current;
    onAnswer(withSpoken(spokenFrom.current, spoken));
  };
  const onFinal = (spoken: string) => {
    const base = spokenFrom.current ?? latestAnswer.current;
    spokenFrom.current = null;
    onAnswer(withSpoken(base, spoken));
  };

  const ready = hasMeaningfulAnswer(answer) && !reading;

  return (
    <OnboardingChrome
      step="about"
      title={t.obSetupLifeTitle}
      testID="onboarding-setup"
      primary={{ label: t.obSetupLifeCta, onPress: onContinue, disabled: !ready }}
      secondary={{ label: t.obBack, onPress: onBack }}
      headerAction={{ label: t.obSetupLifeSkip, onPress: onSkip, testID: 'setup-skip' }}
      footNote={failed ? t.obAboutFailed : undefined}
    >
      {speech ? null : <SpeechEventBridge />}

      <View style={{ gap: 8 }}>
        <Txt size={17} lh={1.55} testID="setup-life-body">{t.obSetupLifeBody}</Txt>
        <Txt size={14} lh={1.5} color={p.mu}>{t.obSetupLifeHelper}</Txt>
      </View>

      {/* One row that scrolls, not four that wrap: wrapped, the English prompts
          took four lines and pushed the composer below the fold. In Arabic and
          Hebrew the row reads from the right: a horizontal ScrollView lays out
          left to right even under an RTL root, so the prompts are reversed and
          the row opens scrolled to its end, putting prompt 1 at the right. */}
      <ScrollView
        ref={promptRow}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ marginHorizontal: -20, flexGrow: 0 }}
        contentContainerStyle={{ paddingHorizontal: 20, gap: 8 }}
        onContentSizeChange={() => { if (rtl) promptRow.current?.scrollToEnd({ animated: false }); }}
        testID="setup-life-prompts"
      >
        {(rtl ? [...promptKeys].reverse() : promptKeys).map((key) => {
          const n = promptKeys.indexOf(key);
          const active = activePrompt === key;
          return (
            <Btn
              key={key}
              testID={`setup-life-prompt-${n + 1}`}
              label={copy[key]}
              scaleTo={0.98}
              onPress={() => {
                setActivePrompt(key);
                input.current?.focus();
              }}
              style={{
                minHeight: 36,
                justifyContent: 'center',
                paddingHorizontal: 14,
                paddingVertical: 7,
                borderRadius: 999,
                backgroundColor: active ? p.acs : p.sf2,
              }}
            >
              <Txt size={14} color={active ? p.ac : p.mu}>{copy[key]}</Txt>
            </Btn>
          );
        })}
      </ScrollView>

      <Card pad={16} style={{ gap: 12 }} testID="setup-life-composer">
        <VoiceButton
          variant="pill"
          testID="setup-life-voice"
          label={t.obSetupLifeVoice}
          service={recogniser}
          onPartial={onPartial}
          onFinal={onFinal}
        />
        <Btn
          label={t.obSetupLifeType}
          onPress={() => input.current?.focus()}
          scaleTo={0.99}
          style={{ alignItems: 'center', minHeight: 32, justifyContent: 'center' }}
        >
          <Txt size={14} color={p.mu}>{t.obSetupLifeType}</Txt>
        </Btn>
        <TextInput
          ref={input}
          testID="setup-life-input"
          accessibilityLabel={t.obSetupLifeTitle}
          value={answer}
          onChangeText={onAnswer}
          placeholder={activePrompt ? copy[activePrompt] : t.obSetupLifePlaceholder}
          placeholderTextColor={p.mu}
          maxLength={MAX_LIFE_ANSWER_LENGTH}
          multiline
          scrollEnabled={false}
          editable={!reading}
          style={{
            color: p.tx,
            fontSize: 17,
            lineHeight: 26,
            minHeight: 150,
            paddingTop: 4,
            textAlignVertical: 'top',
            textAlign: rtl ? 'right' : 'left',
          }}
        />
      </Card>

    </OnboardingChrome>
  );
}
