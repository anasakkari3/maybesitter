import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { loadLanguagePrefState } from '../../i18n/language';
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
 * ── Why the bit lives here and not in AppContext ─────────────────
 *
 * `AppContext` hydrates the language itself, and on a device that never
 * stored one that hydration is a no-op: `'system'` in, `'system'` out, no
 * re-render. Putting "was it ever chosen" next to it would make every screen
 * in the app re-render once after start-up for a fact only this gate reads.
 * So the gate reads the same key a second time and keeps the answer to
 * itself. Continue writes the key through `actions.setLang`, and the local
 * bit flips in the same tick.
 */
export function LanguageGate({ children }: { children: React.ReactNode }) {
  const { p } = useApp();
  const [chosen, setChosen] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    void loadLanguagePrefState().then(({ chosen: stored }) => { if (live) setChosen(stored); });
    return () => { live = false; };
  }, []);

  if (chosen === null) {
    return <View testID="language-loading" style={{ flex: 1, backgroundColor: p.bg }} />;
  }

  if (!chosen) return <LanguageStep onContinue={() => setChosen(true)} />;

  return <>{children}</>;
}
