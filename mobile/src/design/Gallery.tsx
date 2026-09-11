import React from 'react';
import { ScrollView, View } from 'react-native';
import { useApp } from '../state/AppContext';
import { Card, HeaderPill, ImpBadge, Pill, Txt } from '../ui/primitives';
import { color, radius, space, typeScale } from '../theme/tokens';

/**
 * Development-only gallery: every component the app renders, in one scroll,
 * so a change to a token or a primitive can be seen at a glance in both
 * schemes and both writing directions.
 *
 * Not part of any release: mount it behind `__DEV__`. It is deliberately
 * built from the same primitives as the real screens rather than a copy, so
 * it cannot drift from what the app actually renders.
 */
export function Gallery() {
  const { t, p, lang, scheme, actions } = useApp();

  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <View style={{ gap: space.md }}>
      <Txt size={typeScale.label} weight={600} color={p.mu}>{title}</Txt>
      <View style={{ gap: space.lg }}>{children}</View>
    </View>
  );

  return (
    <ScrollView
      style={{ backgroundColor: p.bg }}
      contentContainerStyle={{ padding: space.screen, gap: space.wide, paddingBottom: 120 }}
    >
      <View style={{ flexDirection: 'row', gap: space.md, alignItems: 'center' }}>
        <Txt size={typeScale.title2} weight={600}>Gallery</Txt>
        <Txt size={typeScale.caption} color={p.mu}>{`${scheme} · ${lang}`}</Txt>
      </View>
      <View style={{ flexDirection: 'row', gap: space.md }}>
        <Pill label={`scheme: ${scheme}`} onPress={actions.cycleTheme} kind="soft" size={typeScale.label} />
        <Pill label={`lang: ${lang}`} onPress={actions.toggleLang} kind="soft" size={typeScale.label} />
      </View>

      <Section title="Type scale">
        {(Object.keys(typeScale) as (keyof typeof typeScale)[]).map((name) => (
          <Txt key={name} size={typeScale[name]}>{`${name} · ${typeScale[name]}`}</Txt>
        ))}
      </Section>

      <Section title="Colour roles">
        {(Object.keys(color[scheme]) as (keyof (typeof color)['light'])[]).map((role) => (
          <View key={role} style={{ flexDirection: 'row', alignItems: 'center', gap: space.lg }}>
            <View
              style={{
                width: 36,
                height: 36,
                borderRadius: radius.small,
                backgroundColor: color[scheme][role],
                borderWidth: 1,
                borderColor: p.ln,
              }}
            />
            <Txt size={typeScale.bodySmall}>{role}</Txt>
          </View>
        ))}
      </Section>

      <Section title="Buttons">
        <Pill label={t.done} onPress={() => {}} />
        <Pill label={t.rearrange} onPress={() => {}} kind="outline" />
        <Pill label={t.dropIt} onPress={() => {}} kind="warm" />
        <Pill label={t.notNow} onPress={() => {}} kind="soft" />
        <Pill label={t.cancel} onPress={() => {}} kind="ghost" />
        <Pill label={t.done} kind="accent" disabled />
        <View style={{ alignItems: 'flex-start' }}>
          <HeaderPill label={t.back} onPress={() => {}} />
        </View>
      </Section>

      <Section title="Badges">
        <View style={{ flexDirection: 'row', gap: space.md }}>
          <ImpBadge imp="must" />
          <ImpBadge imp="should" />
          <ImpBadge imp="nice" />
        </View>
      </Section>

      <Section title="Card">
        <Card style={{ gap: space.md }}>
          <Txt size={typeScale.cardTitle} weight={600}>{t.nextStepLabel}</Txt>
          <Txt size={typeScale.bodySmall} color={p.mu}>{t.suggestionNote}</Txt>
        </Card>
      </Section>
    </ScrollView>
  );
}
