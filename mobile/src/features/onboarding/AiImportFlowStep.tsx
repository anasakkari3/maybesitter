import React from 'react';
import { useApp } from '../../state/AppContext';
import { Screen, ScreenScroll } from '../../ui/screen';
import { SettingsHeader } from '../settings/SettingsChrome';
import { AiImportFlow } from '../aiImport/AiImportFlow';
import type { SuggestionCategory } from '../../api/schemas/profile';

/**
 * The import, as onboarding shows it.
 *
 * Plain chrome rather than `OnboardingChrome`: this is a detour off the about
 * step, not a step of its own, and drawing the five-segment progress bar over
 * it would claim otherwise. The flow inside is the same component Settings
 * renders — the point of the feature was one implementation, and the conflict
 * default living in one place is what makes that matter.
 */
export function AiImportFlowStep({
  onDone, onCancel,
}: {
  onDone: (categories: readonly SuggestionCategory[]) => void;
  onCancel: () => void;
}) {
  const { t } = useApp();
  return (
    <Screen pinned={<SettingsHeader title={t.aiImportTitle} onBack={onCancel} />}>
      <ScreenScroll>
        <AiImportFlow onDone={onDone} onCancel={onCancel} />
      </ScreenScroll>
    </Screen>
  );
}
