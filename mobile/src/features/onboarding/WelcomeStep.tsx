import React from 'react';
import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useApp } from '../../state/AppContext';
import { Txt } from '../../ui/primitives';
import { CheckIcon } from '../../ui/icons';
import { OnboardingChrome } from './OnboardingChrome';

/**
 * What the app is, before it asks for anything (UC-2.R1, #171; Stitch `07`).
 *
 * A picture of the idea — several loose notes becoming one step — then what
 * it does, the three promises the rest of the product keeps (nothing saved
 * without a confirm, no "overdue", the user decides what it may use), and who
 * reads what the person says («مين بيفهم كلامك»), in the disclosure's own
 * words. The language switch sits beside the brand, so a wrong choice on the
 * first screen is one tap to undo.
 */
export function WelcomeStep({ onContinue }: { onContinue: () => void }) {
  const { t, p } = useApp();
  const cards = [t.obWelcomeCard1, t.obWelcomeCard2, t.obWelcomeCard3];

  return (
    <OnboardingChrome
      step="welcome"
      title={t.obWelcomeTitle}
      testID="onboarding-welcome"
      languageSwitch
      primary={{ label: t.obContinue, onPress: onContinue }}
    >
      <Txt size={16} color={p.mu} lh={1.5}>{t.obWelcomeBody}</Txt>
      <WelcomeHero />
      <View style={{ gap: 10 }}>
        {cards.map((line, index) => (
          <View key={line} style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
            <View accessible={false} style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: p.successSoft, alignItems: 'center', justifyContent: 'center', marginTop: 2 }}>
              <CheckIcon size={12} color={p.success} />
            </View>
            <Txt size={15} lh={1.5} style={{ flex: 1 }} testID={`onboarding-welcome-card-${index}`}>{line}</Txt>
          </View>
        ))}
      </View>
      <DisclosureCard testID="onboarding-welcome-disclosure" />
    </OnboardingChrome>
  );
}

/**
 * «مين بيفهم كلامك» — who reads what the person writes or says, and what is
 * kept, in the disclosure's own words. A card to read, with nothing to press:
 * AI processing is told, not asked (owner decision 2026-09-30).
 */
export function DisclosureCard({ testID }: { testID: string }) {
  const { t, p } = useApp();
  return (
    <View testID={testID} style={{ gap: 8, borderRadius: 20, borderWidth: 1, borderColor: p.ln, backgroundColor: p.sf, padding: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <ShieldGlyph color={p.ac} />
        <Txt role="section" size={17} weight={700} style={{ flexShrink: 1 }}>{t.aiDisclosureTitle}</Txt>
      </View>
      <Txt size={15} color={p.mu} lh={1.5}>{t.aiDisclosure}</Txt>
      <Txt size={15} weight={600} color={p.tx} lh={1.5}>{t.aiDisclosureKept}</Txt>
    </View>
  );
}

/** The disclosure's shield, decorative. */
export function ShieldGlyph({ color }: { color: string }) {
  return (
    <View accessible={false}>
      <Svg width={20} height={20} viewBox="0 0 24 24">
        <Path d="M12 3l8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6Z" fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" />
      </Svg>
    </View>
  );
}

/**
 * Loose notes on one side, one coral step on the other (Stitch `07`'s
 * picture). Shapes only, no words and nothing to announce: the title and the
 * body below say it. Static under every motion preference.
 */
function WelcomeHero() {
  const { p } = useApp();
  const note = (width: number, tilt: string) => (
    <View style={{ width: 92, paddingVertical: 9, paddingHorizontal: 10, borderRadius: 12, backgroundColor: p.sf2, borderWidth: 1, borderColor: p.ln, gap: 6, transform: [{ rotate: tilt }] }}>
      <View style={{ width, height: 5, borderRadius: 3, backgroundColor: p.lnStrong }} />
      <View style={{ width: width * 0.7, height: 4, borderRadius: 2, backgroundColor: p.ln }} />
    </View>
  );
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={{ height: 168, borderRadius: 24, backgroundColor: p.sf, borderWidth: 1, borderColor: p.ln, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 22, overflow: 'hidden' }}
    >
      <View style={{ gap: 10 }}>
        {note(48, '-3deg')}
        {note(40, '2deg')}
        {note(56, '-1deg')}
      </View>
      <View style={{ width: 124, paddingVertical: 16, borderRadius: 18, backgroundColor: p.ac, alignItems: 'center', gap: 8, ...{ shadowColor: p.ac, shadowOpacity: 0.35, shadowRadius: 16, shadowOffset: { width: 0, height: 6 } } }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: p.onAccent }} />
        <View style={{ width: 64, height: 6, borderRadius: 3, backgroundColor: p.onAccent, opacity: 0.85 }} />
        <View style={{ width: 44, height: 5, borderRadius: 3, backgroundColor: p.onAccent, opacity: 0.6 }} />
      </View>
    </View>
  );
}
