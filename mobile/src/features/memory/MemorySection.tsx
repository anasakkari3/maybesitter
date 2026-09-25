import React, { useState } from 'react';
import { TextInput, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { isolate } from '../../i18n/bidi';
import { Btn, Card, Txt } from '../../ui/primitives';
import {
  useCreateMemory,
  useDeleteAllMemory,
  useDeleteMemory,
  useMemory,
  usePatchMemory,
} from '../../api/queries';
import type { MemoryItem } from '../../api/schemas/profile';
import { CHIP_STRING, memorySentence, provenanceChip } from './memoryDisplay';

/**
 * Everything MaybeSitter remembers, and the controls to change it
 * (UC-2.7a #167 step 6, on UC-2.R4 #174's screen).
 *
 * ── It disappears when the feature is off ────────────────────────
 *
 * `GET /api/mobile/memory` answers 404 when `MAYBESITTER_FEATURE_MEMORY` is
 * off, and the section renders nothing at all. Not an error, not an empty
 * state: a build without the feature has no memory, and saying "nothing yet"
 * would imply there is a store that happens to be empty.
 *
 * ── Delete is a real delete, and says so ─────────────────────────
 *
 * Both destructive actions confirm inline before they run, and the copy says
 * it cannot be undone — because it cannot: the server removes the record and
 * its whole supersession history. Editing is not destructive (it supersedes),
 * so it does not confirm.
 *
 * ── Bidi isolation is not cosmetic ───────────────────────────────
 *
 * A fact's content is the user's own words, in whatever script they used, next
 * to times in Latin digits. Without an isolate the neutral characters at the
 * boundary reorder and a quiet-hours range renders backwards. `isolate` is
 * UC-1.R3 (#156)'s helper and every rendered fact goes through it.
 *
 * ── It is the short version of `MemoryScreen` ────────────────────
 *
 * `onOpen` adds the way through to the full screen (UC-3.16, #202), which
 * groups the same records by who asserted them and can answer "why?" for each.
 * Optional: this card is still the whole feature on its own, and a caller with
 * nowhere to send the user simply gets no link rather than a dead one.
 */
export function MemorySection({ onOpen }: { onOpen?: (() => void) | undefined } = {}) {
  const { t, p, rtl } = useApp();
  const memory = useMemory();
  const create = useCreateMemory();
  const patch = usePatchMemory();
  const remove = useDeleteMemory();
  const removeAll = useDeleteAllMemory();

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);

  // 404: the feature is off for this build. Nothing to show, and nothing to
  // apologise for.
  if (memory.isError || memory.data === undefined) return null;

  const items = memory.data.items;
  const strings = t as unknown as Record<string, string>;

  return (
    <Card pad={0} style={{ overflow: 'hidden' }} testID="memory-section">
      <View style={{ paddingHorizontal: 18, paddingTop: 16, paddingBottom: 8 }}>
        <Txt size={13} weight={600} color={p.mu}>{t.memoryTitle}</Txt>
      </View>

      {items.length === 0 && !adding ? (
        <View style={{ paddingHorizontal: 18, paddingBottom: 14 }}>
          <Txt size={14} color={p.mu} testID="memory-empty">{t.memoryEmpty}</Txt>
        </View>
      ) : null}

      {items.map(item => (
        <MemoryRow
          key={item.id}
          item={item}
          strings={strings}
          editing={editing === item.id}
          confirming={confirming === item.id}
          onEdit={() => { setEditing(item.id); setDraft(item.content); }}
          onCancelEdit={() => setEditing(null)}
          onSave={next => {
            setEditing(null);
            patch.mutate({ id: item.id, content: next });
          }}
          onAskDelete={() => setConfirming(item.id)}
          onCancelDelete={() => setConfirming(null)}
          onDelete={() => { setConfirming(null); remove.mutate(item.id); }}
        />
      ))}

      {adding ? (
        <View style={{ paddingHorizontal: 18, paddingVertical: 12, gap: 10, borderTopWidth: 1, borderTopColor: p.ln }}>
          <TextInput
            testID="memory-add-input"
            accessibilityLabel={t.memoryAdd}
            value={draft}
            onChangeText={setDraft}
            placeholder={t.memoryAddPlaceholder}
            placeholderTextColor={p.mu}
            maxLength={200}
            multiline
            style={{ color: p.tx, fontSize: 15, minHeight: 44, textAlign: rtl ? 'right' : 'left' }}
          />
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <SmallAction
              label={t.memorySave}
              testID="memory-add-save"
              disabled={draft.trim() === ''}
              onPress={() => {
                create.mutate({ kind: 'fact', content: draft.trim(), language: 'mixed' });
                setDraft('');
                setAdding(false);
              }}
            />
            <SmallAction label={t.cancel} onPress={() => { setDraft(''); setAdding(false); }} />
          </View>
        </View>
      ) : (
        <Btn
          label={t.memoryAdd}
          testID="memory-add"
          scaleTo={0.98}
          onPress={() => setAdding(true)}
          style={{ paddingVertical: 14, paddingHorizontal: 18, borderTopWidth: 1, borderTopColor: p.ln, alignItems: 'flex-start' }}
        >
          <Txt size={14} color={p.ac}>{t.memoryAdd}</Txt>
        </Btn>
      )}

      {onOpen ? (
        <Btn
          label={t.memoryOpen}
          testID="memory-open"
          scaleTo={0.98}
          onPress={onOpen}
          style={{ paddingVertical: 14, paddingHorizontal: 18, borderTopWidth: 1, borderTopColor: p.ln, alignItems: 'flex-start' }}
        >
          <Txt size={14} color={p.ac}>{t.memoryOpen}</Txt>
        </Btn>
      ) : null}

      {items.length > 0 ? (
        <View style={{ paddingHorizontal: 18, paddingVertical: 12, borderTopWidth: 1, borderTopColor: p.ln, gap: 8 }}>
          {confirmAll ? (
            <>
              <Txt size={13} color={p.wm}>{t.memoryDeleteAllConfirm}</Txt>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <SmallAction
                  label={t.memoryDeleteAll}
                  testID="memory-delete-all-confirm"
                  tone="warn"
                  onPress={() => { setConfirmAll(false); removeAll.mutate(); }}
                />
                <SmallAction label={t.cancel} onPress={() => setConfirmAll(false)} />
              </View>
            </>
          ) : (
            <Btn
              label={t.memoryDeleteAll}
              testID="memory-delete-all"
              scaleTo={0.98}
              onPress={() => setConfirmAll(true)}
              hitSlop={8}
              style={{ alignItems: 'flex-start', minHeight: 44, justifyContent: 'center' }}
            >
              <Txt size={14} color={p.wm}>{t.memoryDeleteAll}</Txt>
            </Btn>
          )}
        </View>
      ) : null}
    </Card>
  );
}

function MemoryRow({
  item, strings, editing, confirming,
  onEdit, onCancelEdit, onSave, onAskDelete, onCancelDelete, onDelete,
}: {
  item: MemoryItem;
  strings: Record<string, string>;
  editing: boolean;
  confirming: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (next: string) => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}) {
  const { t, p, rtl } = useApp();
  const [draft, setDraft] = useState(item.content);
  const chip = provenanceChip(item.provenance, item.source);

  return (
    <View style={{ paddingHorizontal: 18, paddingVertical: 14, gap: 8, borderTopWidth: 1, borderTopColor: p.ln }}>
      {editing ? (
        <>
          <TextInput
            testID={`memory-edit-input-${item.id}`}
            accessibilityLabel={t.memoryEdit}
            value={draft}
            onChangeText={setDraft}
            maxLength={200}
            multiline
            style={{ color: p.tx, fontSize: 15, minHeight: 44, textAlign: rtl ? 'right' : 'left' }}
          />
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <SmallAction
              label={t.memorySave}
              testID={`memory-save-${item.id}`}
              disabled={draft.trim() === ''}
              onPress={() => onSave(draft.trim())}
            />
            <SmallAction label={t.cancel} onPress={onCancelEdit} />
          </View>
        </>
      ) : (
        <>
          <Txt size={15} lh={1.5} testID={`memory-item-${item.id}`}>
            {isolate(memorySentence({ content: item.content, strings }))}
          </Txt>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            {chip ? (
              <View style={{ backgroundColor: p.sf2, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}>
                <Txt size={12} color={p.mu} testID={`memory-chip-${item.id}`}>{strings[CHIP_STRING[chip]]}</Txt>
              </View>
            ) : null}
            <View style={{ flex: 1 }} />
            {confirming ? null : (
              <>
                <SmallAction label={t.memoryEdit} testID={`memory-edit-${item.id}`} onPress={onEdit} />
                <SmallAction label={t.memoryDelete} testID={`memory-delete-${item.id}`} tone="warn" onPress={onAskDelete} />
              </>
            )}
          </View>
          {confirming ? (
            <>
              <Txt size={13} color={p.wm}>{t.memoryDeleteConfirm}</Txt>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <SmallAction label={t.memoryDelete} testID={`memory-delete-confirm-${item.id}`} tone="warn" onPress={onDelete} />
                <SmallAction label={t.cancel} onPress={onCancelDelete} />
              </View>
            </>
          ) : null}
        </>
      )}
    </View>
  );
}

function SmallAction({
  label, onPress, tone, testID, disabled,
}: { label: string; onPress: () => void; tone?: 'warn'; testID?: string; disabled?: boolean }) {
  const { p } = useApp();
  return (
    <Btn
      label={label}
      testID={testID}
      disabled={disabled}
      onPress={disabled ? undefined : onPress}
      scaleTo={0.97}
      hitSlop={8}
      style={{ minHeight: 32, justifyContent: 'center' }}
    >
      <Txt size={14} color={disabled ? p.mu : tone === 'warn' ? p.wm : p.ac}>{label}</Txt>
    </Btn>
  );
}
