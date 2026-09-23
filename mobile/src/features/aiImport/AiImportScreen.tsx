import React from 'react';
import { useApp } from '../../state/AppContext';
import { Screen, ScreenScroll } from '../../ui/screen';
import { SettingsHeader } from '../settings/SettingsChrome';
import { AiImportFlow } from './AiImportFlow';

/**
 * The Settings entry point: chrome and a back button around `AiImportFlow`.
 *
 * Everything the flow does lives in the flow, because onboarding renders the
 * same component without this header. A second implementation would be a second
 * place for the conflict default to drift, and that default is what decides
 * whether anything of the user's is destroyed.
 */
export function AiImportScreen({ onBack }: { onBack: () => void }) {
  const { t } = useApp();
  return (
    <Screen pinned={<SettingsHeader title={t.aiImportTitle} onBack={onBack} />}>
      <ScreenScroll>
        <AiImportFlow onDone={onBack} onCancel={onBack} />
      </ScreenScroll>
    </Screen>
  );
}
