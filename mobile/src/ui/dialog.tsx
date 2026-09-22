import React from 'react';
import { Animated, Pressable, ScrollView, View } from 'react-native';
import { useApp } from '../state/AppContext';
import { Pill, Txt } from './primitives';
import { useSheetMotion } from './motion';
import { ActionRow } from './chrome';

/**
 * A confirmation, centred (Round 2).
 *
 * The one shape for "are you sure": a title that is the question, one
 * sentence that says what happens, and two answers side by side. The
 * destructive answer is drawn in ink for a deletion and in the warm colour
 * for a drop — never red, because this product has no failure state to
 * paint — and the cancel is always the outlined one at the start.
 *
 * Used for everything that is hard to take back: drop, delete, sign out,
 * delete the account, disconnect a calendar, stop taking part. Low-risk,
 * reversible actions do not come here; they execute and offer undo.
 */
export function Dialog({ title, body, confirmLabel, cancelLabel, onConfirm, onCancel, tone = 'ink', busy, confirmTestID, cancelTestID, testID }: {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  tone?: 'ink' | 'warm' | 'accent';
  busy?: boolean | undefined;
  confirmTestID?: string | undefined;
  cancelTestID?: string | undefined;
  testID?: string | undefined;
}) {
  const { p } = useApp();
  const m = useSheetMotion();
  return (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 40, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <Animated.View style={[{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: p.scrim }, m.scrim]}>
        <Pressable style={{ flex: 1 }} onPress={onCancel} accessibilityLabel={cancelLabel} />
      </Animated.View>
      <Animated.View
        accessibilityViewIsModal
        testID={testID}
        style={[
          { width: '100%', maxHeight: '85%', backgroundColor: p.sf, borderRadius: 28, shadowColor: p.ink, shadowOpacity: 0.18, shadowRadius: 30, shadowOffset: { width: 0, height: 20 }, elevation: 16 },
          m.panel,
        ]}
      >
        <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
          <Txt role="section">{title}</Txt>
          <Txt role="supporting" color={p.mu}>{body}</Txt>
          <ActionRow>
            <Pill testID={cancelTestID} label={cancelLabel} onPress={onCancel} kind="outline" size={15} pad={12} />
            <Pill testID={confirmTestID} label={confirmLabel} onPress={onConfirm} disabled={busy} kind={tone === 'accent' ? 'accent' : tone === 'warm' ? 'warmSolid' : 'ink'} size={15} pad={12} />
          </ActionRow>
        </ScrollView>
      </Animated.View>
    </View>
  );
}
