import React, { useState } from 'react';
import { TextInput, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { Btn, Card, Txt } from '../../ui/primitives';

/**
 * The server's bound on a memory: 200 code points of the trimmed text
 * (`MAX_MEMORY_CONTENT_LENGTH`, lib/services/mobile/memoryService.ts). Counted
 * the same way here, with `Array.from`, so an emoji costs what it costs there.
 */
export const MEMORY_CONTENT_MAX = 200;

export function memoryTooLong(text: string): boolean {
  return Array.from(text.trim()).length > MEMORY_CONTENT_MAX;
}

/**
 * The words of an edit whose row went while it was on its way (CA8.2):
 * another device replaced or deleted the note, so there is nothing left to
 * patch. They stay here, beside anything else being typed, to save as a new
 * memory or let go.
 *
 * No `maxLength` (A3 review): a field that cuts a paste at 200 silently drops
 * its end, the CA3.6 defect. Past the bound the line says so and Save waits.
 */
export function KeptMemoryEdit({ testPrefix, initial, saving, onSave, onCancel, card = false }: {
  testPrefix: 'memory' | 'memory-screen';
  initial: string;
  saving: boolean;
  onSave: (content: string) => void;
  onCancel: () => void;
  /** MemoryScreen sets it on its own card; the Knows card is one already. */
  card?: boolean;
}) {
  const { t, p, rtl } = useApp();
  const [draft, setDraft] = useState(initial);
  const over = memoryTooLong(draft);
  const body = (
    <>
      <Txt size={14} color={p.mu} lh={1.5} testID={`${testPrefix}-kept-note`}>{t.memoryEditKept}</Txt>
      <TextInput
        testID={`${testPrefix}-kept-input`}
        accessibilityLabel={t.memoryEdit}
        value={draft}
        onChangeText={setDraft}
        multiline
        style={{ color: p.tx, fontSize: 15, minHeight: 44, textAlign: rtl ? 'right' : 'left' }}
      />
      {over ? <Txt size={13} color={p.wm} testID={`${testPrefix}-kept-too-long`}>{t.memoryTooLong}</Txt> : null}
      <View style={{ flexDirection: 'row', gap: 14 }}>
        <Action label={t.memorySave} testID={`${testPrefix}-kept-save`} disabled={draft.trim() === '' || over || saving} onPress={() => onSave(draft.trim())} />
        <Action label={t.cancel} testID={`${testPrefix}-kept-cancel`} onPress={onCancel} />
      </View>
    </>
  );
  return card
    ? <Card pad={18} style={{ gap: 10 }} testID={`${testPrefix}-kept`}>{body}</Card>
    : <View style={{ paddingHorizontal: 18, paddingVertical: 12, gap: 10, borderTopWidth: 1, borderTopColor: p.ln }} testID={`${testPrefix}-kept`}>{body}</View>;
}

function Action({ label, onPress, testID, disabled }: { label: string; onPress: () => void; testID: string; disabled?: boolean }) {
  const { p } = useApp();
  return (
    <Btn label={label} testID={testID} {...(disabled ? { disabled: true } : {})} onPress={disabled ? undefined : onPress}
      scaleTo={0.97} hitSlop={8} style={{ minHeight: 44, justifyContent: 'center', paddingVertical: 6, flexShrink: 1 }}>
      <Txt size={14} color={disabled ? p.mu : p.acd}>{label}</Txt>
    </Btn>
  );
}
