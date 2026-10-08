import React from 'react';
import { View } from 'react-native';
import type { CaptureGoalProposal, CaptureHabitProposal, CaptureSeedProposal, HabitCadence } from '../../api/schemas/capture';
import { fill } from '../../i18n/strings';
import { isolateAuto, ltr } from '../../i18n/bidi';
import { formatRelativeDay, formatTime } from '../../i18n/format';
import { useTimeZone } from '../../i18n/timezone';
import { useApp } from '../../state/AppContext';
import { Btn, Pill, Txt } from '../../ui/primitives';
import { seedKindLabel } from '../seeds/seedDisplay';

type HabitQuestion = NonNullable<CaptureHabitProposal['question']>;

/** A frequency question to ask again when the server refused a habit as incomplete (R3-007). */
const REASK_FREQUENCY: HabitQuestion = { field: 'frequency', options: [1, 2, 3, 4, 5, 6, 7] };

/**
 * One point the review saves, as a card that is its own selection control
 * (M3b): a habit, a goal, or — from the thought entry — a thought. The kind
 * and the words read as one unit; the selection is a checkbox on the card.
 * Nothing here writes: «احفظ» saves what is ticked, in one confirm.
 */
function PointCard({ testID, kind, title, selected, disabled, disabledNote, onToggle, children }: {
  testID: string;
  kind: string;
  title: string;
  selected: boolean;
  disabled: boolean;
  /** Said and shown when the card cannot be saved yet (R4-002). */
  disabledNote?: string | undefined;
  onToggle(): void;
  children?: React.ReactNode;
}) {
  const { p } = useApp();
  return (
    <View style={{ backgroundColor: p.sf, borderRadius: 18, padding: 14, gap: 8 }}>
      <Btn
        testID={testID}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: selected && !disabled, disabled }}
        label={`${kind}: ${title}${disabledNote ? `. ${disabledNote}` : ''}`}
        disabled={disabled}
        onPress={onToggle}
        scaleTo={0.98}
        style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, minHeight: 44 }}
      >
        <View style={{
          width: 22, height: 22, borderRadius: 6, borderWidth: 2, marginTop: 2, alignItems: 'center', justifyContent: 'center',
          borderColor: disabled ? p.mu : selected ? p.ac : p.lnStrong,
          backgroundColor: !disabled && selected ? p.ac : 'transparent',
        }}>
          {!disabled && selected ? <Txt size={13} weight={700} color={p.onAccent}>✓</Txt> : null}
        </View>
        <View style={{ flex: 1, gap: 4, alignItems: 'flex-start' }}>
          <Txt size={12} color={p.mu}>{kind}</Txt>
          <Txt size={15} lh={1.45}>{isolateAuto(title)}</Txt>
        </View>
      </Btn>
      {children}
      {disabledNote ? <Txt size={12} color={p.wm}>{disabledNote}</Txt> : null}
    </View>
  );
}

/** «عادة»: the server's explanation of the rhythm, or its one open question (R003). */
export function HabitProposalCard({ habit, selected, onToggle, onAnswer, busy, reask }: {
  habit: CaptureHabitProposal;
  selected: boolean;
  onToggle(): void;
  /** One structured change to this habit (M2b protocol). */
  onAnswer(change: { cadence?: HabitCadence; durationMinutes?: number; kind?: 'habit' | 'commitment' }): void;
  busy: boolean;
  /** The server refused the save as incomplete: ask the rhythm again (R3-007). */
  reask: boolean;
}) {
  const { t, tr, p } = useApp();
  const question = habit.question ?? (reask ? REASK_FREQUENCY : null);
  const incomplete = !habit.confirmable || habit.question !== null;
  const optionLabel = (value: number | string): string => {
    if (question?.field === 'frequency') return value === 7 ? t.xHabitEveryDay : tr('xHabitTimesN', { n: value as number });
    if (question?.field === 'duration') return fill(t.xHabitMinutesN, { n: value as number });
    return value === 'habit' ? t.xHabitAnswerHabit : t.xHabitAnswerFixed;
  };
  const questionText = question?.field === 'frequency' ? t.xHabitAskFrequency
    : question?.field === 'duration' ? t.xHabitAskDuration : t.xHabitAskKind;
  const answer = (value: number | string) => {
    if (question?.field === 'frequency') onAnswer({ cadence: { kind: 'weekly_count', count: value as number } });
    else if (question?.field === 'duration') onAnswer({ durationMinutes: value as number });
    else onAnswer({ kind: value as 'habit' | 'commitment' });
  };
  return (
    <PointCard testID={`capture-habit-${habit.pointId}`} kind={t.xKindHabit} title={habit.title}
      selected={selected} disabled={incomplete} disabledNote={incomplete ? t.xHabitIncompleteNote : undefined} onToggle={onToggle}>
      {habit.explanation && !question ? (
        <Txt size={13} color={p.tx} testID={`capture-habit-explanation-${habit.pointId}`} style={{ alignSelf: 'flex-start' }}>{habit.explanation}</Txt>
      ) : null}
      {question ? (
        <View testID={`capture-habit-question-${habit.pointId}`} style={{ gap: 8, alignItems: 'flex-start' }}>
          <Txt size={13} weight={600}>{questionText}</Txt>
          <View accessibilityRole="radiogroup" accessibilityLabel={questionText} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {question.options.map((value) => (
              <Pill
                key={String(value)}
                testID={`capture-habit-option-${habit.pointId}-${String(value)}`}
                label={optionLabel(value)}
                kind="outline"
                size={14}
                pad={10}
                disabled={busy}
                radio={{ checked: false }}
                onPress={() => answer(value)}
              />
            ))}
          </View>
        </View>
      ) : null}
    </PointCard>
  );
}

/** «هدف»: saved by the confirm, then the plan is one tap away (M3b, 11). */
export function GoalProposalCard({ goal, selected, onToggle }: { goal: CaptureGoalProposal; selected: boolean; onToggle(): void }) {
  const { t } = useApp();
  return <PointCard testID={`capture-goal-${goal.pointId}`} kind={t.xKindGoal} title={goal.title} selected={selected} disabled={false} onToggle={onToggle} />;
}

/** «حطّها التزام {بكرا 18:00}» on a thought that carried a time (D3): one structured edit, nothing saved. */
export function SeedCommitAction({ seed, busy, onPress }: { seed: CaptureSeedProposal; busy: boolean; onPress(): void }) {
  const { t, lang } = useApp();
  const timeZone = useTimeZone();
  if (!seed.suggestedTime) return null;
  const at = new Date(seed.suggestedTime.at);
  const when = `${formatRelativeDay(at, { locale: lang, timeZone })} ${ltr(formatTime(at, { locale: lang, timeZone }))}`;
  return (
    <Pill
      testID={`capture-seed-commit-${seed.pointId ?? seed.seedItemId}`}
      label={fill(t.xSeedMakeCommitment, { when })}
      accessibilityLabel={fill(t.xSeedMakeCommitmentA11y, { when })}
      kind="outline"
      size={13}
      pad={10}
      disabled={busy}
      onPress={onPress}
      style={{ alignSelf: 'flex-start' }}
    />
  );
}

/** A thought from the thought entry: saved by «احفظ» like the others (R002), with «حطّها التزام» when timed. */
export function ThoughtProposalCard({ seed, selected, onToggle, onMakeCommitment, busy }: {
  seed: CaptureSeedProposal;
  selected: boolean;
  onToggle(): void;
  onMakeCommitment(): void;
  busy: boolean;
}) {
  const { t } = useApp();
  const strings = t as unknown as Record<string, string>;
  return (
    <PointCard testID={`capture-seed-${seed.pointId ?? seed.seedItemId}`} kind={seedKindLabel(seed.kind, strings)} title={seed.summary}
      selected={selected} disabled={false} onToggle={onToggle}>
      <SeedCommitAction seed={seed} busy={busy} onPress={onMakeCommitment} />
    </PointCard>
  );
}
