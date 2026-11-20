import React from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { useDecideHabitOccurrence, useHabits, useHabitsToday, useUndoHabitOccurrence } from '../../api/queries';
import { ConflictError } from '../../api/errors';
import { markErrorShown, userFacingMessage } from '../../api/ui/userFacingMessage';
import { formatClockRange } from '../../i18n/format';
import { fill } from '../../i18n/strings';
import { isolateAuto } from '../../i18n/bidi';
import { Btn, Pill, SaidWords, Txt } from '../../ui/primitives';
import { fillRow, useLayoutMode } from '../../theme/textScale';
import { CheckIcon } from '../../ui/icons';
import { LiveRegion } from '../../ui/liveRegion';
import { useAnnounceOnIos } from '../../ui/announce';
import { focusForAccessibility } from '../../ui/accessibilityFocus';
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
        {/* Measured afresh after a live text-size change (sim-1120 C): see HabitRow. */}
        <SaidWords label={t.todayHabitsTitle} role="header" testID="today-habits-title" style={{ flexShrink: 1 }}>
          <Txt role="section" size={13} weight={600} color={p.mu} accessible={false}>{t.todayHabitsTitle}</Txt>
        </SaidWords>
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
  // «تمّت» succeeded (#881 review): the circle is gone, so the line is said
  // and the focus moves to «تراجع», which took its place.
  const [justDone, setJustDone] = React.useState(false);
  const doneButton = React.useRef<View>(null);
  const undoButton = React.useRef<View>(null);
  const open = occurrence.state === 'pending' || occurrence.state === 'scheduled';
  const done = justDone && occurrence.state === 'completed';
  const busy = decide.isPending || undo.isPending;
  const title = isolateAuto(habit.title);
  // iOS has no live regions: VoiceOver is told what TalkBack hears below.
  useAnnounceOnIos(reopened && open ? t.xHabitTodayReopened : done ? t.xHabitTodayDone : null);
  React.useEffect(() => {
    if (reopened && open) focusForAccessibility(doneButton.current);
  }, [reopened, open]);
  React.useEffect(() => {
    if (done) focusForAccessibility(undoButton.current);
  }, [done]);
  const markDone = () => {
    setReopened(false);
    setJustDone(false);
    undo.reset();
    decide.mutate(
      { habitId: habit.habitId, occurrenceId: occurrence.occurrenceId, outcome: 'completed' },
      { onSuccess: () => setJustDone(true), onError: markErrorShown },
    );
  };
  const takeBack = () => undo.mutate(
    { habitId: habit.habitId, occurrenceId: occurrence.occurrenceId },
    { onSuccess: () => { decide.reset(); setJustDone(false); setReopened(true); }, onError: markErrorShown },
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
  // The hour and the minutes are two paragraphs (sim-1120 A). As one, at AX5
  // the line wrapped through the hour's left-to-right isolate and drew «07:»
  // and «30 دقيقة» with the rest of the hour gone. Each piece now wraps whole.
  const hours = window ? formatClockRange(window.start, window.end) : null;
  const minutes = tr('xMinutes', { count: occurrence.durationMinutes });
  const detail = hours ? `${hours} · ${minutes}` : minutes;
  // From the large mode up the row stacks (sim-1120 B): «تراجع» beside the
  // words squeezed them to a third of the row and broke the title inside its
  // words. The circle and «تراجع» keep one parent in both modes, so a live
  // change never remounts them and a screen reader's focus stays.
  const stacked = useLayoutMode() !== 'normal';
  const id = habit.habitId;
  return (
    <View testID={`today-habit-${id}`} style={stacked ? { gap: 6, paddingVertical: 2 } : { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 2 }}>
      {/* Its parent changes direction with the mode: fillRow, never `flex`
          (Yoga on Fabric keeps an old flex basis, theme/textScale). */}
      <View testID={`today-habit-main-${id}`} style={[{ flexDirection: 'row', alignItems: 'center', gap: 6 }, stacked ? null : fillRow]}>
        {open ? (
          <Btn testID={`today-habit-done-${id}`} nativeRef={doneButton} label={fill(t.xHabitTodayMarkDoneA11y, { title })}
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
        {/* Measured afresh after a live text-size change (sim-1120 C, shot
            02x: the block was scattered dots until a relaunch). Each piece is
            said by a view that stays; only the drawn paragraph is replaced. */}
        <View style={{ flex: 1, gap: 2, alignItems: 'flex-start' }}>
          <SaidWords label={habit.title} testID={`today-habit-title-said-${id}`}>
            <Txt size={15} weight={600} color={p.tx} dir="auto" accessible={false} testID={`today-habit-title-${id}`}>{habit.title}</Txt>
          </SaidWords>
          <SaidWords label={detail} testID={`today-habit-detail-${id}`} style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 6 }}>
            {hours ? <Txt size={13} color={p.mu} accessible={false} testID={`today-habit-time-${id}`}>{hours}</Txt> : null}
            <Txt size={13} color={p.mu} accessible={false} testID={`today-habit-minutes-${id}`}>{hours ? `· ${minutes}` : minutes}</Txt>
          </SaidWords>
          <LiveRegion testID={`today-habit-live-${id}`}>
            {decided ? <SaidWords label={decided} testID={`today-habit-decided-${id}`}>
              <Txt size={13} weight={600} color={occurrence.state === 'completed' ? p.success : p.mu} accessible={false}>{decided}</Txt>
            </SaidWords> : null}
            {open && reopened ? <SaidWords label={t.xHabitTodayReopened} testID={`today-habit-reopened-${id}`}>
              <Txt size={13} color={p.mu} accessible={false}>{t.xHabitTodayReopened}</Txt>
            </SaidWords> : null}
            {failure ? <SaidWords label={failure} testID={`today-habit-failure-${id}`}>
              <Txt size={13} color={p.wm} accessible={false}>{failure}</Txt>
            </SaidWords> : null}
          </LiveRegion>
        </View>
      </View>
      {decided ? (
        <Pill testID={`today-habit-undo-${id}`} nativeRef={undoButton} label={t.undo} accessibilityLabel={fill(t.xHabitTodayUndoA11y, { title })}
          kind="outline" size={14} pad={8} disabled={busy} onPress={takeBack} style={stacked ? { alignSelf: 'stretch' } : undefined} />
      ) : null}
    </View>
  );
}
