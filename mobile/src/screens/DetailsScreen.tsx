import React from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { dayLabel, fmt, titleOf } from '../state/derive';
import { ltr } from '../i18n/strings';
import { Card, HeaderPill, ImpBadge, Pill, Txt } from '../ui/primitives';
import { ScreenIn } from '../ui/motion';

export function DetailsScreen() {
  const { s, t, p, lang, actions } = useApp();
  const insets = useSafeAreaInsets();
  // Details always opens on a commitment; the sample week's third item is the
  // design's stand-in when a deep link names nothing.
  const c = s.commitments.find(x => x.id === s.detailId) ?? s.commitments[2];
  if (!c) return null;
  const statusLabel = c.status === 'done' ? t.doneS : c.status === 'dropped' ? t.dropped : t.active;

  return (
    <ScreenIn style={{ backgroundColor: p.bg }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: insets.bottom + 24, gap: 18 }}>
        <View style={{ alignItems: 'flex-start' }}>
          <HeaderPill label={t.back} onPress={actions.back} />
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <ImpBadge imp={c.imp} />
          <View style={{ backgroundColor: p.sf2, borderRadius: 999, paddingVertical: 4, paddingHorizontal: 10 }}>
            <Txt size={12} weight={600} color={p.mu}>{statusLabel}</Txt>
          </View>
        </View>
        <Txt size={26} weight={600} lh={1.4}>{titleOf(c, lang)}</Txt>
        <Card pad={0} style={{ paddingVertical: 6, paddingHorizontal: 18 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: p.ln }}>
            <Txt size={15} color={p.mu}>{t.dayLabel}</Txt>
            <Txt size={15}>{dayLabel(c.day, t)}</Txt>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 12 }}>
            <Txt size={15} color={p.mu}>{t.timeLabel}</Txt>
            <Txt size={15}>{ltr(fmt(c.h, c.m) ?? t.noTimeYet)}</Txt>
          </View>
        </Card>

        {/* Done, rearrange and drop-on-purpose carry equal weight. */}
        <View style={{ marginTop: 'auto', gap: 10 }}>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Pill label={t.done} onPress={() => actions.setStatus(c.id, 'done', t.toastDone)} radius={20} pad={18} style={{ flex: 1 }} />
            <Pill label={t.rearrange} onPress={actions.openRearrange} kind="outline" radius={20} pad={18} style={{ flex: 1 }} />
          </View>
          <Pill label={t.dropIt} onPress={() => actions.setStatus(c.id, 'dropped', t.toastDrop)} kind="warm" radius={20} pad={18} />
        </View>
      </ScrollView>
    </ScreenIn>
  );
}
