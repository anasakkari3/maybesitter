import React from 'react';
import { TextInput, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { fill, type Strings } from '../../i18n/strings';
import { Btn, Card, Txt } from '../../ui/primitives';
import { OnboardingChrome } from './OnboardingChrome';
import { SetupLifeStep } from './SetupLifeStep';
import type { SpeechCaptureService } from '../capture/voice/SpeechCaptureService';
import {
  SETUP_QUESTIONS,
  type SetupQuestion,
  answerCap,
  answeredCount,
  clampAnswer,
  nextQuestionIndex,
  previousQuestionIndex,
  type SetupAnswers,
} from './setupChat';

/**
 * The guided setup, one question per screen (UC-3.17, #469).
 *
 * ── A chip is a starter, not a choice ────────────────────────────
 *
 * Tapping a chip puts its sentence in the field; the field stays editable
 * and typing over it is expected. So the "selected" look is derived from the
 * field, not from a separate selection: the moment the text no longer matches
 * a chip, no chip is lit, which is the truth.
 *
 * ── Skip is on every question ────────────────────────────────────
 *
 * Same rule as the old free-text box: the most personal thing the product
 * asks must be the easiest to decline. The chrome has two footer slots and
 * both are taken (Next/Read and Back), so Skip sits as a link in the scroll
 * content, above the footer, on every one of the five screens.
 *
 * ── The last question's primary depends on what was answered ─────
 *
 * With at least one answer it reads the answers. With none it "finishes
 * without answers", which is the same thing as Skip and calls the same
 * callback: there is nothing to read, and a disabled button would leave
 * somebody who declined every question with no way forward but a link.
 */
export function SetupChatStep({
  answers,
  index,
  questions = SETUP_QUESTIONS,
  gapCount = 0,
  onImport,
  onChange,
  onIndexChange,
  onRead,
  onSkip,
  onBack,
  reading = false,
  failed = false,
  speech,
}: {
  answers: SetupAnswers;
  index: number;
  /**
   * The questions actually being asked. Shorter after an AI context import —
   * see `setupGaps` — and its first entry may be a brief stand-in for the
   * narrative rather than the narrative itself.
   */
  questions?: readonly SetupQuestion[];
  /** How many questions the import removed, for the heading above the first. */
  gapCount?: number;
  /** Opens the import. Absent when there is nothing to import from. */
  onImport?: (() => void) | undefined;
  /** An updater, for the same reason RoutineStep takes one. */
  onChange: (update: (previous: SetupAnswers) => SetupAnswers) => void;
  onIndexChange: (index: number) => void;
  /** Last question, at least one answer. */
  onRead: () => void;
  /** "Skip for now" on any question, and the last question with no answers. */
  onSkip: () => void;
  /** Back on the first question only; later Backs stay inside the step. */
  onBack: () => void;
  reading?: boolean;
  failed?: boolean;
  /** The first question's recogniser; injected in tests. */
  speech?: SpeechCaptureService | undefined;
}) {
  const { t, p, rtl } = useApp();
  // The question keys are plain sentences; the same view RoutineStep takes of
  // the copy, because a few other keys are lists and widen `t[key]`.
  const copy = t as unknown as Record<keyof Strings, string>;
  const question = questions[index] ?? questions[0]!;
  const prompt = copy[question.promptKey];
  const answer = answers[question.id];
  const next = nextQuestionIndex(index, questions);
  const previous = previousQuestionIndex(index, questions);
  const answered = answeredCount(answers, questions);

  // The first question is the life narrative, a screen of its own (#469
  // follow-up). Questions 2–5 keep the layout below.
  if (question.kind === 'narrative') {
    return (
      <SetupLifeStep
        question={question}
        gapCount={gapCount}
        {...(onImport ? { onImport } : {})}
        answer={answer}
        onAnswer={(text) => onChange((current) => ({ ...current, [question.id]: text }))}
        onContinue={() => { if (next !== null) onIndexChange(next); }}
        onSkip={onSkip}
        onBack={onBack}
        reading={reading}
        failed={failed}
        speech={speech}
      />
    );
  }

  // What the server's budget still allows here, after the narrative and the
  // other answers — normally the full short cap.
  const cap = answerCap(answers, question.id, t, questions);

  const setAnswer = (text: string) =>
    onChange((current) => ({ ...current, [question.id]: text }));

  const primary = next !== null
    ? { label: t.obSetupNext, onPress: () => onIndexChange(next) }
    : answered > 0
      ? { label: reading ? t.obAboutReading : t.obSetupRead, onPress: onRead, disabled: reading }
      : { label: t.obSetupFinish, onPress: onSkip };

  return (
    <OnboardingChrome
      step="about"
      title={prompt}
      testID="onboarding-setup"
      primary={primary}
      secondary={{
        label: t.obBack,
        onPress: previous === null ? onBack : () => onIndexChange(previous),
      }}
      footNote={failed ? t.obAboutFailed : undefined}
    >
      <Txt size={13} color={p.mu} testID="setup-question-of">
        {fill(t.obSetupQuestionOf, { current: index + 1, total: questions.length })}
      </Txt>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {question.chipKeys.map((key, n) => {
          const label = copy[key];
          const selected = answer === label;
          return (
            <Btn
              key={key}
              testID={`setup-chip-${question.id}-${n + 1}`}
              label={label}
              accessibilityRole="button"
              scaleTo={0.98}
              hitSlop={6}
              onPress={() => setAnswer(clampAnswer(label, cap))}
              style={{
                minHeight: 40,
                justifyContent: 'center',
                paddingHorizontal: 14,
                paddingVertical: 8,
                borderRadius: 999,
                borderWidth: selected ? 0 : 1,
                borderColor: p.ln,
                backgroundColor: selected ? p.acs : 'transparent',
              }}
            >
              <Txt size={14} weight={selected ? 600 : 400} color={selected ? p.ac : p.tx}>{label}</Txt>
            </Btn>
          );
        })}
      </View>

      <Card pad={18}>
        <TextInput
          testID="setup-answer-input"
          accessibilityLabel={prompt}
          value={answer}
          onChangeText={setAnswer}
          placeholder={t.obSetupPlaceholder}
          placeholderTextColor={p.mu}
          maxLength={cap}
          multiline
          editable={!reading}
          style={{
            color: p.tx,
            fontSize: 15,
            minHeight: 80,
            textAlignVertical: 'top',
            textAlign: rtl ? 'right' : 'left',
          }}
        />
      </Card>
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
        <Txt size={12} color={p.mu} latin testID="setup-answer-count">
          {`${Array.from(answer).length} / ${cap}`}
        </Txt>
      </View>

      <Btn
        testID="setup-skip"
        label={t.obSkip}
        onPress={onSkip}
        scaleTo={0.98}
        style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
      >
        <Txt size={15} color={p.mu}>{t.obSkip}</Txt>
      </Btn>
    </OnboardingChrome>
  );
}
