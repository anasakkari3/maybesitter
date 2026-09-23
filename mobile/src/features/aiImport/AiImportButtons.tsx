import React from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { Btn, Txt } from '../../ui/primitives';

/**
 * The footer this flow uses from both of its entry points.
 *
 * `OnboardingChrome` owns the primary button inside onboarding, but this flow
 * also runs from Settings where there is no step progress to draw — so the
 * buttons live with the flow rather than with either chrome. One implementation
 * either way was the point of the feature.
 */
export function PrimaryButton({
  label, onPress, disabled, testID,
}: {
  label: string;
  onPress?: (() => void) | undefined;
  disabled?: boolean | undefined;
  testID?: string | undefined;
}) {
  const { p } = useApp();
  return (
    <Btn
      label={label}
      disabled={disabled}
      onPress={disabled ? undefined : onPress}
      testID={testID}
      style={{
        minHeight: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
        backgroundColor: disabled ? p.dis : p.ac,
      }}
    >
      <Txt size={16} weight={600} color={disabled ? p.disTx : p.onAccent}>{label}</Txt>
    </Btn>
  );
}

export function SecondaryButton({
  label, onPress, testID,
}: {
  label: string;
  onPress: () => void;
  testID?: string | undefined;
}) {
  const { p } = useApp();
  return (
    <Btn
      label={label}
      onPress={onPress}
      testID={testID}
      style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
    >
      <Txt size={15} color={p.ac}>{label}</Txt>
    </Btn>
  );
}

export function Footer({ children }: { children: React.ReactNode }) {
  return <View style={{ gap: 10, paddingTop: 8 }}>{children}</View>;
}
