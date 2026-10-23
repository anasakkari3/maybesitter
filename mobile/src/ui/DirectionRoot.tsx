import React from 'react';
import { View } from 'react-native';
import { useApp } from '../state/AppContext';

/**
 * Wraps the entire screen hierarchy inside `AppProvider` with the active Yoga
 * layout direction (`rtl` or `ltr`).
 *
 * Pre-root lifecycle gates (`LanguageStep`, `SignInScreen`, `EmailAuthScreen`,
 * `AccountDeletedScreen`, and `OnboardingFlow`) mount above `src/Root.tsx`.
 * Without a direction-aware wrapper here, their flex layouts and text alignment
 * default to LTR even when Arabic or Hebrew is selected.
 *
 * It holds no `RemeasureOnTextScale` on purpose. An app-wide one would replace
 * every paragraph on a text-size change — a screen reader's focus on body
 * text, a selected receipt id, the AI-import prompt being copied. The boundary
 * goes only around the surfaces where the stale measurement was seen, each
 * with stable accessible wrappers (see `RemeasureOnTextScale`).
 */
export function DirectionRoot({ children }: { children: React.ReactNode }) {
  const { rtl, p } = useApp();
  return (
    <View testID="direction-root" style={{ flex: 1, backgroundColor: p.bg, direction: rtl ? 'rtl' : 'ltr' }}>
      {children}
    </View>
  );
}
