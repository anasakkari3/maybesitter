import React from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { fmt, titleOf } from '../state/derive';
import { busyWeekdays, TODAY, WEEK_START_DATE } from '../state/seed';
import { ltr } from '../i18n/strings';
import { Btn, Card, Txt } from '../ui/primitives';
import { Hatch } from '../ui/icons';
import { ScreenIn } from '../ui/motion';
import { cardShadow } from '../theme/tokens';
import { BrandLogo } from '../ui/brand';

export function CalendarScreen() {
  const { s, t, p, lang, actions } = useApp();
  const insets = useSafeAreaInsets();
  const barColor = (imp: string) => (imp === 'must' ? p.wm : p.ac);

  const selItems = s.commitments
    .filter(c => c.day === s.selDay && c.status !== 'dropped')
    .sort((a, b) => (a.h ?? 99) - (b.h ?? 99));
  const load = selItems.length === 0 ? t.loadLight : selItems.length < 3 ? t.loadNormal : t.loadFull;

  return (
    <ScreenIn style={{ backgroundColor: p.bg }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: 130, gap: 14 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <BrandLogo variant="badge" size={44} />
          <View style={{ flexShrink: 1 }}>
            <Txt size={13} color={p.mu}>{t.weekRange}</Txt>
            <Txt size={28} weight={600} lh={1.3}>{t.calendarTitle}</Txt>
          </View>
        </View>

        <Card pad={0} style={{ paddingVertical: 14, paddingHorizontal: 10 }}>
          <View style={{ flexDirection: 'row', gap: 4 }}>
            {t.daysShort.map((name, i) => {
              const items = s.commitments.filter(c => c.day === i && c.status !== 'dropped');
              const busy = busyWeekdays.includes(i);
              const sel = s.selDay === i;
              return (
                <Btn
                  key={i}
                  onPress={() => actions.setSelDay(i)}
                  label={t.days[i]}
                  scaleTo={0.94}
                  style={{ flex: 1, alignItems: 'center', gap: 2, paddingTop: 8, paddingBottom: 10, paddingHorizontal: 4, borderRadius: 16, backgroundColor: sel ? p.sf2 : 'transparent', minHeight: 88 }}
                >
                  <Txt size={11} color={p.mu} align="center" lines={1}>{name}</Txt>
                  <View style={{ width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: i === TODAY ? p.ac : 'transparent' }}>
                    <Txt size={16} weight={600} align="center" color={i === TODAY ? p.onAccent : p.tx} lh={1.25} latin>{WEEK_START_DATE + i}</Txt>
                  </View>
                  <View style={{ alignSelf: 'stretch', gap: 3, marginTop: 6 }}>
                    {items.slice(0, 3).map(c => (
                      <View key={c.id} style={{ height: 4, borderRadius: 2, backgroundColor: barColor(c.imp), opacity: 0.9 }} />
                    ))}
                    {busy && (
                      <View style={{ height: 5, borderRadius: 2, borderWidth: 1, borderColor: p.ln, overflow: 'hidden' }}>
                        <Hatch color={p.hatch} radius={2} />
                      </View>
                    )}
                  </View>
                </Btn>
              );
            })}
          </View>
          <View style={{ flexDirection: 'row', gap: 14, paddingTop: 12, paddingHorizontal: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <View style={{ width: 14, height: 4, borderRadius: 2, backgroundColor: p.ac }} />
              <Txt size={11} color={p.mu}>{t.legendCommit}</Txt>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <View style={{ width: 14, height: 5, borderRadius: 2, overflow: 'hidden', borderWidth: 1, borderColor: p.ln }}>
                <Hatch color={p.hatch} radius={2} />
              </View>
              <Txt size={11} color={p.mu}>{t.legendBusy}</Txt>
            </View>
          </View>
        </Card>

        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingTop: 4, paddingHorizontal: 4 }}>
          <Txt size={16} weight={600}>{t.days[s.selDay]}</Txt>
          <Txt size={12} color={p.mu}>{load}</Txt>
        </View>

        <View style={{ gap: 8 }}>
          {selItems.map(c => (
            <Btn key={c.id} onPress={() => actions.openDetail(c.id)} scaleTo={0.98} style={[{ backgroundColor: p.sf, borderRadius: 18, paddingVertical: 14, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 12 }, cardShadow(p)]}>
              <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: barColor(c.imp) }} />
              <Txt size={15} style={{ flex: 1 }}>{titleOf(c, lang)}</Txt>
              <Txt size={12} color={p.mu}>{ltr(fmt(c.h, c.m) ?? t.noTimeYet)}</Txt>
            </Btn>
          ))}
          {selItems.length === 0 && (
            <View style={{ padding: 26, backgroundColor: p.sf, borderRadius: 18 }}>
              <Txt size={14} color={p.mu} align="center">{t.dayFree}</Txt>
            </View>
          )}
        </View>
      </ScrollView>
    </ScreenIn>
  );
}
