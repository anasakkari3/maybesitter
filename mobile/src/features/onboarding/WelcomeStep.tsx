import React from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { Card, Txt } from '../../ui/primitives';
import { OnboardingChrome } from './OnboardingChrome';

/**
 * What the app is, before it asks for anything (UC-2.R1, #171).
 *
 * Three cards, and none of them a feature list. Each is a promise the rest of
 * the product then keeps: nothing saved without a confirm, no "overdue", and
 * the user deciding what it may use. The consent screen is next, so this is
 * the last moment to say what is about to be asked and why.
 */
export function WelcomeStep({ onContinue }: { onContinue: () => void }) {
  const { t, p } = useApp();
  const cards = [t.obWelcomeCard1, t.obWelcomeCard2, t.obWelcomeCard3];

  return (
    <OnboardingChrome
      step="welcome"
      title={t.obWelcomeTitle}
      testID="onboarding-welcome"
      primary={{ label: t.obContinue, onPress: onContinue }}
    >
      <Txt size={16} color={p.mu} lh={1.5}>{t.obWelcomeBody}</Txt>
      <View style={{ gap: 10 }}>
        {cards.map((line, index) => (
          <Card key={line} pad={16}>
            <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
              <View
                style={{
                  width: 6, height: 6, borderRadius: 3, backgroundColor: p.ac,
                  // Nudged onto the first line's optical centre rather than the
                  // top of the box, which reads as misaligned at this size.
                  marginTop: 8,
                }}
              />
              <Txt size={15} lh={1.5} style={{ flex: 1 }} testID={`onboarding-welcome-card-${index}`}>{line}</Txt>
            </View>
          </Card>
        ))}
      </View>
    </OnboardingChrome>
  );
}
