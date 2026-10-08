import React from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { useTimeZone } from '../../i18n/timezone';
import { formatTime, formatTimeRange } from '../../i18n/format';
import { fill, ltr } from '../../i18n/strings';
import { Txt } from '../../ui/primitives';
import { localDateTimeFor } from '../capture/localInstant';
import type { Gap } from './freeTime';
import type { FreeState } from './freeReadiness';

/**
 * Free time on the Plan tab (M4a R003): a gap row, the line that says free
 * time is not known yet, and the bands on the day's timeline.
 *
 * A gap is not a thing to do and has no action in M4a: it is text, read as
 * text («وقت فاضي من 14:00 لـ16:00»), never a button. Its look is the quiet
 * one — muted words, no card colour — so it sits between commitments without
 * competing with them; under «فاضي» the same row stands on its own.
 */

/** «ساعتين», «45 دقيقة», «ساعة و30 دقيقة». */
export function gapLength(minutes: number, t: ReturnType<typeof useApp>['t'], tr: ReturnType<typeof useApp>['tr']): string {
  const whole = Math.round(minutes);
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  if (hours === 0) return fill(t.yGapLengthMinutes, { count: rest });
  const hoursText = tr('yGapLengthHours', { count: hours });
  return rest === 0 ? hoursText : fill(t.yGapLengthMixed, { hours: hoursText, minutes: rest });
}

/** `calendar-gap-<day>-<HHMM>`, from the gap's local start. */
export function gapTestId(day: string, gap: Gap, timeZone: string): string {
  return `calendar-gap-${day}-${localDateTimeFor(new Date(gap.start), timeZone).slice(11, 16).replace(':', '')}`;
}

export function GapRow({ gap, day, quiet = false, height }: { gap: Gap; day: string; quiet?: boolean; height?: number }) {
  const { t, tr, p, lang } = useApp();
  const timeZone = useTimeZone();
  const options = { locale: lang, timeZone } as const;
  const start = new Date(gap.start);
  const end = new Date(gap.end);
  const range = formatTimeRange(start, end, options);
  const length = gapLength((gap.end - gap.start) / 60_000, t, tr);
  return (
    <View
      testID={gapTestId(day, gap, timeZone)}
      accessible
      accessibilityRole="text"
      accessibilityLabel={fill(t.yGapA11y, { from: ltr(formatTime(start, options)), to: ltr(formatTime(end, options)) })}
      style={{
        ...(height !== undefined ? { height } : { minHeight: 44 }),
        borderRadius: 14, paddingVertical: 6, paddingHorizontal: 12,
        borderWidth: 1, borderStyle: quiet ? 'dashed' : 'solid', borderColor: p.ln,
        backgroundColor: quiet ? 'transparent' : p.sf,
        flexDirection: 'row', alignItems: 'center', gap: 8,
      }}
    >
      <View accessible={false} style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: p.success }} />
      <Txt size={quiet ? 13 : 14} weight={quiet ? 400 : 600} color={quiet ? p.mu : p.tx} style={{ flexShrink: 1 }}>
        {fill(t.yGapRow, { range, length })}
      </Txt>
    </View>
  );
}

/** «عم بحسب الوقت الفاضي…» while a source loads; «الوقت الفاضي مش معروف هلّق» when one failed or covers too little. */
export function FreeStateLine({ state }: { state: FreeState }) {
  const { t, p } = useApp();
  if (state === 'full') return null;
  const loading = state === 'loading';
  return (
    <View
      testID={loading ? 'calendar-free-loading' : 'calendar-free-unknown'}
      accessible
      accessibilityRole="text"
      style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: p.ln, backgroundColor: p.sf, alignSelf: 'flex-start' }}
    >
      <View accessible={false} style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: p.mu }} />
      <Txt size={13} color={p.mu} style={{ flexShrink: 1 }}>{loading ? t.yFreeLoading : t.yFreeUnknown}</Txt>
    </View>
  );
}

/** The day's gaps under «فاضي». */
export function FreeList({ day, gaps, state, empty }: { day: string; gaps: readonly Gap[]; state: FreeState; empty: boolean }) {
  const { t, p } = useApp();
  return (
    <View testID="calendar-free-list" style={{ gap: 8 }}>
      {state === 'full' && empty ? <Txt size={15} color={p.mu} testID="calendar-free-all">{t.yDayAllFree}</Txt> : null}
      {state === 'full' && gaps.length === 0 ? <Txt size={15} color={p.mu} testID="calendar-free-none">{t.yDayNoFree}</Txt> : null}
      {gaps.map((gap) => <GapRow key={gap.start} gap={gap} day={day} />)}
    </View>
  );
}
