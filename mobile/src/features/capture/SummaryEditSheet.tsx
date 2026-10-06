import React, { useState } from 'react';
import { Platform, TextInput, View } from 'react-native';
import { AppDateTimePicker as DateTimePicker } from '../../ui/AppDateTimePicker';
import { useApp } from '../../state/AppContext';
import { useTimeZone } from '../../i18n/timezone';
import { formatDate, formatTime } from '../../i18n/format';
import { ltr, type Strings } from '../../i18n/strings';
import { family } from '../../theme/fonts';
import { Btn, Pill, Txt } from '../../ui/primitives';
import type { CaptureProposalEdit } from '../../api/endpoints/capture';
import { MAX_TITLE_LENGTH } from './captureMachine';
import { instantForLocalDateTime, localDateTimeFor } from './localInstant';

export type PointKind = NonNullable<CaptureProposalEdit['change']['kind']>;
const KINDS: readonly PointKind[] = ['commitment', 'possible_goal', 'consideration', 'idea', 'waiting_for'];

function kindName(kind: PointKind, t: Strings): string {
  switch (kind) {
    case 'commitment': return t.understoodKindCommitment;
    case 'possible_goal': return t.seedKindPossibleGoal;
    case 'consideration': return t.seedKindConsideration;
    case 'idea': return t.seedKindIdea;
    case 'waiting_for': return t.understoodKindWaitingFor;
  }
}

/**
 * «عدّل» on a line of «هيك فهمت» (M2b, condition 7): what it is, its words and
 * — for a commitment — its time, changed together and sent as one patch.
 * Nothing changed is nothing sent. Proposal-only: the confirm still decides.
 */
export function SummaryEditSheet({ kind: startKind, text: startText, at: startAt, busy = false, onSave, onCancel }: {
  kind: PointKind;
  text: string;
  /** The time the line shows now; null for none. */
  at: string | null;
  busy?: boolean;
  onSave(change: CaptureProposalEdit['change']): void;
  onCancel(): void;
}) {
  const { t, p, script, rtl } = useApp();
  const timezone = useTimeZone();
  const [kind, setKind] = useState<PointKind>(startKind);
  const [text, setText] = useState(startText);
  // `undefined`: the time is not touched. A string or null: the person set it.
  const [at, setAt] = useState<string | null | undefined>(undefined);

  const save = () => {
    const change: CaptureProposalEdit['change'] = {};
    if (kind !== startKind) change.kind = kind;
    if (text.trim() && text.trim() !== startText.trim()) change.text = text.trim();
    // A time belongs to a commitment only; a seed carries none.
    if (at !== undefined && kind === 'commitment' && at !== startAt) change.time = { at, timeZone: timezone };
    if (Object.keys(change).length === 0) { onCancel(); return; }
    onSave(change);
  };

  return (
    <View testID="understood-edit-sheet" accessibilityViewIsModal style={{ gap: 14 }}>
      <Txt size={22} weight={600} lh={1.5}>{t.understoodEditTitle}</Txt>

      <Txt size={13} color={p.mu}>{t.understoodEditKind}</Txt>
      <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {KINDS.map((option) => (
          <Btn key={option} testID={`understood-edit-kind-${option}`} label={kindName(option, t)}
            accessibilityRole="radio" accessibilityState={{ checked: option === kind }} onPress={() => setKind(option)} scaleTo={0.97}
            style={{ backgroundColor: option === kind ? p.acs : p.sf2, borderRadius: 999, paddingVertical: 10, paddingHorizontal: 14, minHeight: 44, justifyContent: 'center' }}>
            <Txt size={14} weight={600} color={option === kind ? p.ac : p.tx}>{kindName(option, t)}</Txt>
          </Btn>
        ))}
      </View>

      <Txt size={13} color={p.mu}>{t.understoodEditWords}</Txt>
      <TextInput testID="understood-edit-text" accessibilityLabel={t.understoodEditWords} value={text} onChangeText={setText}
        maxLength={MAX_TITLE_LENGTH} multiline
        style={{ backgroundColor: p.sf2, borderRadius: 18, paddingVertical: 12, paddingHorizontal: 16, fontSize: 16, minHeight: 56, color: p.tx, fontFamily: family(400, script), textAlign: rtl ? 'right' : 'left' }} />

      {kind === 'commitment' ? <>
        <Txt size={13} color={p.mu}>{t.understoodEditTime}</Txt>
        <SummaryTimeField testID="understood-edit-time" value={at === undefined ? startAt : at} timeZone={timezone} onValueChange={setAt} />
        <Pill testID="understood-edit-time-clear" label={t.understoodEditNoTime} onPress={() => setAt(null)} kind="soft" size={14} pad={12} />
      </> : null}

      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Pill testID="understood-edit-save" label={t.understoodEditSave} onPress={save} disabled={busy} style={{ flex: 1 }} />
        <Pill testID="understood-edit-cancel" label={t.cancel} onPress={onCancel} kind="outline" style={{ flex: 1 }} />
      </View>
    </View>
  );
}

/**
 * A date and a time on the clock the app shows, as one absolute instant
 * (`onValueChange(iso)`): the picker reads and writes wall-clock values in
 * `timeZone`, so what the person picks is what the patch says.
 */
function SummaryTimeField({ testID, value, timeZone, onValueChange }: {
  testID: string;
  value: string | null;
  timeZone: string;
  onValueChange(at: string): void;
}) {
  const { t, p, lang, scheme } = useApp();
  const [picking, setPicking] = useState<'date' | 'time' | null>(null);
  // With no time yet, the wheel opens on the next whole hour.
  const [nextHour] = useState(() => new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000));
  const instant = value ? new Date(value) : null;
  const pickerValue = instant ?? nextHour;
  return (
    <View testID={testID} style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn testID={`${testID}-date`} label={instant ? formatDate(instant, 'short', { locale: lang, timeZone }) : t.understoodEditPickTime}
          onPress={() => setPicking('date')}
          style={{ flex: 1, backgroundColor: p.sf2, borderRadius: 18, paddingVertical: 12, alignItems: 'center', minHeight: 48, justifyContent: 'center' }}>
          <Txt size={14}>{instant ? formatDate(instant, 'short', { locale: lang, timeZone }) : t.understoodEditPickTime}</Txt>
        </Btn>
        <Btn testID={`${testID}-clock`} label={instant ? formatTime(instant, { locale: lang, timeZone }) : t.understoodEditPickTime}
          onPress={() => setPicking('time')}
          style={{ flex: 1, backgroundColor: p.sf2, borderRadius: 18, paddingVertical: 12, alignItems: 'center', minHeight: 48, justifyContent: 'center' }}>
          <Txt size={14} latin>{instant ? ltr(formatTime(instant, { locale: lang, timeZone })) : '—'}</Txt>
        </Btn>
      </View>
      {picking ? (
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
