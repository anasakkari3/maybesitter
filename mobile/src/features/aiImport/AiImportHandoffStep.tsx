import React from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { fill } from '../../i18n/strings';
import { Card, Txt } from '../../ui/primitives';
import { Notice } from '../../ui/chrome';
import { NumberedSteps } from '../../ui/steps';
import { Footer, PrimaryButton, SecondaryButton } from './AiImportButtons';
import { ASSISTANTS, type ImportAssistant } from './assistants';
import { buildAssistantPrompt } from './importPrompt';

/**
 * What happens next, then the one button that does it.
 *
 * ── Explain, then hand off ───────────────────────────────────────
 *
 * Picking an assistant lands here with nothing copied and nothing opened. The
 * three steps are read in this app, and only the button copies the question and
 * opens the assistant — the way back then lands on the paste step. (Copying and
 * opening on the pick itself meant the steps were only seen after returning.)
 *
 * ── The failure case is the interesting one ──────────────────────
 *
 * When the assistant could not be opened the step stays exactly where it is and
 * shows the question in a card the user can read and copy again. A handoff that
 * failed is an inconvenience; a screen that ends the flow over it would throw
 * away the part that actually works, which is the clipboard.
 */
export function AiImportHandoffStep({
  assistant, openFailed, onHandOff, onCopyAgain, onReady,
}: {
  assistant: ImportAssistant;
  openFailed: boolean;
  onHandOff: () => void;
  onCopyAgain: () => void;
  onReady: () => void;
}) {
  const { t, p } = useApp();
  const name = String(t[ASSISTANTS[assistant].labelKey]);
  const opens = ASSISTANTS[assistant].webUrl !== null;

  if (!openFailed) {
    return (
      <View style={{ gap: 16 }}>
        <Txt size={20} weight={600}>{t.aiImportStepsTitle}</Txt>
        <NumberedSteps testID="ai-import-steps" steps={[
          t.aiImportStep1,
          opens ? fill(t.aiImportStep2, { assistant: name }) : t.aiImportStep2Other,
          t.aiImportStep3,
        ]} />
        <Footer>
          <PrimaryButton
            label={opens ? fill(t.aiImportCopyAndOpen, { assistant: name }) : t.aiImportCopyOnly}
            onPress={onHandOff}
            testID="ai-import-go"
          />
        </Footer>
      </View>
    );
  }

  return (
    <View style={{ gap: 16 }}>
      <Txt size={20} weight={600}>{t.aiImportHandoffTitle}</Txt>
      <Notice text={fill(t.aiImportHandoffOpenFailed, { assistant: name })} testID="ai-import-open-failed" />
      <Card pad={16}>
        <Txt size={14} color={p.mu} lh={1.55} testID="ai-import-prompt-text" selectable>{buildAssistantPrompt(t)}</Txt>
      </Card>
      <Footer>
        <PrimaryButton label={t.aiImportHandoffReady} onPress={onReady} testID="ai-import-ready" />
        <SecondaryButton label={t.aiImportHandoffCopyAgain} onPress={onCopyAgain} testID="ai-import-copy" />
      </Footer>
    </View>
  );
}
