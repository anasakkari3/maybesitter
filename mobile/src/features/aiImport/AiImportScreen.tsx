import React from 'react';
import { useApp } from '../../state/AppContext';
import { Screen, ScreenScroll } from '../../ui/screen';
import { SettingsHeader } from '../settings/SettingsChrome';
import { AiImportFlow } from './AiImportFlow';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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
  const insets = useSafeAreaInsets();
  return (
    <Screen pinned={<SettingsHeader title={t.aiImportTitle} onBack={onBack} />}>
      <ScreenScroll style={{ marginBottom: insets.bottom }}>
        <AiImportFlow onDone={onBack} onCancel={onBack} />
      </ScreenScroll>
    </Screen>
  );
}
