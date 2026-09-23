import React from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { fill } from '../../i18n/strings';
import { Card, Txt } from '../../ui/primitives';
import { Notice } from '../../ui/chrome';
import { MAX_IMPORT_LENGTH } from './importLimits';
import { Footer, PrimaryButton, SecondaryButton } from './AiImportButtons';

/**
 * Taking the answer back off the clipboard.
 *
 * ── The rules this screen keeps, which the capture composer keeps too ──
 *
 * One read, per explicit press. Nothing on mount, nothing on focus, nothing on
 * the app returning to the foreground — on iOS 14+ a silent read raises the
 * system's "pasted from …" banner, so an automatic one is a privacy defect and
 * a visible one. Nothing here logs, nothing here persists, and nothing here
 * reaches the network: the press hands a string to the reducer and that is all.
 * `clipboardImport.ts` states the same rules at length, and
 * `aiImportPasteStep.test.tsx` reads this file to prove they still hold.
 *
 * The preview is read-only on purpose. It is a machine-written profile the user
 * is about to have read on their behalf, and an editable field would invite
 * them to fix a sentence that is about to be thrown away anyway — only the
 * candidates are editable, and that is where an edit means something.
 */
export function AiImportPasteStep({
  text, pasteEmpty, readFailed, reading, onPaste, onRead, onBack,
}: {
  text: string;
  pasteEmpty: boolean;
  readFailed: boolean;
  reading: boolean;
  onPaste: () => void;
  onRead: () => void;
  onBack: () => void;
}) {
  const { t, p } = useApp();
  const truncated = text.length >= MAX_IMPORT_LENGTH;

  return (
    <View style={{ gap: 16 }}>
      <View style={{ gap: 6 }}>
        <Txt size={20} weight={600}>{t.aiImportPasteTitle}</Txt>
        <Txt size={14} color={p.mu} lh={1.5}>{t.aiImportPasteBody}</Txt>
      </View>

      {text !== '' ? (
        <Card pad={16}>
          <Txt size={14} color={p.mu} lh={1.55} testID="ai-import-paste-preview">{text}</Txt>
        </Card>
      ) : null}

      {truncated ? (
        <Notice
          text={fill(t.aiImportPasteTooLong, { n: String(MAX_IMPORT_LENGTH) })}
          testID="ai-import-paste-truncated"
        />
      ) : null}
      {pasteEmpty ? <Notice text={t.aiImportPasteEmpty} testID="ai-import-paste-empty" /> : null}
      {readFailed ? <Notice text={t.aiImportFailed} testID="ai-import-read-failed" /> : null}

      <Footer>
        <SecondaryButton label={t.aiImportPasteButton} onPress={onPaste} testID="ai-import-paste" />
        <PrimaryButton
          label={reading ? t.aiImportReading : t.aiImportRead}
          disabled={text.trim() === '' || reading}
          onPress={onRead}
          testID="ai-import-read"
        />
        <SecondaryButton label={t.back} onPress={onBack} testID="ai-import-paste-back" />
      </Footer>
    </View>
  );
}
