import React from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { dayLabel, fmt } from '../state/derive';
import { ltr } from '../i18n/strings';
import { family } from '../theme/fonts';
import { cardShadow } from '../theme/tokens';
import { Btn, FlowHeader, ImpBadge, Pill, Txt } from '../ui/primitives';
import { ScreenIn } from '../ui/motion';

export function ReviewScreen() {
  const { s, t, tr, p, ar, actions } = useApp();
  const insets = useSafeAreaInsets();
  const colors = [p.ac, p.wm];
  const n = s.proposals.length;
  // One ICU plural covers 0, 1 and the Arabic dual/few/many forms the old
  // three-way ternary got wrong from n=2 upwards.
  const confirmLabel = tr('confirmN', { n });

  return (
    <ScreenIn style={{ backgroundColor: p.bg }}>
      <FlowHeader pill={t.back} onPill={actions.backToCapture} title={t.reviewTitle} />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingTop: 18, paddingHorizontal: 20, paddingBottom: 20, gap: 14 }}>
        {/* The sentence, each span underlined in its card's colour. */}
        <View style={[{ backgroundColor: p.sf, borderRadius: 20, paddingVertical: 14, paddingHorizontal: 16 }, cardShadow(p)]}>
          <Text style={{ fontFamily: family(400, ar), fontSize: 19, lineHeight: 32, color: p.tx, textAlign: ar ? 'right' : 'left', writingDirection: ar ? 'rtl' : 'ltr' }}>
            {s.parts.map((part, i) => (
              <Text
                key={i}
                style={part.c < 0 ? { color: p.mu } : { textDecorationLine: 'underline', textDecorationColor: colors[part.c], textDecorationStyle: 'solid' }}
              >
                {part.text}
              </Text>
            ))}
          </Text>
        </View>
        <Txt size={12} color={p.mu} style={{ paddingHorizontal: 4 }}>{t.suggestionNote}</Txt>

        {s.proposals.map(q => {
          const stripe = colors[q.c] ?? p.ac;
          return (
            <View
              key={q.id}
              style={[
                { backgroundColor: p.sf, borderRadius: 24, paddingVertical: 16, paddingHorizontal: 18, gap: 12, borderStartWidth: 4, borderStartColor: stripe },
                cardShadow(p),
              ]}
            >
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
                <TextInput
                  value={q.title}
                  onChangeText={v => actions.setProposalTitle(q.id, v)}
                  style={{ flex: 1, minWidth: 0, borderBottomWidth: 1, borderStyle: 'dashed', borderBottomColor: p.ln, paddingTop: 2, paddingBottom: 6, fontSize: 18, fontFamily: family(600, ar), color: p.tx, textAlign: ar ? 'right' : 'left', writingDirection: ar ? 'rtl' : 'ltr' }}
                />
                <Btn onPress={() => actions.removeProposal(q.id)} label="remove" style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: p.sf2, alignItems: 'center', justifyContent: 'center' }}>
                  <Txt size={16} color={p.mu} align="center" lh={1.1}>×</Txt>
                </Btn>
              </View>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <Btn onPress={() => actions.cycleDay(q.id)} style={{ backgroundColor: p.sf2, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 12 }}>
                  <Txt size={13}>{dayLabel(q.day, t)}</Txt>
                </Btn>
                <Btn onPress={() => actions.cycleTime(q.id)} style={{ backgroundColor: q.h == null ? p.wms : p.sf2, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 12 }}>
                  <Txt size={13} weight={q.h == null ? 600 : 400} color={q.h == null ? p.wm : p.tx}>{ltr(fmt(q.h, q.m) ?? t.noTimeYet)}</Txt>
                </Btn>
                <ImpBadge imp={q.imp} style={{ alignSelf: 'center' }} />
              </View>
            </View>
          );
        })}

        {s.proposals.some(q => q.ambiguous) && s.sheet !== 'readings' && (
          <Btn onPress={actions.openReadings} scaleTo={0.98} style={{ backgroundColor: p.wms, borderRadius: 18, paddingVertical: 12, paddingHorizontal: 16 }}>
            <Txt size={14} color={p.wm}>{t.readingsBanner}</Txt>
          </Btn>
        )}
      </ScrollView>
      <View style={{ paddingTop: 12, paddingHorizontal: 20, paddingBottom: insets.bottom + 16, gap: 8, backgroundColor: p.bg, borderTopWidth: 1, borderTopColor: p.ln }}>
        <Pill label={confirmLabel} onPress={actions.confirm} disabled={n === 0} />
        <Pill label={t.cancelAll} onPress={actions.closeCapture} kind="ghost" size={14} weight={400} pad={10} />
      </View>
    </ScreenIn>
  );
}
