import React from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../../state/AppContext';
import { Btn, Txt } from '../../ui/primitives';
import { ScreenIn } from '../../ui/motion';
import { ONBOARDING_STEPS, type OnboardingStep } from '../../lib/deviceSettings/onboardingProgress';

/**
 * The frame every onboarding step renders inside (UC-2.R1, #171).
 *
 * One place for the safe-area padding, the progress line, the scroll
 * behaviour and the footer, so four screens cannot drift into four slightly
 * different layouts. It is also the one place `direction: 'rtl'` has to be
 * respected, which it is by using `gap` and `alignItems` rather than any
 * `left`/`right` offset — the root view flips the axis for Arabic and Hebrew
 * and nothing here fights it.
 */
export function OnboardingChrome({
  step,
  title,
  children,
  primary,
  secondary,
  footNote,
  testID,
}: {
  step: OnboardingStep;
  title: string;
  children: React.ReactNode;
  primary: { label: string; onPress?: (() => void) | undefined; disabled?: boolean };
  secondary?: { label: string; onPress: () => void } | undefined;
  footNote?: string | undefined;
  testID?: string;
}) {
  const { p, tr } = useApp();
  const insets = useSafeAreaInsets();
  const index = ONBOARDING_STEPS.indexOf(step);

  return (
    <ScreenIn style={{ backgroundColor: p.bg }}>
      <View
        testID={testID}
        style={{ flex: 1, paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }}
      >
        {/* A row of segments rather than a percentage bar: four steps is few
            enough to show as four, and it mirrors without any RTL arithmetic. */}
        <View
          accessibilityRole="progressbar"
          accessibilityLabel={tr('obStepOf', { current: index + 1, total: ONBOARDING_STEPS.length })}
          style={{ flexDirection: 'row', gap: 6, paddingHorizontal: 20, paddingBottom: 18 }}
        >
          {ONBOARDING_STEPS.map((name, i) => (
            <View
              key={name}
              testID={`onboarding-progress-${name}`}
              style={{ flex: 1, height: 3, borderRadius: 2, backgroundColor: i <= index ? p.ac : p.ln }}
            />
          ))}
        </View>

        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 24, gap: 16 }}
          keyboardShouldPersistTaps="handled"
        >
          <Txt size={28} weight={600} lh={1.3}>{title}</Txt>
          {children}
        </ScrollView>

        <View style={{ paddingHorizontal: 20, paddingTop: 12, gap: 10, borderTopWidth: 1, borderTopColor: p.ln }}>
          {footNote ? <Txt size={13} color={p.mu} align="center">{footNote}</Txt> : null}
          <Btn
            label={primary.label}
            disabled={primary.disabled}
            onPress={primary.disabled ? undefined : primary.onPress}
            style={{
              backgroundColor: primary.disabled ? p.ln : p.ac,
              borderRadius: 16,
              minHeight: 52,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Txt size={16} weight={600} color={primary.disabled ? p.mu : '#FFFFFF'}>{primary.label}</Txt>
          </Btn>
          {secondary ? (
            <Btn
              label={secondary.label}
              onPress={secondary.onPress}
              scaleTo={0.98}
              style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
            >
              <Txt size={15} color={p.mu}>{secondary.label}</Txt>
            </Btn>
          ) : null}
        </View>
      </View>
    </ScreenIn>
  );
}
