import React from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { Btn, Card, Txt } from '../../ui/primitives';
import { OnboardingChrome } from './OnboardingChrome';
import {
  ROUTINE_OPTIONS,
  ROUTINE_QUESTIONS,
  type RoutineAnswers,
  type RoutineQuestion,
} from '../routine/routineProfile';

/**
 * The routine survey (UC-2.R1 #171, reused by Settings in UC-2.R4 #174).
 *
 * ── The disclosure line is not decoration ────────────────────────
 *
 * These five answers leave the device: the server plans the day from them
 * (UC-2.7a, #167). The line above the questions says so, in the same size as
 * the questions themselves rather than as fine print, and says where to change
 * or delete them. It is the only place in onboarding where something is sent
 * without a switch in front of it, so it is the one place that has to be said
 * plainly.
 *
 * ── Skippable, and a skip is an answer ───────────────────────────
 *
 * Skipping records `surveySkipped` rather than leaving the profile absent, so
 * the app does not ask again on the next launch — and produces no memory
 * facts, because "declined to say" is not something the user stated about
 * themselves.
 */
const QUESTION_LABEL: Record<RoutineQuestion, keyof typeof LABELS> = {
  sleep: 'sleep', focus: 'focus', fixed: 'fixed', reminder: 'reminder', quiet: 'quiet',
};

const LABELS = {
  sleep: 'obRoutineSleep', focus: 'obRoutineFocus', fixed: 'obRoutineFixed',
  reminder: 'obRoutineReminder', quiet: 'obRoutineQuiet',
} as const;

/**
 * The copy key for one option. `none` is the same phrase in three questions —
 * "no regular time" — so it is one key rather than three identical ones.
 */
const OPTION_KEY: Record<RoutineQuestion, Record<string, string>> = {
  sleep: { early: 'obRoutineSleepEarly', standard: 'obRoutineSleepStandard', late: 'obRoutineSleepLate' },
  focus: {
    workday: 'obRoutineFocusWorkday', early: 'obRoutineFocusEarly',
    afternoon: 'obRoutineFocusAfternoon', none: 'obRoutineNoneRegular',
  },
  fixed: {
    none: 'obRoutineNoneRegular', morning: 'obRoutineFixedMorning',
    afternoon: 'obRoutineFixedAfternoon', evening: 'obRoutineFixedEvening',
  },
  reminder: {
    soft: 'obRoutineReminderSoft', followUp: 'obRoutineReminderFollowUp', strong: 'obRoutineReminderStrong',
  },
  quiet: {
    early: 'obRoutineQuietEarly', standard: 'obRoutineQuietStandard',
    late: 'obRoutineQuietLate', none: 'obRoutineNoneRegular',
  },
};

export function RoutineStep({
  answers,
  onChange,
  onContinue,
  onSkip,
  onBack,
  saveFailed = false,
  /** Settings reuses the same questions without the onboarding chrome (#174). */
  mode = 'onboarding',
}: {
  answers: RoutineAnswers;
  /** An updater, for the same reason ConsentStep takes one: two quick taps on
   *  two different questions must not lose one of the answers. */
  onChange: (update: (previous: RoutineAnswers) => RoutineAnswers) => void;
  onContinue: () => void;
  onSkip?: (() => void) | undefined;
  onBack?: (() => void) | undefined;
  saveFailed?: boolean;
  mode?: 'onboarding' | 'settings';
}) {
  const { t, p } = useApp();
  const strings = t as unknown as Record<string, string>;

  const questions = (
    <>
      <Txt size={15} lh={1.5} testID="routine-sync-disclosure">{t.obRoutineSync}</Txt>
      {ROUTINE_QUESTIONS.map(question => (
        <Card key={question} pad={18} style={{ gap: 10 }}>
          <Txt size={16} weight={600}>{strings[LABELS[QUESTION_LABEL[question]]]}</Txt>
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel={strings[LABELS[QUESTION_LABEL[question]]]}
            style={{ gap: 8 }}
          >
            {(ROUTINE_OPTIONS[question] as readonly string[]).map(option => {
              const label = strings[OPTION_KEY[question][option]!]!;
              const selected = answers[question] === option;
              return (
                <Btn
                  key={option}
                  label={label}
                  scaleTo={0.98}
                  // Pressing the chosen option again clears it. The survey is
                  // skippable, so "I would rather not say this one" has to be
                  // reachable after a mistap.
                  onPress={() => onChange(previous => ({ ...previous, [question]: selected ? null : option }) as RoutineAnswers)}
                  style={{
                    minHeight: 46,
                    justifyContent: 'center',
                    paddingHorizontal: 14,
                    borderRadius: 12,
                    borderWidth: selected ? 0 : 1,
                    borderColor: p.ln,
                    backgroundColor: selected ? p.acs : 'transparent',
                    alignItems: 'flex-start',
                  }}
                >
                  <Txt size={14} weight={selected ? 600 : 400} color={selected ? p.ac : p.tx}>{label}</Txt>
                </Btn>
              );
            })}
          </View>
        </Card>
      ))}
    </>
  );

  if (mode === 'settings') {
    return <View style={{ gap: 14 }}>{questions}</View>;
  }

  return (
    <OnboardingChrome
      step="routine"
      title={t.obRoutineTitle}
      testID="onboarding-routine"
      primary={{ label: t.obContinue, onPress: onContinue }}
      secondary={onSkip ? { label: t.obSkip, onPress: onSkip } : onBack ? { label: t.obBack, onPress: onBack } : undefined}
      footNote={saveFailed ? t.obRoutineSaveFailed : undefined}
    >
      {questions}
    </OnboardingChrome>
  );
}
