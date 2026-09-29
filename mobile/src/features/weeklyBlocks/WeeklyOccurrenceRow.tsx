import React from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { useTimeZone } from '../../i18n/timezone';
import { formatTime, formatTimeRange } from '../../i18n/format';
import { fill } from '../../i18n/strings';
import { useLayoutMode } from '../../theme/textScale';
import { Btn, Txt } from '../../ui/primitives';
import { Tag } from '../../ui/chrome';
import type { WeeklyBlockOccurrence } from '../../api/schemas/weeklyBlocks';

/**
 * One occurrence of a weekly fixed block on a day — «ثابت · تدريب ·
 * 10:00–16:00» — drawn as time that is taken, not as a thing to do: no check
 * circle, no swipe, no «تمّت». Sand-grey with a solid start edge, beside the
 * dashed busy rows the phone's calendar reports and apart from the
 * commitments. A tap opens «الثابت الأسبوعي», where it is changed.
 */
export function WeeklyOccurrenceRow({ occurrence, testID }: { occurrence: WeeklyBlockOccurrence; testID?: string }) {
  const { t, p, lang, actions } = useApp();
  const timezone = useTimeZone();
  const stacked = useLayoutMode() !== 'normal';
  const start = new Date(occurrence.startAt);
  const end = new Date(occurrence.endAt);
  const options = { locale: lang, timeZone: timezone } as const;
  const spoken = [
    occurrence.title,
    t.wbFixedTag,
    fill(t.wbA11yTime, { start: formatTime(start, options), end: formatTime(end, options) }),
  ].join(t.wbListSep);
  return (
    <Btn
      testID={testID}
      label={spoken}
      hint={t.wbTitle}
      onPress={() => actions.go('weeklyBlocks')}
      scaleTo={0.98}
      style={{
        flexDirection: stacked ? 'column' : 'row', alignItems: stacked ? 'flex-start' : 'center', gap: 10,
        borderRadius: 18, paddingVertical: 12, paddingHorizontal: 16, minHeight: 56,
        backgroundColor: p.sf2, borderStartWidth: 3, borderStartColor: p.lnStrong,
      }}
    >
      <Tag kind="fixed" label={t.wbFixedTag} />
      <View style={stacked ? { gap: 2 } : { flex: 1 }}>
        <Txt size={15}>{occurrence.title}</Txt>
      </View>
      <Txt size={13} color={p.mu} latin testID={testID ? `${testID}-time` : undefined}>{formatTimeRange(start, end, options)}</Txt>
    </Btn>
  );
}
