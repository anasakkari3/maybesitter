import React, { useState } from 'react';
import { AccessibilityInfo, Platform, TextInput, View } from 'react-native';
import { AppDateTimePicker as DateTimePicker } from '../../ui/AppDateTimePicker';
import { useApp } from '../../state/AppContext';
import { useTimeZone } from '../../i18n/timezone';
import { formatDate, formatTime } from '../../i18n/format';
import { ltr, type Strings } from '../../i18n/strings';
import { family } from '../../theme/fonts';
import { Btn, Pill, Txt } from '../../ui/primitives';
import type { CaptureProposalEdit } from '../../api/endpoints/capture';
import { useLayoutMode } from '../../theme/textScale';
import { MAX_TITLE_LENGTH } from './captureMachine';
import { clampCodePoints, clampUnits } from './titleBounds';
import { instantForLocalDateTime, localDateTimeFor } from './localInstant';

export type PointKind = NonNullable<CaptureProposalEdit['change']['kind']>;
const SEED_KINDS: readonly PointKind[] = ['possible_goal', 'consideration', 'idea', 'waiting_for'];

/**
 * The kinds a line can be, from what it is now (R006): its own kind, checked,
 * and only the moves the server makes. A habit goes back to a commitment; a
 * goal back to a «possible goal»; a commitment becomes a habit, and a possible
 * goal a goal, only where those kinds are offered. A goal is never a dated act.
 */
export function kindOptions(current: PointKind, offered: { habit: boolean; goal: boolean }): PointKind[] {
  if (current === 'habit') return ['habit', 'commitment'];
  if (current === 'goal') return ['goal', 'possible_goal'];
  if (current === 'commitment') return ['commitment', ...(offered.habit ? ['habit' as const] : []), ...SEED_KINDS];
  return ['commitment', ...SEED_KINDS, ...(current === 'possible_goal' && offered.goal ? ['goal' as const] : [])];
}

function kindName(kind: PointKind, t: Strings): string {
  switch (kind) {
    case 'commitment': return t.understoodKindCommitment;
    case 'possible_goal': return t.seedKindPossibleGoal;
    case 'consideration': return t.seedKindConsideration;
    case 'idea': return t.seedKindIdea;
    case 'waiting_for': return t.understoodKindWaitingFor;
    case 'habit': return t.xKindHabit;
    case 'goal': return t.xKindGoal;
  }
}

/**
 * «عدّل» on a line of «هيك فهمت» (M2b, condition 7): what it is, its words and
 * — for a commitment — its time, changed together and sent as one patch.
 * Nothing changed is nothing sent. Proposal-only: the confirm still decides.
 */
export function SummaryEditSheet({ kind: startKind, offered = { habit: false, goal: false }, timedSeed = false, text: startText, at: startAt, draft, busy = false, onSave, onCancel }: {
  kind: PointKind;
  /** Whether habits and goals are offered for this proposal (M3b). */
  offered?: { habit: boolean; goal: boolean };
  /** The line is a thought carrying a time: made a commitment, it goes the server's M3b way (RB-10). */
  timedSeed?: boolean;
  text: string;
  /** The time the line shows now; null for none. */
  at: string | null;
  /** A change the server refused because the proposal moved on: reopened for review (M2b). */
  draft?: CaptureProposalEdit['change'];
  busy?: boolean;
  onSave(change: CaptureProposalEdit['change']): void;
  onCancel(): void;
}) {
  const { t, p, script, rtl } = useApp();
  const stacked = useLayoutMode() !== 'normal';
  const timezone = useTimeZone();
  const [kind, setKind] = useState<PointKind>(draft?.kind ?? startKind);
  const [text, setText] = useState(draft?.text ?? startText);
  // Only words the person typed are sent: an untouched title, however long, is
  // never cut and sent back as an edit (M3B-A-R4-003).
  const [edited, setEdited] = useState(draft?.text !== undefined);
  // `undefined`: the time is not touched. A string or null: the person set it.
  const [at, setAt] = useState<string | null | undefined>(draft?.time ? draft.time.at : undefined);
  // A screen reader lands on the sheet's heading when it opens (criterion 6).
  const heading = React.useRef<View>(null);
  React.useEffect(() => {
    if (heading.current) AccessibilityInfo.sendAccessibilityEvent(heading.current, 'focus');
  }, []);

  // A habit turned commitment asks its day and time afterwards (R006), so it takes none here.
  const timed = kind === 'commitment' && startKind !== 'habit';
  // A habit or goal edit goes to the server's M3b path, which bounds the words at
  // 120 code points; every other edit is bounded at 120 UTF-16 units, the
  // confirm's own contract (captureTitleBounds). An emoji is one code point but
  // two units, so the native maxLength fits only the second (M3B-A-R3-001).
  // It mirrors the server's routing (`editCaptureKindsProposal`'s `handles`),
  // including a timed thought made a commitment (M3B-A-R4-001).
  const byCodePoints = (next: PointKind) => [startKind, next].some((value) => value === 'habit' || value === 'goal')
    || (timedSeed && next === 'commitment');
  const boundedFor = (next: PointKind) => (value: string) =>
    (byCodePoints(next) ? clampCodePoints(value, MAX_TITLE_LENGTH) : clampUnits(value, MAX_TITLE_LENGTH));
  const bounded = boundedFor(kind);
  // A new kind may count more strictly: typed words are cut on screen at once,
  // so what the field shows is what is sent (M3B-A-R4-002).
  // An untouched title is left alone where the server keeps it as it is (the
  // legacy path); a path that checks the title itself (M3b: habit, goal, timed
  // thought) gets it shortened on screen, and the shortened words are what the
  // save sends (M3B-A-R5-001).
  const chooseKind = (next: PointKind) => {
    setKind(next);
    const cut = boundedFor(next)(text);
    if (edited) setText(cut);
    else if (byCodePoints(next) && cut !== text) { setText(cut); setEdited(true); }
  };
  const save = () => {
    const change: CaptureProposalEdit['change'] = {};
    if (kind !== startKind) change.kind = kind;
    const words = text.trim();
    if (edited && words && words !== startText.trim()) change.text = words;
    // A time belongs to a commitment only; a seed carries none.
    if (at !== undefined && timed && at !== startAt) change.time = { at, timeZone: timezone };
    if (Object.keys(change).length === 0) { onCancel(); return; }
    onSave(change);
  };

  return (
    <View testID="understood-edit-sheet" accessibilityViewIsModal style={{ gap: 14 }}>
      <View ref={heading} accessible accessibilityRole="header" accessibilityLabel={t.understoodEditTitle}>
        <Txt size={22} weight={600} lh={1.5}>{t.understoodEditTitle}</Txt>
      </View>

      <Txt size={13} color={p.mu}>{t.understoodEditKind}</Txt>
      <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {kindOptions(startKind, offered).map((option) => (
          <Btn key={option} testID={`understood-edit-kind-${option}`} label={kindName(option, t)}
            accessibilityRole="radio" accessibilityState={{ checked: option === kind, disabled: busy }} disabled={busy} onPress={() => chooseKind(option)} scaleTo={0.97}
            style={{ backgroundColor: option === kind ? p.acs : p.sf2, borderRadius: 999, paddingVertical: 10, paddingHorizontal: 14, minHeight: 44, justifyContent: 'center' }}>
            <Txt size={14} weight={600} color={option === kind ? p.ac : p.tx}>{kindName(option, t)}</Txt>
          </Btn>
        ))}
      </View>

      <Txt size={13} color={p.mu}>{t.understoodEditWords}</Txt>
      {/* While the change is on its way nothing in the sheet moves: what was
          sent is what the answer (or a refusal's «رجعلي تعديلي») is about (M2B-A-R5-REVIEW-001). */}
      <TextInput testID="understood-edit-text" accessibilityLabel={t.understoodEditWords} value={text} onChangeText={(value) => { setEdited(true); setText(bounded(value)); }}
        editable={!busy} multiline
        style={{ backgroundColor: p.sf2, borderRadius: 18, paddingVertical: 12, paddingHorizontal: 16, fontSize: 16, minHeight: 56, color: p.tx, fontFamily: family(400, script), textAlign: rtl ? 'right' : 'left' }} />

      {timed ? <>
        <Txt size={13} color={p.mu}>{t.understoodEditTime}</Txt>
        <SummaryTimeField testID="understood-edit-time" value={at === undefined ? startAt : at} timeZone={timezone} onValueChange={setAt} disabled={busy} />
        <Pill testID="understood-edit-time-clear" label={t.understoodEditNoTime} onPress={() => setAt(null)} disabled={busy} kind="soft" size={14} pad={12} />
      </> : null}

      {/* Side by side, or one under the other at large text, where two halves
          break «احفظ التعديل» inside its words (simulator, AX5). */}
      <View style={{ flexDirection: stacked ? 'column' : 'row', gap: 10 }}>
        <Pill testID="understood-edit-save" label={t.understoodEditSave} onPress={save} disabled={busy} style={stacked ? undefined : { flex: 1 }} />
        <Pill testID="understood-edit-cancel" label={t.cancel} onPress={onCancel} kind="outline" style={stacked ? undefined : { flex: 1 }} />
      </View>
    </View>
  );
}

/**
 * A date and a time on the clock the app shows, as one absolute instant
 * (`onValueChange(iso)`): the picker reads and writes wall-clock values in
 * `timeZone`, so what the person picks is what the patch says.
 */
function SummaryTimeField({ testID, value, timeZone, onValueChange, disabled = false }: {
  testID: string;
  value: string | null;
  timeZone: string;
  onValueChange(at: string): void;
  disabled?: boolean;
}) {
  const { t, p, lang, scheme } = useApp();
  const [picking, setPicking] = useState<'date' | 'time' | null>(null);
  // With no time yet, the wheel opens on the next whole hour.
  const [nextHour] = useState(() => new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000));
  const instant = value ? new Date(value) : null;
  const pickerValue = instant ?? nextHour;
  // The day and the hour one under the other at large text: half a row broke
  // «9 أغسطس» inside the month's name (simulator, AX5).
  const stacked = useLayoutMode() !== 'normal';
  return (
    <View testID={testID} style={{ gap: 8 }}>
      <View style={{ flexDirection: stacked ? 'column' : 'row', gap: 8 }}>
        <Btn testID={`${testID}-date`} label={instant ? formatDate(instant, 'short', { locale: lang, timeZone }) : t.understoodEditPickTime}
          onPress={() => setPicking('date')} disabled={disabled}
          style={{ ...(stacked ? {} : { flex: 1 }), backgroundColor: p.sf2, borderRadius: 18, paddingVertical: 12, alignItems: 'center', minHeight: 48, justifyContent: 'center' }}>
          <Txt size={14}>{instant ? formatDate(instant, 'short', { locale: lang, timeZone }) : t.understoodEditPickTime}</Txt>
        </Btn>
        <Btn testID={`${testID}-clock`} label={instant ? formatTime(instant, { locale: lang, timeZone }) : t.understoodEditPickTime}
          onPress={() => setPicking('time')} disabled={disabled}
          style={{ ...(stacked ? {} : { flex: 1 }), backgroundColor: p.sf2, borderRadius: 18, paddingVertical: 12, alignItems: 'center', minHeight: 48, justifyContent: 'center' }}>
          <Txt size={14} latin>{instant ? ltr(formatTime(instant, { locale: lang, timeZone })) : '—'}</Txt>
        </Btn>
      </View>
      {picking && !disabled ? (
        <DateTimePicker testID={`${testID}-picker`} value={pickerValue} mode={picking} is24Hour themeVariant={scheme} locale={lang}
          positiveButton={{ label: t.ok, textColor: p.ac }} negativeButton={{ label: t.cancel, textColor: p.mu }}
          display={Platform.OS === 'ios' || picking === 'time' ? 'spinner' : 'default'}
          onChange={(event, picked) => {
            setPicking(Platform.OS === 'ios' ? picking : null);
            if (event.type === 'dismissed' || !picked) return;
            // Keep the other half: a new date keeps the hour, a new hour the date.
            const pickedLocal = localDateTimeFor(picked, timeZone);
            const currentLocal = localDateTimeFor(pickerValue, timeZone);
            const local = picking === 'date'
              ? `${pickedLocal.slice(0, 10)}T${currentLocal.slice(11)}`
              : `${currentLocal.slice(0, 10)}T${pickedLocal.slice(11)}`;
            const next = instantForLocalDateTime(local, timeZone);
            if (next) onValueChange(next.toISOString());
          }} />
      ) : null}
    </View>
  );
}
