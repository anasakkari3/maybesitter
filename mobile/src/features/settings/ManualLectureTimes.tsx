import React from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { Btn, Card, Txt } from '../../ui/primitives';
import { LiveRegion } from '../../ui/liveRegion';
import { fill } from '../../i18n/strings';
import { isolateAuto } from '../../i18n/bidi';
import { formatDate } from '../../i18n/format';
import { useTimeZone } from '../../i18n/timezone';
import type { ManualBusySource } from '../../api/schemas/calendar';
import { useManualBusySources } from '../calendar/manualLectures';

/**
 * «أوقات محاضرات ضفتها»: every syllabus whose lecture times were added as busy
 * time, each removable (QA audit CXA10.3). Drawn only when there is one, in
 * the same row shape as the other phones that send busy time. Removing goes
 * through the screen's confirm dialog — sixteen weeks of busy time should not
 * go on one stray tap — so this section only asks for it.
 */
export function ManualLectureTimes({ onAskRemove, removing, failed }: {
  onAskRemove: (source: ManualBusySource) => void;
  removing: string | null;
  failed: boolean;
}) {
  const { t, p, lang } = useApp();
  const zone = useTimeZone();
  const sources = useManualBusySources();
  const rows = sources.data?.sources ?? [];
  if (rows.length === 0) return null;

  const day = (at: string) => isolateAuto(formatDate(new Date(at), 'short', { locale: lang, timeZone: zone }));
  // The window ends at a midnight that belongs to no lecture: the last day is the one before.
  const until = (source: ManualBusySource) => day(new Date(Date.parse(source.windowEnd) - 1).toISOString());

  return (
    <Card pad={0} style={{ overflow: 'hidden' }} testID="calendar-lecture-times">
      <View style={{ paddingHorizontal: 18, paddingTop: 14, paddingBottom: 6 }}>
        <Txt role="action">{t.manualBusyTitle}</Txt>
      </View>
      {rows.map((source) => (
        <View key={source.sourceId} testID={`calendar-lecture-times-${source.sourceId}`}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingHorizontal: 18, borderTopWidth: 1, borderTopColor: p.ln }}>
          <Txt role="supporting" style={{ flex: 1 }}>{fill(t.manualBusyRow, { date: day(source.addedAt), until: until(source) })}</Txt>
          <Btn
            testID={`calendar-lecture-remove-${source.sourceId}`}
            label={fill(t.manualBusyRemoveA11y, { date: day(source.addedAt) })}
            disabled={removing !== null}
            onPress={() => onAskRemove(source)}
            style={{ minHeight: 44, minWidth: 44, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center', borderRadius: 14, borderWidth: 1, borderColor: p.ln }}
          >
            <Txt size={14} color={p.ac}>{t.manualBusyRemove}</Txt>
          </Btn>
        </View>
      ))}
      <LiveRegion style={{ paddingHorizontal: 18 }} assertive>
        {failed ? <Txt size={13} color={p.wm} lh={1.5} style={{ paddingBottom: 12 }} testID="calendar-lecture-remove-failed">{t.manualBusyRemoveFailed}</Txt> : null}
      </LiveRegion>
    </Card>
  );
}
