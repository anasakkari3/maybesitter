import React from 'react';
import { AccessibilityInfo, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { useDecideHabitOccurrence, useHabits, useHabitsToday, useUndoHabitOccurrence } from '../../api/queries';
import { ConflictError } from '../../api/errors';
import { markErrorShown, userFacingMessage } from '../../api/ui/userFacingMessage';
import { formatClockRange } from '../../i18n/format';
import { fill } from '../../i18n/strings';
import { isolateAuto } from '../../i18n/bidi';
import { Btn, Pill, Txt } from '../../ui/primitives';
import { CheckIcon } from '../../ui/icons';
import { LiveRegion } from '../../ui/liveRegion';
import { useAnnounceOnIos } from '../../ui/announce';
import { ReferenceIcon, useReferencePalette } from '../../ui/referenceDesign';
import { todayHabitRows, type TodayHabitRow } from './todayHabits';

/**
 * Today's habits (QA v3 V3-F23-06, owner decision 2026-11-20): one quiet
 * block of small rows, each with «تمّت», below the day's commitments and
 * above the fixed time. Not a commitment, so it is not counted with them, has
 * no importance chip and never becomes the next step.
 *
 * «تمّت» and «تراجع» are the habit occurrence routes the habits page uses
 * (CA5.4, #868), so both places read and write the same day. «مش اليوم» stays
 * on the habits page: a row here only says done, or takes it back.
 *
 * Quiet on failure: the habits page is where a habit read that failed is said.
 * Today keeps its commitments rather than trading them for an error about the
 * habits beside them.
 */
export function TodayHabits() {
  const { t } = useApp();
  const p = useReferencePalette();
  const habits = useHabits();
  const today = useHabitsToday();
  const rows = todayHabitRows(habits.data, today.data);
  if (rows.length === 0) return null;
  return (
    <View testID="today-habits" style={{ gap: 2, backgroundColor: p.sf, borderWidth: 1, borderColor: p.ln, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4, paddingVertical: 4 }}>
        <ReferenceIcon name="repeat" size={18} color={p.mu} />
        <Txt role="section" size={13} weight={600} color={p.mu} style={{ flexShrink: 1 }}>{t.todayHabitsTitle}</Txt>
      </View>
      {rows.map(row => <HabitRow key={row.occurrence.occurrenceId} row={row} />)}
    </View>
  );
}

/**
 * One habit today: the circle marks it done; once decided the row says so in
 * words and offers «تراجع», which reopens the day (V3-F23-02).
 */
function HabitRow({ row: { habit, occurrence } }: { row: TodayHabitRow }) {
  const { t, tr } = useApp();
  const p = useReferencePalette();
  const decide = useDecideHabitOccurrence();
  const undo = useUndoHabitOccurrence();
  // «تراجع» succeeded: the region says the day is open, and the focus goes
  // back to the circle that took the place of the undo button.
  const [reopened, setReopened] = React.useState(false);
  const doneButton = React.useRef<View>(null);
  const open = occurrence.state === 'pending' || occurrence.state === 'scheduled';
  const busy = decide.isPending || undo.isPending;
  const title = isolateAuto(habit.title);
  useAnnounceOnIos(reopened && open ? t.xHabitTodayReopened : null);
  React.useEffect(() => {
    if (!reopened || !open) return;
    if (doneButton.current) AccessibilityInfo.sendAccessibilityEvent(doneButton.current, 'focus');
  }, [reopened, open]);
  const markDone = () => {
    setReopened(false);
    undo.reset();
    decide.mutate({ habitId: habit.habitId, occurrenceId: occurrence.occurrenceId, outcome: 'completed' }, { onError: markErrorShown });
  };
  const takeBack = () => undo.mutate(
    { habitId: habit.habitId, occurrenceId: occurrence.occurrenceId },
    { onSuccess: () => { decide.reset(); setReopened(true); }, onError: markErrorShown },
  );
  // A 409 is the one way undo is refused: the make-up day was already decided.
  let failure: string | null = null;
  if (undo.error instanceof ConflictError) {
    markErrorShown(undo.error);
    failure = t.xHabitUndoMadeUpDecided;
  } else if (undo.error) {
    failure = userFacingMessage(undo.error, t);
  } else if (decide.error) {
    failure = userFacingMessage(decide.error, t);
  }
  const decided = occurrence.state === 'completed' ? t.xHabitTodayDone
    : occurrence.state === 'skipped' || occurrence.state === 'recovered' ? t.xHabitTodaySkipped : null;
  const window = habit.preferredWindows[0];
  const detail = window
    ? `${formatClockRange(window.start, window.end)} · ${tr('xMinutes', { count: occurrence.durationMinutes })}`
    : tr('xMinutes', { count: occurrence.durationMinutes });
  return (
    // Wraps at large text: «تراجع» drops under the words instead of squeezing them.
    <View testID={`today-habit-${habit.habitId}`} style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, paddingVertical: 2 }}>
      {open ? (
        <Btn testID={`today-habit-done-${habit.habitId}`} nativeRef={doneButton} label={fill(t.xHabitTodayDoneA11y, { title })}
          disabled={busy} onPress={markDone} style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: p.lnStrong }} />
        </Btn>
      ) : (
        // The decision is said in words beside it; the mark is for the eye.
        <View accessible={false} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
          <View style={{
            width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center',
            backgroundColor: occurrence.state === 'completed' ? p.successSoft : 'transparent',
            borderWidth: occurrence.state === 'completed' ? 0 : 2, borderColor: p.lnStrong,
          }}>
            {occurrence.state === 'completed' ? <CheckIcon color={p.success} /> : null}
          </View>
        </View>
      )}
      <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 160, gap: 2, alignItems: 'flex-start' }}>
        <Txt size={15} weight={600} color={p.tx} dir="auto" testID={`today-habit-title-${habit.habitId}`}>{habit.title}</Txt>
        <Txt size={13} color={p.mu}>{detail}</Txt>
        <LiveRegion testID={`today-habit-live-${habit.habitId}`}>
          {decided ? <Txt size={13} weight={600} color={occurrence.state === 'completed' ? p.success : p.mu}>{decided}</Txt> : null}
          {open && reopened ? <Txt size={13} color={p.mu}>{t.xHabitTodayReopened}</Txt> : null}
          {failure ? <Txt size={13} color={p.wm}>{failure}</Txt> : null}
        </LiveRegion>
      </View>
      {decided ? (
        <Pill testID={`today-habit-undo-${habit.habitId}`} label={t.undo} accessibilityLabel={fill(t.xHabitTodayUndoA11y, { title })}
          kind="outline" size={14} pad={8} disabled={busy} onPress={takeBack} />
      ) : null}
    </View>
  );
}
