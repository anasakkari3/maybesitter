import React, { useState } from 'react';
import { Platform, Switch, TextInput, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useApp } from '../../state/AppContext';
import { useTimeZone } from '../../i18n/timezone';
import { formatDate, formatTime } from '../../i18n/format';
import { ltr } from '../../i18n/strings';
import { family } from '../../theme/fonts';
import { Btn, Pill, Txt } from '../../ui/primitives';
import { MAX_TITLE_LENGTH, type CaptureItemEdit } from './captureMachine';
import { instantForLocalDateTime, localDateTimeFor } from './localInstant';
import type { CaptureProposalItem } from '../../api/schemas/capture';

/**
 * Editing one proposed item before anything is saved (UC-2.4, #164).
 *
 * ── The edit travels with the confirm ────────────────────────────
 *
 * #172's original plan was a `PATCH /commitments/:id` after the confirm landed,
 * which leaves the user holding a commitment with a title they already changed
 * for as long as the second request takes — permanently, if it fails. The edits
 * are held here and sent atomically: what the user saw when they pressed
 * confirm is what gets written, or nothing is.
 *
 * ── The clock is theirs ──────────────────────────────────────────
 *
 * The pickers work in the device zone and the conversion to an instant happens
 * once, at send. Nothing here parses a local string with `new Date`, which
 * would read it in the host's zone.
 *
 * A past time is refused here as well as by the server. The server is the
 * authority; this exists so the user finds out while the sheet is open rather
 * than after pressing a button that writes.
 */
export function EditProposalItemSheet({
  item,
  edit,
  onChange,
  onClose,
}: {
  item: CaptureProposalItem;
  edit: CaptureItemEdit | undefined;
  onChange(next: CaptureItemEdit): void;
  onClose(): void;
}) {
  const { t, p, rtl, script, lang, scheme } = useApp();
  const timezone = useTimeZone();

  const originalLocal = item.resolvedTime ? localDateTimeFor(new Date(item.resolvedTime), timezone) : '';
  const currentLocal = edit?.localDateTime ?? originalLocal;

  const [title, setTitle] = useState(edit?.title ?? item.title);
  const [priority, setPriority] = useState<'high' | 'normal' | 'low'>(edit?.priority ?? item.priority ?? 'normal');
  const [local, setLocal] = useState(currentLocal);
  const [picking, setPicking] = useState<'date' | 'time' | null>(null);

  const trimmed = title.trim();
  const hasTime = local !== '';
  const instant = hasTime ? instantForLocalDateTime(local, timezone) : null;

  /**
   * A past time is checked when Save is pressed, not on every render.
   *
   * `Date.now()` in a render body is an impure call and the compiler rules
   * refuse it; recomputing it from an effect is a synchronous `setState` in an
   * effect, which they also refuse. Pressing Save is an event, where reading
   * the clock is ordinary — and it is the moment the answer matters. The server
   * refuses a past instant regardless; this is so the user finds out while the
   * sheet is still open rather than after a button that writes.
   */
  const [pastTime, setPastTime] = useState(false);
  const problem = trimmed.length === 0
    ? t.editItemEmpty
    : pastTime ? t.editItemPast : null;

  const save = React.useCallback(() => {
    if (trimmed.length === 0) return;
    if (instant !== null && instant.getTime() <= Date.now()) {
      setPastTime(true);
      return;
    }
    setPastTime(false);
    const next: CaptureItemEdit = {};
    // A flagged item is completed by hand only when the edit carries both a
    // title and a time -- that is `completedByHand` here and `commandsFor` on
    // the server, and neither reads the proposal's own title. So for a flagged
    // item the title goes even when it was left alone; otherwise adding the one
    // missing time left the item as unselectable as before (#498, after #492).
    // An untouched title on an unflagged item is still not sent: it would ask
    // the server to validate a change nobody made.
    if (item.needsClarification || trimmed !== item.title) next.title = trimmed;
    if (priority !== (item.priority ?? 'normal')) next.priority = priority;
    // The empty string is the "No time" answer, and is sent. An unchanged value
    // is not sent at all. For a flagged item with no time, the explicit "No time"
    // is sent so review knows the user confirmed the absence of a time (#505).
    if (local !== originalLocal || (item.needsClarification && local === '')) next.localDateTime = local;
    onChange(next);
    onClose();
  }, [instant, item, local, onChange, onClose, originalLocal, priority, trimmed]);

  const pickerValue = instant ?? new Date();

  return (
    <View style={{ gap: 14 }} testID="edit-item-sheet">
      <Txt size={22} weight={600} lh={1.5}>{t.editItemTitle}</Txt>

      <Txt size={13} color={p.mu}>{t.editItemName}</Txt>
      <TextInput
        testID="edit-item-title"
        value={title}
        onChangeText={setTitle}
        maxLength={MAX_TITLE_LENGTH}
        multiline
        style={{ backgroundColor: p.sf2, borderRadius: 18, paddingVertical: 12, paddingHorizontal: 16, fontSize: 16, minHeight: 56, color: p.tx, fontFamily: family(400, script), textAlign: rtl ? 'right' : 'left' }}
      />

      <Txt size={13} color={p.mu}>{t.editFieldPriority}</Txt>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {(['high', 'normal', 'low'] as const).map((level) => (
          <Btn
            key={level}
            testID={`edit-item-priority-${level}`}
            label={PRIORITY_LABEL(t)[level]}
            accessibilityRole="radio"
            onPress={() => setPriority(level)}
            style={{ flex: 1, backgroundColor: level === priority ? p.acs : p.sf2, borderRadius: 999, paddingVertical: 12, alignItems: 'center', minHeight: 48, justifyContent: 'center' }}
          >
            <Txt size={14} weight={600} color={level === priority ? p.ac : p.tx}>{PRIORITY_LABEL(t)[level]}</Txt>
          </Btn>
        ))}
      </View>

      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Txt size={13} color={p.mu}>{t.editItemWhen}</Txt>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Txt size={13}>{t.editItemNoTime}</Txt>
          <Switch
            testID="edit-item-no-time"
            value={!hasTime}
            onValueChange={(off) => setLocal(off ? '' : (originalLocal || localDateTimeFor(new Date(Date.now() + 3600_000), timezone)))}
          />
        </View>
      </View>

      {hasTime ? (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Btn
            testID="edit-item-pick-date"
            label={t.editItemDate}
            onPress={() => setPicking('date')}
            style={{ flex: 1, backgroundColor: p.sf2, borderRadius: 18, paddingVertical: 12, alignItems: 'center', minHeight: 48, justifyContent: 'center' }}
          >
            <Txt size={14}>{instant ? formatDate(instant, 'short', { locale: lang, timeZone: timezone }) : t.editItemDate}</Txt>
          </Btn>
          <Btn
            testID="edit-item-pick-time"
            label={t.editItemTime}
            onPress={() => setPicking('time')}
            style={{ flex: 1, backgroundColor: p.sf2, borderRadius: 18, paddingVertical: 12, alignItems: 'center', minHeight: 48, justifyContent: 'center' }}
          >
            <Txt size={14} latin>{instant ? ltr(formatTime(instant, { locale: lang, timeZone: timezone })) : t.editItemTime}</Txt>
          </Btn>
        </View>
      ) : null}

      {picking ? (
        <DateTimePicker
          testID="edit-item-picker"
          value={pickerValue}
          mode={picking}
          // Always 24-hour, because `formatTime` is always 24-hour: it sets
          // `hourCycle: 'h23'` unconditionally, in all three languages, so the
          // button beside this wheel reads "18:00" whatever the locale would
          // have preferred. Asking the locale drew a 12-hour wheel in `ar` and
          // `en` next to a 24-hour label.
          is24Hour
          // The native picker's own chrome is light unless told otherwise, and
          // unreadable inside a dark sheet.
          themeVariant={scheme}
          display={Platform.OS === 'ios' ? 'spinner' : 'default'}
          onChange={(event, picked) => {
            setPicking(Platform.OS === 'ios' ? picking : null);
            // A dismiss on Android carries the value the picker opened with.
            if (event.type === 'dismissed' || !picked) return;
            setLocal(localDateTimeFor(picked, timezone));
            // Their answer to the complaint; judged again on Save.
            setPastTime(false);
          }}
        />
      ) : null}

      {problem ? <Txt size={13} color={p.wm} testID="edit-item-problem">{problem}</Txt> : null}

      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Pill
          testID="edit-item-save"
          label={t.editItemSave}
          onPress={save}
          disabled={trimmed.length === 0}
          style={{ flex: 1 }}
        />
        <Pill testID="edit-item-cancel" label={t.editItemCancel} onPress={onClose} kind="outline" style={{ flex: 1 }} />
      </View>
    </View>
  );
}

const PRIORITY_LABEL = (t: { todayGroupMust: string; todayGroupShould: string; todayGroupNice: string }) => ({
  high: t.todayGroupMust,
  normal: t.todayGroupShould,
  low: t.todayGroupNice,
});
