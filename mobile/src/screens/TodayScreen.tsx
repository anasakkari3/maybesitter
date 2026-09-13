import React from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { fmt, impColors, impLabel, titleOf } from '../state/derive';
import { NOW, seedBusy, TODAY } from '../state/seed';
import type { Commitment } from '../state/types';
import { ltr } from '../i18n/strings';
import { Btn, Card, Pill, Txt } from '../ui/primitives';
import { CheckIcon, Glow, Hatch } from '../ui/icons';
import { ScreenIn } from '../ui/motion';
import { BrandLogo } from '../ui/brand';

const H0 = 8;
const H1 = 22;
const PX = 52;
const y = (h: number, m = 0) => (h - H0) * PX + (m / 60) * PX;

export function TodayScreen() {
  const { s, t, tr, p, lang, actions } = useApp();
  const insets = useSafeAreaInsets();

  const todayC = s.commitments.filter(c => c.day === TODAY && c.status !== 'dropped');
  const active = todayC.filter(c => c.status === 'active');
  const isEmpty = todayC.length === 0;
  const isAllDone = !isEmpty && active.length === 0;
  const closeoutFinished = s.yesterday.every(q => q.res != null);
  const done = (c: Commitment) => isAllDone || c.status === 'done';
  const locked = todayC.filter(c => c.locked || c.h != null).slice(0, 4);
  const lockedDone = locked.filter(done).length;
  const unscheduled = todayC.filter(c => c.h == null && c.status === 'active');
  const timed = todayC.filter(c => c.h != null);

  return (
    <ScreenIn style={{ backgroundColor: p.bg }}>
      <View pointerEvents="none" style={{ position: 'absolute', top: -120, end: -80 }}>
        <Glow color={p.acs} />
      </View>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: 130, gap: 14 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1 }}>
            <BrandLogo variant="badge" size={44} />
            <View style={{ flexShrink: 1 }}>
              <Txt size={13} color={p.mu}>{t.dateToday}</Txt>
              <Txt size={28} weight={600} lh={1.3}>{t.todayTitle}</Txt>
            </View>
          </View>
          <View style={{ backgroundColor: p.sf, borderWidth: 1, borderColor: p.ln, borderRadius: 999, paddingVertical: 6, paddingHorizontal: 12 }}>
            <Txt size={12} color={p.mu}>{t.budgetPill}</Txt>
          </View>
        </View>

        {!closeoutFinished && !isEmpty && (
          <Btn onPress={() => actions.go('closeout')} scaleTo={0.98} style={{ backgroundColor: p.acs, borderRadius: 20, paddingVertical: 14, paddingHorizontal: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <Txt size={14} weight={500} color={p.ac} style={{ flexShrink: 1 }}>{t.closeoutBanner}</Txt>
            <Txt size={13} color={p.ac}>{t.closeoutCta}</Txt>
          </Btn>
        )}

        {isEmpty && (
          <View style={{ marginTop: 80, alignItems: 'center', gap: 14, paddingHorizontal: 20 }}>
            <BrandLogo variant="badge" size={72} decorative />
            <Txt size={20} weight={600} align="center">{t.emptyTitle}</Txt>
            <Txt size={14} color={p.mu} align="center">{t.emptyBody}</Txt>
            <Pill label={t.sayIt} onPress={actions.goCapture} style={{ marginTop: 6, paddingHorizontal: 26 }} />
          </View>
        )}

        {!isEmpty && (
          <>
            {/* locked set */}
            <Card style={{ paddingBottom: 14 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
                <Txt size={15} weight={600}>{tr('lockedTitle', { n: locked.length })}</Txt>
                <Txt size={13} color={p.mu}>{tr('progressWords', { d: lockedDone, n: locked.length })}</Txt>
              </View>
              <View style={{ height: 4, borderRadius: 2, backgroundColor: p.sf2, overflow: 'hidden', marginBottom: 12, flexDirection: 'row' }}>
                <View style={{ width: `${locked.length ? Math.round((lockedDone / locked.length) * 100) : 0}%`, backgroundColor: p.ac, borderRadius: 2 }} />
              </View>
              {isAllDone && <Txt size={15} weight={500} color={p.ac} style={{ paddingVertical: 6 }}>{t.allDone}</Txt>}
              {locked.map(c => {
                const d = done(c);
                return (
                  <View key={c.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: p.ln }}>
                    <Btn
                      onPress={() => actions.toggle(c.id)}
                      label={titleOf(c, lang)}
                      scaleTo={0.9}
                      hitSlop={10}
                      style={{ width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderColor: d ? p.ac : p.ln, backgroundColor: d ? p.ac : 'transparent', alignItems: 'center', justifyContent: 'center' }}
                    >
                      {d ? <CheckIcon color={p.onAccent} /> : null}
                    </Btn>
                    <Btn onPress={() => actions.openDetail(c.id)} scaleTo={0.98} style={{ flex: 1, minHeight: 28, gap: 2, alignItems: 'flex-start' }}>
                      <Txt size={15} style={d ? { textDecorationLine: 'line-through', opacity: 0.55 } : undefined}>{titleOf(c, lang)}</Txt>
                      <Txt size={12} color={p.mu}>{`${ltr(fmt(c.h, c.m) ?? t.noTimeYet)} · ${impLabel(c.imp, t)}`}</Txt>
                    </Btn>
                  </View>
                );
              })}
            </Card>

            {/* next step → first move */}
            {!s.nextDismissed && !isAllDone && (
              <Card style={{ gap: 10 }}>
                <Txt size={12} weight={600} color={p.mu}>{t.nextStepLabel}</Txt>
                <Txt size={16} weight={500}>{t.nextStepText}</Txt>
                <Txt size={12} color={p.mu}>{t.suggestionNote}</Txt>
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
                  <Pill label={t.splitIt} onPress={() => actions.go('firstmove')} size={14} pad={12} style={{ flex: 1 }} />
                  <Pill label={t.notNow} onPress={actions.dismissNext} kind="soft" size={14} weight={500} pad={12} style={{ flex: 1 }} />
                </View>
              </Card>
            )}

            {/* timeline */}
            <Card pad={0} style={{ paddingTop: 16, paddingHorizontal: 12, paddingBottom: 8 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 6, paddingBottom: 10, gap: 8 }}>
                <Txt size={15} weight={600}>{t.timelineTitle}</Txt>
                <Txt size={12} color={p.mu} style={{ flexShrink: 1 }}>{t.calConnected}</Txt>
              </View>
              <View style={{ height: (H1 - H0) * PX, position: 'relative' }}>
                {Array.from({ length: (H1 - H0) / 2 + 1 }, (_, i) => H0 + i * 2).map(h => (
                  <View key={h} style={{ position: 'absolute', top: y(h) - 7, start: 0, end: 0, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Txt size={11} color={p.mu} align="center" style={{ width: 40 }}>{ltr(`${h}:00`)}</Txt>
                    <View style={{ flex: 1, height: 1, backgroundColor: p.ln }} />
                  </View>
                ))}
                {seedBusy.map((b, i) => (
                  <View key={i} style={{ position: 'absolute', top: y(b.h, b.m) + 1, height: (b.dur / 60) * PX - 2, start: 46, end: 4, borderRadius: 12, borderWidth: 1, borderStyle: 'dashed', borderColor: p.ln, overflow: 'hidden', paddingVertical: 4, paddingHorizontal: 10 }}>
                    <Hatch color={p.hatch} />
                    <Txt size={11} color={p.mu}>{t.busy}</Txt>
                  </View>
                ))}
                {timed.map(c => {
                  const d = done(c);
                  const col = impColors(c.imp === 'must' ? 'must' : 'should', p);
                  return (
                    <Btn
                      key={c.id}
                      onPress={() => actions.openDetail(c.id)}
                      scaleTo={0.97}
                      style={{ position: 'absolute', top: y(c.h!, c.m) + 1, height: Math.max(30, (c.dur / 60) * PX - 2), start: 52, end: 12, borderRadius: 14, paddingVertical: 6, paddingHorizontal: 12, justifyContent: 'center', alignItems: 'flex-start', gap: 1, backgroundColor: d ? p.sf2 : col.bg }}
                    >
                      <Txt size={13} weight={600} color={d ? p.mu : col.fg} lines={1} style={d ? { textDecorationLine: 'line-through' } : undefined}>{titleOf(c, lang)}</Txt>
                      <Txt size={11} color={d ? p.mu : col.fg} style={{ opacity: 0.75 }}>{ltr(fmt(c.h, c.m)!)}</Txt>
                    </Btn>
                  );
                })}
                <View pointerEvents="none" style={{ position: 'absolute', top: y(NOW.h, NOW.m) - 7, start: 0, end: 0, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Txt size={11} weight={600} color={p.ac} align="center" style={{ width: 40 }}>{ltr(fmt(NOW.h, NOW.m)!)}</Txt>
                  <View style={{ flex: 1, height: 2, borderRadius: 1, backgroundColor: p.ac }} />
                </View>
              </View>
              {unscheduled.length > 0 && (
                <View style={{ borderTopWidth: 1, borderTopColor: p.ln, marginTop: 6, paddingTop: 12, paddingHorizontal: 6, paddingBottom: 6, gap: 8 }}>
                  <Txt size={12} color={p.mu}>{t.noTime}</Txt>
                  {unscheduled.map(c => (
                    <Btn key={c.id} onPress={() => actions.openDetail(c.id)} scaleTo={0.98} style={{ backgroundColor: p.sf2, borderRadius: 14, paddingVertical: 10, paddingHorizontal: 14, flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                      <Txt size={14} style={{ flexShrink: 1 }}>{titleOf(c, lang)}</Txt>
                      <Txt size={12} color={p.mu}>{impLabel(c.imp, t)}</Txt>
                    </Btn>
                  ))}
                </View>
              )}
            </Card>
          </>
        )}
      </ScrollView>
    </ScreenIn>
  );
}
