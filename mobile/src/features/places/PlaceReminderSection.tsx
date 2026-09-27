/**
 * The place reminder on a commitment's details screen (closure CL4).
 *
 * Says what is set — "When you arrive: Work" — and what this phone is doing
 * with it, in words rather than left to fail silently: the place was removed
 * here (the reminder is off; pick another), or is saved on another phone; it
 * already rang (once only); location is not "Always" (paused); or it is past
 * the twenty-region cap (waiting for a free slot). Adding, changing
 * and removing go through the commitment's own PATCH, so the account knows
 * the reminder exists and every phone draws it.
 */
import React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
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
import { useWatchState } from './placeReminderStatus';

export function PlaceReminderSection({ commitment, canEdit, onLayout, onFormOpen }: {
  commitment: Commitment;
  canEdit: boolean;
  /** Where the section sits in the screen's scroller. */
  onLayout?: (event: LayoutChangeEvent) => void;
  /**
   * The form just opened. Details scrolls it into view: below its pinned
   * actions it used to open out of sight, and the tap looked like it had done
   * nothing (UAT 2026-09-27, FX1).
   */
  onFormOpen?: () => void;
}) {
  const { t, p, actions } = useApp();
  const accountId = useOptionalAuth()?.user?.uid ?? null;
  const { places, removed, loaded } = usePlaces(accountId);
  const watch = useWatchState(accountId, commitment.id);
  const access = useLocationAccess();
  const patch = usePatchCommitment();
  const trigger = commitment.locationTrigger ?? null;
  const [draft, setDraft] = React.useState<PlaceDraft | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const formOpen = draft !== null;
  // After the render that drew the form, so it is there to scroll to.
  React.useEffect(() => {
    if (formOpen) onFormOpen?.();
  }, [formOpen, onFormOpen]);

  if (!trigger && !canEdit) return null;

  const local = trigger ? places.some(place => place.id === trigger.placeId) : false;
  const gone = !!trigger && loaded && !local && removed.includes(trigger.placeId);
  const paused = local && access !== 'always' && access !== 'checking';

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
    <View style={{ gap: 6 }} testID="details-place" onLayout={onLayout}>
      <SectionLabel>{t.placeReminderTitle}</SectionLabel>
      <Card style={{ gap: 12 }}>
        {trigger && !draft ? (
          <View style={{ gap: 6, alignItems: 'flex-start' }}>
            <Txt size={15} weight={600} testID="details-place-summary">
              {fill(trigger.kind === 'arrive' ? t.placeReminderArriveAt : t.placeReminderLeaveFrom, { place: trigger.label })}
            </Txt>
            {gone ? (
              <Txt size={13} color={p.wm} testID="details-place-gone">{t.placeReminderPlaceGone}</Txt>
            ) : loaded && !local ? (
              <Txt size={13} color={p.mu} testID="details-place-other-phone">{t.placeReminderOtherPhone}</Txt>
            ) : local && watch === 'fired' ? (
              <Txt size={13} color={p.mu} testID="details-place-fired">{t.placeReminderFired}</Txt>
            ) : paused ? (
              <View style={{ gap: 8, alignItems: 'flex-start' }} testID="details-place-paused">
                <Txt size={13} weight={600} color={p.wm}>{t.placeReminderPaused}</Txt>
                <Txt size={13} color={p.mu}>{t.placeReminderPausedHint}</Txt>
                <Pill testID="details-place-settings" label={t.notifOpenSettings} kind="outline" size={14} pad={12} onPress={openLocationSettings} />
              </View>
            ) : local && watch === 'waiting' ? (
              <Txt size={13} color={p.wm} testID="details-place-waiting">{t.placeReminderWaiting}</Txt>
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
              {gone ? (
                <Pill testID="details-place-repick" label={t.placeReminderPickAnother} kind="outline" size={14} pad={12} disabled={busy} onPress={() => setDraft({ kind: trigger.kind, target: null })} />
              ) : (
                <Pill testID="details-place-change" label={t.detailsEdit} kind="outline" size={14} pad={12} disabled={busy} onPress={() => setDraft(draftFrom(local ? trigger : null))} />
              )}
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
