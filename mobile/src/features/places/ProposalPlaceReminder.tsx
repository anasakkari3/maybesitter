/**
 * The place reminder on a review card's edit sheet (closure CL4).
 *
 * Nothing is written here: the chosen trigger becomes part of the card's edit
 * and travels with the confirm (`toServerEdits`), so the commitment is saved
 * with its place reminder or not at all — the same rule the title and the time
 * follow (#164). "Where I am now" is pinned when the person presses Use this,
 * which is when "While Using" is asked; "Always" follows, with its line.
 */
import React from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { useOptionalAuth } from '../../auth/AuthProvider';
import type { LocationTrigger } from '../../api/schemas/common';
import { fill } from '../../i18n/strings';
import { Pill, Txt } from '../../ui/primitives';
import { ActionRow } from '../../ui/chrome';
import {
  PlaceReminderEditor,
  afterPlaceReminderSaved,
  draftFrom,
  draftIsComplete,
  resolveFailureText,
  resolvePlaceDraft,
  type PlaceDraft,
} from './PlaceReminderEditor';

export function ProposalPlaceReminder({ value, onChange }: {
  value: LocationTrigger | null | undefined;
  onChange: (next: LocationTrigger | null) => void;
}) {
  const { t, p } = useApp();
  const accountId = useOptionalAuth()?.user?.uid ?? null;
  const [draft, setDraft] = React.useState<PlaceDraft | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);

  const use = async () => {
    if (!accountId || !draft || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const resolved = await resolvePlaceDraft(accountId, draft);
      if (!resolved.ok) {
        setProblem(resolveFailureText(resolved.reason, t));
        return;
      }
      onChange(resolved.trigger);
      setDraft(null);
      await afterPlaceReminderSaved();
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: 10 }} testID="edit-item-place">
      <Txt size={13} color={p.mu}>{t.placeReminderTitle}</Txt>
      {draft ? (
        <>
          <PlaceReminderEditor draft={draft} onDraft={setDraft} disabled={busy} />
          <ActionRow>
            <Pill testID="edit-item-place-cancel" label={t.editItemCancel} kind="soft" size={14} pad={12} onPress={() => { setDraft(null); setProblem(null); }} />
            <Pill testID="edit-item-place-use" label={t.editItemSave} size={14} pad={12} disabled={busy || !draftIsComplete(draft)} onPress={() => void use()} />
          </ActionRow>
        </>
      ) : value ? (
        <View style={{ gap: 8, alignItems: 'flex-start' }}>
          <Txt size={14} weight={600} testID="edit-item-place-summary">
            {fill(value.kind === 'arrive' ? t.placeReminderArriveAt : t.placeReminderLeaveFrom, { place: value.label })}
          </Txt>
          <ActionRow>
            <Pill testID="edit-item-place-change" label={t.detailsEdit} kind="outline" size={14} pad={12} onPress={() => setDraft(draftFrom(value))} />
            <Pill testID="edit-item-place-remove" label={t.placeReminderRemove} kind="ghost" size={14} pad={12} onPress={() => onChange(null)} />
          </ActionRow>
        </View>
      ) : (
        <Pill testID="edit-item-place-add" label={t.placeReminderAdd} kind="outline" size={14} pad={12} style={{ alignSelf: 'flex-start' }} onPress={() => setDraft(draftFrom(null))} />
      )}
      {problem ? <Txt size={13} color={p.wm} testID="edit-item-place-problem">{problem}</Txt> : null}
    </View>
  );
}
