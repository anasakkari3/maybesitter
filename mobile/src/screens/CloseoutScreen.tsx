import React from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { fill } from '../i18n/strings';
import { cardShadow } from '../theme/tokens';
import { Pill, Txt } from '../ui/primitives';
import { ScreenIn } from '../ui/motion';

// Daily close-out: only yesterday's open items, each "done" or "not yet".
// "Not yet" items are spread over free slots; nothing piles up.
export function CloseoutScreen() {
  const { s, t, p, lang, actions } = useApp();
  const insets = useSafeAreaInsets();
  const finished = s.yesterday.every(q => q.res != null);
  const moved: [{ d: string; time: string }, { d: string; time: string }] = [
    { d: t.tomorrow, time: '10:00' },
    { d: t.days[6] ?? '', time: '16:00' },
  ];

  return (
    <ScreenIn style={{ backgroundColor: p.bg }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: insets.bottom + 24, gap: 18 }}>
        <View>
          <Txt size={13} color={p.mu}>{t.yesterday}</Txt>
          <Txt size={26} weight={600} lh={1.4}>{t.closeoutTitle}</Txt>
        </View>
        <View style={{ gap: 10 }}>
          {s.yesterday.map((q, i) => (
            <View key={q.id} style={[{ backgroundColor: p.sf, borderRadius: 22, padding: 16, gap: 12 }, cardShadow(p)]}>
              <Txt size={16} weight={500}>{q.title[lang] || q.title.ar}</Txt>
              {q.res == null ? (
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Pill label={t.done} onPress={() => actions.markYesterday(q.id, 'done')} radius={16} pad={14} style={{ flex: 1 }} />
                  <Pill label={t.notYet} onPress={() => actions.markYesterday(q.id, 'later')} kind="soft" radius={16} pad={14} style={{ flex: 1 }} />
                </View>
              ) : (
                <View style={{ borderRadius: 14, paddingVertical: 10, paddingHorizontal: 12, backgroundColor: q.res === 'done' ? p.acs : p.sf2 }}>
                  <Txt size={14} weight={500} color={q.res === 'done' ? p.ac : p.mu}>
                    {q.res === 'done'
                      ? t.toastDone
                      : fill(t.movedTo, i % 2 === 0 ? { d: moved[0].d, t: moved[0].time } : { d: moved[1].d, t: moved[1].time })}
                  </Txt>
                </View>
              )}
            </View>
          ))}
        </View>
        {finished && (
          <View style={{ paddingHorizontal: 6 }}>
            <Txt size={14} color={p.mu}>{t.closeoutSummary}</Txt>
          </View>
        )}
        <View style={{ marginTop: 'auto' }}>
          <Pill label={finished ? t.closeoutDone : t.closeoutAnswer} onPress={actions.finishCloseout} disabled={!finished} />
        </View>
      </ScrollView>
    </ScreenIn>
  );
}
