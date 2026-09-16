import React from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { LanguageStep } from './LanguageStep';

/**
 * Asks for a language once, before sign-in (#469).
 *
 * Gated on whether a preference was ever stored, not on its value: `'system'`
 * is a legal choice as well as the default. An install upgraded from a build
 * that already wrote `settings.language` chose already and is let straight
 * through. Held on the plain background until the store has answered, for the
 * same reason `AuthGate` holds — a language screen flashed at someone who
 * chose last year is the defect this state prevents.
 *
 * Nothing is remembered here: `chooseLanguage` flips `langChosen` in
 * `AppContext`, and that is what swaps the step for the children.
 */
export function LanguageGate({ children }: { children: React.ReactNode }) {
  const { p, langChosen } = useApp();

  if (langChosen === null) {
    return <View testID="language-loading" style={{ flex: 1, backgroundColor: p.bg }} />;
  }

  if (!langChosen) return <LanguageStep onContinue={() => undefined} />;

  return <>{children}</>;
}
