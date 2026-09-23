import React from 'react';
import { View } from 'react-native';
import type { Commitment } from '../../api/schemas/common';
import { useApp } from '../../state/AppContext';
import { useTimeZone } from '../../i18n/timezone';
import { formatRelativeDay, formatTime } from '../../i18n/format';
import { ltr } from '../../i18n/strings';
import { Btn, Txt } from '../../ui/primitives';

/** A factual reminder, labelled as a deadline rather than an AI explanation. */
export function DeadlineContext({ item, weekly = false }: { item: Commitment; weekly?: boolean }) {
  const { t, p, lang, actions } = useApp();
  const timeZone = useTimeZone();
  const date = new Date(item.timeSpec.dueAt!);
  const when = `${formatRelativeDay(date, { locale: lang, timeZone })}${item.timeSpec.allDay ? '' : ` · ${ltr(formatTime(date, { locale: lang, timeZone }))}`}`;
  const heading = weekly ? t.weekDeadlineContext : t.tomorrowDeadlineContext;
  return (
    <Btn testID={weekly ? 'calendar-week-insight' : 'today-insight'}
      label={`${heading}. ${item.title}. ${when}`} onPress={() => actions.openDetail(item.id)}
      style={{ paddingVertical: 16, paddingHorizontal: 18, borderRadius: 20, backgroundColor: p.wms, alignItems: 'flex-start', gap: 6 }}>
      <Txt role="supporting" weight={600} color={p.wm}>{heading}</Txt>
      <Txt role="body">{item.title}</Txt>
      <View style={{ alignSelf: 'stretch', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8 }}>
        <Txt role="supporting" color={p.mu}>{when}</Txt>
        <Txt role="supporting" color={p.acd}>{t.openDetails}</Txt>
      </View>
    </Btn>
  );
}
