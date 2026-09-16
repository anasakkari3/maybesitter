import React from 'react';
import { useApp } from '../../state/AppContext';
import { Card, Txt } from '../../ui/primitives';
import { OnboardingChrome } from './OnboardingChrome';

/**
 * "Add goals yourself" — the about step with AI off (UC-2.7b #168, UC-3.17 #469).
 *
 * ── With AI off, nothing is typed at all ─────────────────────────
 *
 * Not "typed and not sent" — the questions are not asked. Reading answers is
 * the whole mechanism, and it needs a model; with the model refused there is
 * nothing this step can do with them, so it offers the thing that does work
 * instead. Anything the user wants remembered goes in by hand through the
 * memory screen, which stores it without a model.
 *
 * The free-text box this file used to hold became the guided setup
 * (`SetupChatStep`) in #469; this is the half that stayed.
 */
export function AboutYouStep({
  onManual,
  onBack,
}: {
  onManual: () => void;
  onBack: () => void;
}) {
  const { t, p } = useApp();

  return (
    <OnboardingChrome
      step="about"
      title={t.obAboutManualTitle}
      testID="onboarding-about-manual"
      primary={{ label: t.obContinue, onPress: onManual }}
      secondary={{ label: t.obBack, onPress: onBack }}
    >
      <Card pad={18}>
        <Txt size={15} color={p.mu} lh={1.5}>{t.obAboutManualBody}</Txt>
      </Card>
    </OnboardingChrome>
  );
}
