import React from 'react';
import { ScrollView, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { Pill, Txt } from '../../ui/primitives';
import type { ClipboardImport } from './clipboardImport';

/**
 * What was on the clipboard, shown before any of it is used (UC-2.R2 #172,
 * step 3).
 *
 * ── Why a review step at all ─────────────────────────────────────
 *
 * Pasting straight into the field would be one tap shorter and would also be
 * the first time this product put text somebody did not write in front of them
 * and then offered to analyze it. A clipboard often holds something private and
 * unrelated — the last thing copied out of a password manager, a message from
 * someone else. So the read happens, the result is shown, and nothing moves
 * until the person says it should.
 *
 * ── It is not a second way in ────────────────────────────────────
 *
 * This component has one output: `onUse(text)`. The composer wires that to
 * `flow.setText`, which dispatches `textChanged` — the same event a keystroke
 * dispatches. There is no analyze here, no endpoint, no shortcut past review:
 * pasted text reaches the server by exactly the route typed text does, and
 * `captureClipboard.test.tsx` asserts that the machine has no other way to take
 * text at all.
 */
export function ClipboardImportSheet({
  result,
  replacing,
  onUse,
  onCancel,
}: {
  result: ClipboardImport;
  /** True when the field already holds a draft this paste would overwrite. */
  replacing: boolean;
  onUse(text: string): void;
  onCancel(): void;
}) {
  const { t, p, ar } = useApp();

  if (result.kind === 'empty') {
    return (
      <View style={{ flex: 1, justifyContent: 'center', gap: 14 }} testID="capture-clipboard-empty">
        <Txt size={22} weight={600}>{t.captureClipboardEmptyTitle}</Txt>
        {/* Stated, not apologised for. An image or an empty pasteboard is a
            fact about the device, not a failure of this screen. */}
        <Txt size={15} color={p.mu} lh={1.5}>{t.captureClipboardEmptyBody}</Txt>
        <Pill testID="capture-clipboard-close" label={t.close} onPress={onCancel} kind="soft" />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, gap: 14 }} testID="capture-clipboard">
      <Txt size={22} weight={600}>{t.captureClipboardTitle}</Txt>
      <Txt size={14} color={p.mu} lh={1.5}>{t.captureClipboardBody}</Txt>

      {/* Scrollable rather than truncated: the person is being asked to agree
          to this text, and agreeing to an ellipsis is not agreeing. */}
      <ScrollView
        testID="capture-clipboard-preview"
        style={{ maxHeight: 260, backgroundColor: p.sf, borderWidth: 1, borderColor: p.ln, borderRadius: 24 }}
        contentContainerStyle={{ padding: 18 }}
      >
        <Txt size={17} lh={1.5} style={{ writingDirection: ar ? 'rtl' : 'ltr' }}>{result.text}</Txt>
      </ScrollView>

      {replacing ? (
        <Txt size={12} color={p.wm} testID="capture-clipboard-replaces">{t.captureClipboardReplaces}</Txt>
      ) : null}

      <View style={{ gap: 10 }}>
        <Pill testID="capture-clipboard-use" label={t.captureClipboardUse} onPress={() => onUse(result.text)} />
        <Pill testID="capture-clipboard-cancel" label={t.captureClipboardCancel} onPress={onCancel} kind="outline" />
      </View>
    </View>
  );
}
