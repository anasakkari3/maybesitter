import React from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { Card, Txt } from '../../ui/primitives';
import { SettingsRow } from '../settings/SettingsChrome';
import { ASSISTANTS, IMPORT_ASSISTANTS, type ImportAssistant } from './assistants';

/**
 * Which assistant, if any of them.
 *
 * `other` is listed with the rest rather than tucked under a link: the flow
 * works without us knowing the product — the question goes on the clipboard
 * either way — and hiding it would imply the three named ones are required.
 */
export function AiImportPickStep({ onPick }: { onPick: (assistant: ImportAssistant) => void }) {
  const { t, p } = useApp();

  return (
    <View style={{ gap: 16 }}>
      <View style={{ gap: 6 }}>
        <Txt size={20} weight={600}>{t.aiImportPickTitle}</Txt>
        <Txt size={14} color={p.mu} lh={1.5}>{t.aiImportPickBody}</Txt>
      </View>

      <Card pad={0}>
        {IMPORT_ASSISTANTS.map((assistant, index) => (
          <SettingsRow
            key={assistant}
            first={index === 0}
            label={String(t[ASSISTANTS[assistant].labelKey])}
            onPress={() => onPick(assistant)}
            testID={`ai-import-pick-${assistant}`}
          />
        ))}
      </Card>
    </View>
  );
}
