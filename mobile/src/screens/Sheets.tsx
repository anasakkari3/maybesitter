import React from 'react';
import { Animated, Pressable, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { titleOf } from '../state/derive';
import { TODAY } from '../state/seed';
import { fill } from '../i18n/strings';
import { family } from '../theme/fonts';
import { Btn, Pill, Txt } from '../ui/primitives';
import { CheckIcon, MicIcon } from '../ui/icons';
import { useSheetMotion } from '../ui/motion';

function ClarifySheet() {
  const { t, p, ar, actions } = useApp();
  const chips = [
    { label: t.morning, h: 9 },
    { label: t.noon, h: 13 },
    { label: t.evening, h: 19 },
  ];
  return (
    <View style={{ gap: 14 }}>
      <Txt size={12} color={p.mu}>{t.oneQuestion}</Txt>
      <Txt size={22} weight={600} lh={1.5}>{t.clarifyQ}</Txt>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {chips.map(c => (
          <Btn key={c.h} onPress={() => actions.pickTime(c.h)} style={{ backgroundColor: p.acs, borderRadius: 999, paddingVertical: 12, paddingHorizontal: 18, minHeight: 48, justifyContent: 'center' }}>
            <Txt size={15} weight={600} color={p.ac}>{c.label}</Txt>
          </Btn>
        ))}
      </View>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <TextInput
          placeholder={t.orTypeTime}
          placeholderTextColor={p.mu}
          style={{ flex: 1, backgroundColor: p.sf2, borderRadius: 999, paddingVertical: 12, paddingHorizontal: 16, fontSize: 14, minHeight: 48, color: p.tx, fontFamily: family(400, ar), textAlign: ar ? 'right' : 'left' }}
        />
        <Btn onPress={actions.closeSheet} label={t.orTypeTime} style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: p.sf2, alignItems: 'center', justifyContent: 'center' }}>
          <MicIcon size={20} color={p.ac} />
        </Btn>
      </View>
      <Pill label={t.skipNoTime} onPress={actions.clarifySkip} kind="ghost" size={13} weight={400} pad={6} />
    </View>
  );
}

function ReadingsSheet() {
  const { t, p, actions } = useApp();
  const readings = [
    { title: t.thisThu, when: t.thisThuWhen, day: TODAY },
    { title: t.nextThu, when: t.nextThuWhen, day: TODAY + 7 },
  ];
  return (
    <View style={{ gap: 14 }}>
      <Txt size={22} weight={600} lh={1.5}>{t.readingsTitle}</Txt>
      <Txt size={14} color={p.mu}>{t.readingsBody}</Txt>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        {readings.map(r => (
          <Btn key={r.day} onPress={() => actions.pickReading(r.day)} style={{ flex: 1, backgroundColor: p.sf2, borderRadius: 20, padding: 16, gap: 6, minHeight: 110 }}>
            <Txt size={16} weight={600}>{r.title}</Txt>
            <Txt size={13} color={p.mu}>{r.when}</Txt>
          </Btn>
        ))}
      </View>
      <View style={{ backgroundColor: p.bg, borderRadius: 14, paddingVertical: 10, paddingHorizontal: 12 }}>
        <Txt size={12} color={p.mu}>{t.readingsPrivacy}</Txt>
      </View>
    </View>
  );
}

function RearrangeSheet() {
  const { s, t, p, lang, actions } = useApp();
  const c = s.commitments.find(x => x.id === s.detailId) ?? s.commitments[2];
  const options = [
    { label: t.intensify, hint: t.intensifyHint, pick: () => actions.intensify(c.id) },
    { label: t.extend, hint: t.extendHint, pick: () => actions.extend(c.id) },
    { label: t.shrink, hint: t.shrinkHint, pick: actions.shrink },
    { label: t.dropIt, hint: t.dropHint, pick: () => actions.setStatus(c.id, 'dropped', t.toastDrop) },
  ];
  return (
    <View style={{ gap: 14 }}>
      <Txt size={22} weight={600} lh={1.5}>{t.rearrangeTitle}</Txt>
      <Txt size={15} color={p.mu}>{fill(t.rearrangeReason, { t: titleOf(c, lang) })}</Txt>
      {/* Four equal choices; dropping on purpose sits beside the others. */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {options.map(o => (
          <Btn key={o.label} onPress={o.pick} style={{ width: '48%', flexGrow: 1, backgroundColor: p.sf2, borderRadius: 20, padding: 16, gap: 4, minHeight: 92 }}>
            <Txt size={16} weight={600}>{o.label}</Txt>
            <Txt size={12} color={p.mu}>{o.hint}</Txt>
          </Btn>
        ))}
      </View>
    </View>
  );
}

function ToastSheet() {
  const { s, t, p, actions } = useApp();
  return (
    <View style={{ gap: 14, alignItems: 'center', paddingVertical: 10 }}>
      <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: p.acs, alignItems: 'center', justifyContent: 'center' }}>
        <CheckIcon size={22} color={p.ac} weight={1.25} />
      </View>
      <Txt size={20} weight={600} align="center">{s.toast}</Txt>
      <Pill label={t.ok} onPress={actions.closeSheetHome} size={15} style={{ paddingHorizontal: 30 }} />
    </View>
  );
}

export function SheetHost() {
  const { s, p, actions } = useApp();
  const insets = useSafeAreaInsets();
  const m = useSheetMotion();
  if (!s.sheet) return null;
  return (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 30, justifyContent: 'flex-end' }}>
      <Animated.View style={[{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: p.scrim }, m.scrim]}>
        <Pressable style={{ flex: 1 }} onPress={actions.closeSheet} accessibilityLabel="close" />
      </Animated.View>
      <Animated.View
        style={[
          { backgroundColor: p.sf, borderTopLeftRadius: 36, borderTopRightRadius: 36, paddingTop: 14, paddingHorizontal: 20, paddingBottom: insets.bottom + 24, gap: 14, shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 20, shadowOffset: { width: 0, height: -10 }, elevation: 12 },
          m.panel,
        ]}
      >
        <View style={{ width: 40, height: 5, borderRadius: 3, backgroundColor: p.ln, alignSelf: 'center', marginBottom: 4 }} />
        {s.sheet === 'clarify' && <ClarifySheet />}
        {s.sheet === 'readings' && <ReadingsSheet />}
        {s.sheet === 'rearrange' && <RearrangeSheet />}
        {s.sheet === 'toast' && <ToastSheet />}
      </Animated.View>
    </View>
  );
}
