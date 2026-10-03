import React, { useState } from 'react';
import { Modal, Platform, ScrollView, TextInput, View } from 'react-native';
import DateTimePicker, { type AndroidNativeProps, type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { useApp } from '../state/AppContext';
import { fill } from '../i18n/strings';
import { Btn, Txt } from './primitives';

type PickerProps = React.ComponentProps<typeof DateTimePicker>;

/**
 * Android's native dialogs follow the device locale and theme, even when the
 * reader chose another app language or appearance. Use app-language controls
 * on Android; iOS keeps its localized system controls.
 */
export function AppDateTimePicker(props: PickerProps) {
  if (Platform.OS !== 'android' || !('mode' in props)) return <DateTimePicker {...props} />;
  if (props.mode === 'date') return <AndroidDatePicker {...props as AndroidNativeProps} />;
  if (props.mode === 'time') return <AndroidTimePicker {...props as AndroidNativeProps} />;
  return <DateTimePicker {...props} />;
}

function pickerEvent(type: 'set' | 'dismissed', date: Date): DateTimePickerEvent {
  return { type, nativeEvent: { timestamp: date.getTime(), utcOffset: -date.getTimezoneOffset() } };
}

function digits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, digit => {
    const code = digit.charCodeAt(0);
    return String(code >= 0x6f0 ? code - 0x6f0 : code - 0x660);
  });
}

function AndroidTimePicker(props: AndroidNativeProps) {
  const { t, p } = useApp();
  const [hour, setHour] = useState(String(props.value.getHours()).padStart(2, '0'));
  const [minute, setMinute] = useState(String(props.value.getMinutes()).padStart(2, '0'));
  const hourNumber = Number(hour);
  const minuteNumber = Number(minute);
  const minuteStep = props.minuteInterval ?? 1;
  const chosen = new Date(props.value);
  chosen.setHours(hourNumber, minuteNumber, 0, 0);
  const valid = /^\d{1,2}$/.test(hour) && /^\d{1,2}$/.test(minute)
    && hourNumber >= 0 && hourNumber <= 23 && minuteNumber >= 0 && minuteNumber <= 59
    && minuteNumber % minuteStep === 0
    && (!props.minimumDate || chosen >= props.minimumDate)
    && (!props.maximumDate || chosen <= props.maximumDate);
  const dismiss = () => {
    props.onDismiss?.();
    props.onChange?.(pickerEvent('dismissed', props.value), props.value);
  };
  const confirm = () => {
    if (!valid) return;
    const event = pickerEvent('set', chosen);
    props.onValueChange?.(event, chosen);
    props.onChange?.(event, chosen);
  };
  return <Modal transparent visible animationType="fade" onRequestClose={dismiss} accessibilityViewIsModal>
    <View style={{ flex: 1, backgroundColor: '#0009', justifyContent: 'center', padding: 16 }}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}>
        <View testID={props.testID ?? 'app-time-picker'} style={{ backgroundColor: p.sf, borderColor: p.ln, borderWidth: 1, borderRadius: 24, padding: 20, gap: 20 }}>
          <Txt size={20} weight={700} align="center">{t.editItemTime}</Txt>
          <View style={{ flexDirection: 'row', gap: 12 }}>
            {([
              { label: t.timeHour, value: hour, setValue: setHour, testID: 'time-hour' },
              { label: t.timeMinute, value: minute, setValue: setMinute, testID: 'time-minute' },
            ] as const).map(field => <View key={field.testID} style={{ flex: 1, gap: 8 }}>
              <Txt size={14} color={p.mu} align="center">{field.label}</Txt>
              <TextInput testID={field.testID} accessibilityLabel={field.label} value={field.value}
                onChangeText={value => field.setValue(digits(value).replace(/\D/g, '').slice(0, 2))}
                onFocus={() => field.setValue('')} keyboardType="number-pad" maxLength={2} placeholder="--" placeholderTextColor={p.mu}
                style={{ minHeight: 64, borderRadius: 16, borderWidth: 1, borderColor: p.ln, backgroundColor: p.sf2,
                  color: p.tx, textAlign: 'center', fontSize: 24, paddingHorizontal: 8 }} />
            </View>)}
          </View>
          {minuteStep > 1 ? <Txt size={12} color={p.mu} align="center">{fill(t.timeMinuteStep, { count: minuteStep })}</Txt> : null}
          {!valid ? <Txt size={12} color={p.wm} align="center">{t.timeInvalid}</Txt> : null}
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
            <Btn label={props.negativeButton?.label ?? t.cancel} onPress={dismiss} style={{ minHeight: 48, paddingHorizontal: 16, justifyContent: 'center' }}>
              <Txt size={14} color={p.mu}>{props.negativeButton?.label ?? t.cancel}</Txt>
            </Btn>
            <Btn label={props.positiveButton?.label ?? t.ok} onPress={confirm} disabled={!valid}
              style={{ minHeight: 48, paddingHorizontal: 16, justifyContent: 'center' }}>
              <Txt size={14} weight={700} color={valid ? p.ac : p.disTx}>{props.positiveButton?.label ?? t.ok}</Txt>
            </Btn>
          </View>
        </View>
      </ScrollView>
    </View>
  </Modal>;
}

function firstOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function AndroidDatePicker(props: AndroidNativeProps) {
  const { t, p, lang } = useApp();
  const [month, setMonth] = useState(() => firstOfMonth(props.value));
  const [selected, setSelected] = useState(() => props.value);
  const locale = lang === 'ar' ? 'ar-u-nu-latn' : lang;
  const monthLabel = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(month);
  // One glyph per column stays legible at 200% without shrinking the reader's text.
  // Each selectable date still exposes its full weekday and date to TalkBack.
  const weekdayLabels = Array.from({ length: 7 }, (_, day) =>
    new Intl.DateTimeFormat(locale, { weekday: 'narrow' }).format(new Date(2026, 9, 4 + day)));
  const firstWeekday = month.getDay();
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells: (number | null)[] = [...Array.from({ length: firstWeekday }, () => null), ...Array.from({ length: days }, (_, day) => day + 1)];
  while (cells.length % 7 !== 0) cells.push(null);

  const dismiss = () => {
    props.onDismiss?.();
    props.onChange?.(pickerEvent('dismissed', selected), selected);
  };
  const confirm = () => {
    const event = pickerEvent('set', selected);
    props.onValueChange?.(event, selected);
    props.onChange?.(event, selected);
  };
  const choose = (day: number) => {
    const date = new Date(selected);
    date.setFullYear(month.getFullYear(), month.getMonth(), day);
    setSelected(date);
  };
  const changeMonth = (delta: number) => setMonth(current => new Date(current.getFullYear(), current.getMonth() + delta, 1));

  return (
    <Modal transparent visible animationType="fade" onRequestClose={dismiss} accessibilityViewIsModal>
      <View style={{ flex: 1, backgroundColor: '#0009', justifyContent: 'center', padding: 16 }}>
        <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}>
          <View testID={props.testID ?? 'app-date-picker'} style={{ backgroundColor: p.sf, borderColor: p.ln, borderWidth: 1, borderRadius: 24, padding: 16, gap: 14 }}>
            <Txt size={20} weight={700} align="center">{t.editItemDate}</Txt>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <Btn label={t.datePreviousMonth} onPress={() => changeMonth(-1)} style={{ minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' }}>
                <Txt size={22} color={p.ac}>‹</Txt>
              </Btn>
              <Txt size={17} weight={700} align="center" style={{ flex: 1 }}>{monthLabel}</Txt>
              <Btn label={t.dateNextMonth} onPress={() => changeMonth(1)} style={{ minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' }}>
                <Txt size={22} color={p.ac}>›</Txt>
              </Btn>
            </View>
            <View style={{ flexDirection: 'row' }}>
              {weekdayLabels.map((name, day) => <View key={day} style={{ width: `${100 / 7}%`, alignItems: 'center' }}><Txt size={11} color={p.mu} lines={1}>{name}</Txt></View>)}
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
              {cells.map((day, index) => {
                if (day === null) return <View key={`empty-${index}`} style={{ width: `${100 / 7}%`, minHeight: 44 }} />;
                const candidate = new Date(selected);
                candidate.setFullYear(month.getFullYear(), month.getMonth(), day);
                const candidateDay = new Date(candidate.getFullYear(), candidate.getMonth(), candidate.getDate());
                const unavailable = (props.minimumDate && candidateDay < new Date(props.minimumDate.getFullYear(), props.minimumDate.getMonth(), props.minimumDate.getDate())) ||
                  (props.maximumDate && candidateDay > new Date(props.maximumDate.getFullYear(), props.maximumDate.getMonth(), props.maximumDate.getDate()));
                const active = sameDay(candidate, selected);
                const label = new Intl.DateTimeFormat(locale, { dateStyle: 'full' }).format(candidate);
                return <View key={day} style={{ width: `${100 / 7}%`, padding: 1 }}>
                  <Btn testID={`date-day-${day}`} label={label} accessibilityState={{ selected: active, disabled: Boolean(unavailable) }} disabled={Boolean(unavailable)}
                    onPress={() => choose(day)} style={{ minHeight: 44, borderRadius: 12, backgroundColor: active ? p.acs : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                    <Txt size={14} weight={active ? 700 : 400} color={unavailable ? p.disTx : active ? p.acd : p.tx}>{day}</Txt>
                  </Btn>
                </View>;
              })}
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
              <Btn label={props.negativeButton?.label ?? t.cancel} onPress={dismiss} style={{ minHeight: 48, paddingHorizontal: 16, justifyContent: 'center' }}>
                <Txt size={14} color={p.mu}>{props.negativeButton?.label ?? t.cancel}</Txt>
              </Btn>
              <Btn label={props.positiveButton?.label ?? t.ok} onPress={confirm} style={{ minHeight: 48, paddingHorizontal: 16, justifyContent: 'center' }}>
                <Txt size={14} weight={700} color={p.ac}>{props.positiveButton?.label ?? t.ok}</Txt>
              </Btn>
            </View>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}
