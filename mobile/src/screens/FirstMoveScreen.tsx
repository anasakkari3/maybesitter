import React from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { ltr } from '../i18n/strings';
import { Card, FlowHeader, Pill, Txt } from '../ui/primitives';
import { ScreenIn } from '../ui/motion';

// First move: split a big commitment across days, or start with a 2-minute
// step. The content never shrinks on its own; only time is spread.
const SESSION_DAYS = [5, 6, 0, 1, 2];
const SESSION_TIMES = ['17:00', '18:00', '17:00', '19:00', '17:00'];

export function FirstMoveScreen() {
  const { s, t, p, actions } = useApp();
  const insets = useSafeAreaInsets();
  const sessions = s.fmMode === 'sessions';

  return (
    <ScreenIn style={{ backgroundColor: p.bg }}>
      <FlowHeader pill={t.back} onPill={actions.back} title={t.firstMoveTitle} />
      <ScrollView contentContainerStyle={{ paddingTop: 18, paddingHorizontal: 20, paddingBottom: 20, gap: 14 }}>
        <Txt size={22} weight={600} lh={1.5}>{t.fmHeadline}</Txt>
        <Txt size={12} color={p.mu}>{t.suggestionNote}</Txt>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Pill label={t.fmSessions} onPress={() => actions.setFmMode('sessions')} kind={sessions ? 'ink' : 'soft'} size={14} pad={12} style={{ flex: 1 }} />
          <Pill label={t.fmTwoMin} onPress={() => actions.setFmMode('twomin')} kind={!sessions ? 'ink' : 'soft'} size={14} pad={12} style={{ flex: 1 }} />
        </View>
        {sessions ? (
          <Card style={{ gap: 12 }}>
            <Txt size={14} color={p.mu}>{t.fmSessionsBody}</Txt>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              {SESSION_DAYS.map((d, i) => (
                <View key={i} style={{ flex: 1, alignItems: 'center', gap: 6 }}>
                  <Txt size={11} color={p.mu} align="center">{t.daysShort[d]}</Txt>
                  <View style={{ alignSelf: 'stretch', height: 44, borderRadius: 12, backgroundColor: p.acs, alignItems: 'center', justifyContent: 'center' }}>
                    <Txt size={12} weight={600} color={p.ac} align="center">{ltr(SESSION_TIMES[i])}</Txt>
                  </View>
                </View>
              ))}
            </View>
            <Txt size={12} color={p.mu}>{t.fmSessionsNote}</Txt>
          </Card>
        ) : (
          <Card style={{ gap: 10 }}>
            <Txt size={12} weight={600} color={p.mu}>{t.fmTwoMinLabel}</Txt>
            <Txt size={18} weight={500}>{t.fmTwoMinStep}</Txt>
            <Txt size={13} color={p.mu}>{t.fmTwoMinWhy}</Txt>
          </Card>
        )}
      </ScrollView>
      <View style={{ paddingTop: 12, paddingHorizontal: 20, paddingBottom: insets.bottom + 16, gap: 8, borderTopWidth: 1, borderTopColor: p.ln }}>
        <Pill label={t.accept} onPress={actions.fmAccept} />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Pill label={t.edit} onPress={actions.back} kind="soft" size={14} weight={500} pad={14} style={{ flex: 1 }} />
          <Pill label={t.keepAsOne} onPress={actions.back} kind="soft" size={14} weight={500} pad={14} style={{ flex: 1 }} />
        </View>
      </View>
    </ScreenIn>
  );
}
