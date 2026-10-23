import React from 'react';
import { View } from 'react-native';
import { useApp } from '../state/AppContext';
import { RemeasureOnTextScale } from './primitives';

/**
 * Wraps the entire screen hierarchy inside `AppProvider` with the active Yoga
 * layout direction (`rtl` or `ltr`), and with the app's one
 * `RemeasureOnTextScale`.
 *
 * Pre-root lifecycle gates (`LanguageStep`, `SignInScreen`, `EmailAuthScreen`,
 * `AccountDeletedScreen`, and `OnboardingFlow`) mount above `src/Root.tsx`.
 * Without a direction-aware wrapper here, their flex layouts and text alignment
 * default to LTR even when Arabic or Hebrew is selected.
 *
 * The same reach is why the text boundary sits here: every screen, signed in
 * or not, re-measures its text after a live text-size change (simulator
 * 2026-10-23; see `RemeasureOnTextScale` for what is replaced, what is not,
 * and the screen-reader trade-off). The view itself is never keyed, so
 * nothing under it but the text leaves remounts.
 */
export function DirectionRoot({ children }: { children: React.ReactNode }) {
  const { rtl, p } = useApp();
  return (
    <View testID="direction-root" style={{ flex: 1, backgroundColor: p.bg, direction: rtl ? 'rtl' : 'ltr' }}>
      <RemeasureOnTextScale>{children}</RemeasureOnTextScale>
    </View>
  );
}
