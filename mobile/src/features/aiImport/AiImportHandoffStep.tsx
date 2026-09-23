import React from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { fill } from '../../i18n/strings';
import { Card, Txt } from '../../ui/primitives';
import { Notice } from '../../ui/chrome';
import { Footer, PrimaryButton, SecondaryButton } from './AiImportButtons';
import { ASSISTANTS, type ImportAssistant } from './assistants';
import { buildAssistantPrompt } from './importPrompt';

/**
 * "We copied the question — go ask it."
 *
 * ── The failure case is the interesting one ──────────────────────
 *
 * When the assistant could not be opened the step stays exactly where it is and
 * shows the question in a card the user can read and copy again. A handoff that
 * failed is an inconvenience; a screen that ends the flow over it would throw
 * away the part that actually works, which is the clipboard.
 */
export function AiImportHandoffStep({
  assistant, openFailed, onCopyAgain, onReady,
}: {
  assistant: ImportAssistant;
  openFailed: boolean;
  onCopyAgain: () => void;
  onReady: () => void;
}) {
  const { t, p } = useApp();
  const name = String(t[ASSISTANTS[assistant].labelKey]);

  return (
    <View style={{ gap: 16 }}>
      <View style={{ gap: 6 }}>
        <Txt size={20} weight={600}>{t.aiImportHandoffTitle}</Txt>
        <Txt size={14} color={p.mu} lh={1.5}>
          {fill(openFailed ? t.aiImportHandoffOpenFailed : t.aiImportHandoffBody, { assistant: name })}
        </Txt>
      </View>

      {/* Shown always, not only on failure: somebody who switched apps and lost
          the clipboard to a password manager needs it as much as somebody whose
          browser refused to open. */}
      <Card pad={16}>
        <Txt size={14} color={p.mu} lh={1.55} testID="ai-import-prompt-text">{buildAssistantPrompt(t)}</Txt>
      </Card>

      {openFailed ? <Notice text={fill(t.aiImportHandoffOpenFailed, { assistant: name })} testID="ai-import-open-failed" /> : null}

      <Footer>
        <PrimaryButton label={t.aiImportHandoffReady} onPress={onReady} testID="ai-import-ready" />
        <SecondaryButton label={t.aiImportHandoffCopyAgain} onPress={onCopyAgain} testID="ai-import-copy" />
      </Footer>
    </View>
  );
}
