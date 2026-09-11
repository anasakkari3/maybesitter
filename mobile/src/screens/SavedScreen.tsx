import React from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { dayLabel, fmt, titleOf } from '../state/derive';
import { TODAY } from '../state/seed';
import { fill, ltr } from '../i18n/strings';
import { accentGlow, cardShadow } from '../theme/tokens';
import { Btn, Pill, Txt } from '../ui/primitives';
import { CheckIcon, UndoRing } from '../ui/icons';
import { Pop, ScreenIn } from '../ui/motion';

export function SavedScreen() {
  const { s, t, p, lang, actions } = useApp();
  const insets = useSafeAreaInsets();
  const d = s.proposals[0]?.day ?? TODAY;
  const title = d === TODAY ? t.savedToday : d === TODAY + 1 ? t.savedTomorrow : fill(t.savedDay, { d: dayLabel(d, t) });
  const viewLabel = d === TODAY ? t.viewToday : d === TODAY + 1 ? t.viewTomorrow : fill(t.viewDay, { d: dayLabel(d, t) });
  const saved = s.commitments.filter(c => s.savedIds.includes(c.id));

  return (
    <ScreenIn style={{ backgroundColor: p.bg, paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: insets.bottom + 24 }}>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 }}>
        <Pop>
          <View style={[{ width: 72, height: 72, borderRadius: 36, backgroundColor: p.ac, alignItems: 'center', justifyContent: 'center' }, accentGlow(p, 0.3)]}>
            <CheckIcon size={30} color={p.onAccent} weight={2.5 / 2} />
          </View>
        </Pop>
        <Txt size={24} weight={600} align="center">{title}</Txt>
        <View style={{ alignSelf: 'stretch', gap: 8, marginTop: 6 }}>
          {saved.map(c => (
            <View key={c.id} style={[{ backgroundColor: p.sf, borderRadius: 18, paddingVertical: 14, paddingHorizontal: 16, flexDirection: 'row', justifyContent: 'space-between', gap: 10 }, cardShadow(p)]}>
              <Txt size={15} style={{ flexShrink: 1 }}>{titleOf(c, lang)}</Txt>
              <Txt size={12} color={p.mu}>{`${dayLabel(c.day, t)} · ${ltr(fmt(c.h, c.m) ?? t.noTimeYet)}`}</Txt>
            </View>
          ))}
        </View>
        {s.undoLeft > 0 && (
          <Btn onPress={actions.undo} label={t.undo} style={{ backgroundColor: p.sf2, borderRadius: 999, paddingVertical: 10, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Txt size={14}>{t.undo}</Txt>
            <View style={{ width: 26, height: 26, alignItems: 'center', justifyContent: 'center' }}>
              <UndoRing left={s.undoLeft} track={p.ln} color={p.ac} />
              <Txt size={11} weight={600} align="center" lh={1.2}>{s.undoLeft}</Txt>
            </View>
          </Btn>
        )}
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Pill label={viewLabel} onPress={actions.viewSavedDay} kind="outline" size={15} weight={500} style={{ flex: 1 }} />
        <Pill label={t.ok} onPress={actions.finishSaved} size={15} style={{ flex: 1 }} />
      </View>
    </ScreenIn>
  );
}
