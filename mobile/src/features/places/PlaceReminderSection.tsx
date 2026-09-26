/**
 * The place reminder on a commitment's details screen (closure CL4).
 *
 * Says what is set — "When you arrive: Work" — and whether this phone can keep
 * it: the place may be saved on another phone, or location may be off, and
 * both are said in words rather than left to fail silently. Adding, changing
 * and removing go through the commitment's own PATCH, so the account knows
 * the reminder exists and every phone draws it.
 */
import React from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { useOptionalAuth } from '../../auth/AuthProvider';
import { usePatchCommitment } from '../../api/queries';
import { userFacingMessage } from '../../api/ui/userFacingMessage';
import type { Commitment } from '../../api/schemas/common';
import { fill } from '../../i18n/strings';
import { Card, Pill, Txt } from '../../ui/primitives';
import { ActionRow, SectionLabel } from '../../ui/chrome';
import {
  PlaceReminderEditor,
  afterPlaceReminderSaved,
  draftFrom,
  draftIsComplete,
  resolveFailureText,
  resolvePlaceDraft,
  type PlaceDraft,
} from './PlaceReminderEditor';
import { useLocationAccess, usePlaces } from './placesStore';
import { openLocationSettings } from './nativeLocation';

export function PlaceReminderSection({ commitment, canEdit }: { commitment: Commitment; canEdit: boolean }) {
  const { t, p, actions } = useApp();
  const accountId = useOptionalAuth()?.user?.uid ?? null;
  const { places, loaded } = usePlaces(accountId);
  const access = useLocationAccess();
  const patch = usePatchCommitment();
  const trigger = commitment.locationTrigger ?? null;
  const [draft, setDraft] = React.useState<PlaceDraft | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  if (!trigger && !canEdit) return null;

  const local = trigger ? places.some(place => place.id === trigger.placeId) : false;

  const save = async () => {
    if (!accountId || !draft || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const resolved = await resolvePlaceDraft(accountId, draft);
      if (!resolved.ok) {
        setProblem(resolveFailureText(resolved.reason, t));
        return;
      }
      await patch.mutateAsync({ id: commitment.id, patch: { locationTrigger: resolved.trigger } });
      setDraft(null);
      actions.toast(t.placeReminderSaved);
      await afterPlaceReminderSaved();
    } catch (error) {
      setProblem(userFacingMessage(error, t));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await patch.mutateAsync({ id: commitment.id, patch: { locationTrigger: null } });
      setDraft(null);
      actions.toast(t.placeReminderRemoved);
    } catch (error) {
      setProblem(userFacingMessage(error, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: 6 }} testID="details-place">
      <SectionLabel>{t.placeReminderTitle}</SectionLabel>
      <Card style={{ gap: 12 }}>
        {trigger && !draft ? (
          <View style={{ gap: 6, alignItems: 'flex-start' }}>
            <Txt size={15} weight={600} testID="details-place-summary">
              {fill(trigger.kind === 'arrive' ? t.placeReminderArriveAt : t.placeReminderLeaveFrom, { place: trigger.label })}
            </Txt>
            {loaded && !local ? (
              <Txt size={13} color={p.mu} testID="details-place-other-phone">{t.placeReminderOtherPhone}</Txt>
            ) : local && access !== 'always' && access !== 'checking' ? (
              <View style={{ gap: 8, alignItems: 'flex-start' }} testID="details-place-paused">
                <Txt size={13} weight={600} color={p.wm}>{t.placeReminderPaused}</Txt>
                <Txt size={13} color={p.mu}>{t.placeReminderPausedHint}</Txt>
                <Pill testID="details-place-settings" label={t.notifOpenSettings} kind="outline" size={14} pad={12} onPress={openLocationSettings} />
              </View>
            ) : null}
          </View>
        ) : null}

        {draft ? (
          <>
            <PlaceReminderEditor draft={draft} onDraft={setDraft} disabled={busy} />
            <ActionRow>
              <Pill testID="details-place-cancel" label={t.editItemCancel} kind="soft" size={15} weight={500} pad={12} onPress={() => { setDraft(null); setProblem(null); }} />
              <Pill testID="details-place-save" label={t.placeReminderSave} size={15} pad={12} disabled={busy || !draftIsComplete(draft)} onPress={() => void save()} />
            </ActionRow>
          </>
        ) : canEdit ? (
          trigger ? (
            <ActionRow>
              <Pill testID="details-place-change" label={t.detailsEdit} kind="outline" size={14} pad={12} disabled={busy} onPress={() => setDraft(draftFrom(local ? trigger : null))} />
              <Pill testID="details-place-remove" label={t.placeReminderRemove} kind="ghost" size={14} pad={12} disabled={busy} onPress={() => void remove()} />
            </ActionRow>
          ) : (
            <Pill testID="details-place-add" label={t.placeReminderAdd} kind="outline" size={15} pad={12} onPress={() => setDraft(draftFrom(null))} />
          )
        ) : null}

        {problem ? <Txt size={13} color={p.wm} testID="details-place-problem">{problem}</Txt> : null}
      </Card>
    </View>
  );
}
