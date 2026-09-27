/**
 * "Remind me when I arrive / leave" — the one editor, used on the commitment
 * and on the review card's edit sheet (closure CL4).
 *
 * Controlled: it edits a draft and never writes. The host saves — a PATCH on
 * the commitment, or the confirm that carries a review card's edits — through
 * `resolvePlaceDraft`, which is where a "where I am now" choice becomes a
 * saved place and asks for "While Using". "Always" is asked by
 * `afterPlaceReminderSaved`, after the first save, with the line drawn here
 * saying why.
 */
import React from 'react';
import { TextInput, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { useOptionalAuth } from '../../auth/AuthProvider';
import { family } from '../../theme/fonts';
import { Btn, Pill, Txt } from '../../ui/primitives';
import type { LocationTrigger } from '../../api/schemas/common';
import { requestNotificationPermission } from '../../notifications/permission';
import { LOCATION_LABEL_MAX, placeReminderBody } from './placeReminderEngine';
import { newPlaceId, pinPlaceHere, placesSnapshot, refreshLocationAccess, useLocationAccess, usePlaces } from './placesStore';
import { openLocationSettings, requestAlwaysAccess } from './nativeLocation';

export type PlaceTarget = { readonly type: 'place'; readonly placeId: string } | { readonly type: 'here'; readonly name: string };
export interface PlaceDraft { readonly kind: 'arrive' | 'leave'; readonly target: PlaceTarget | null }

export function draftFrom(trigger: LocationTrigger | null | undefined): PlaceDraft {
  return trigger ? { kind: trigger.kind, target: { type: 'place', placeId: trigger.placeId } } : { kind: 'arrive', target: null };
}

export function draftIsComplete(draft: PlaceDraft): boolean {
  if (!draft.target) return false;
  return draft.target.type === 'place' || draft.target.name.trim().length > 0;
}

export type ResolveResult =
  | { readonly ok: true; readonly trigger: LocationTrigger }
  | { readonly ok: false; readonly reason: 'denied' | 'unavailable' | 'position' | 'incomplete' };

/** The trigger to send, saving the "where I am now" place first when that is the choice. */
export async function resolvePlaceDraft(accountId: string, draft: PlaceDraft): Promise<ResolveResult> {
  const target = draft.target;
  if (!target) return { ok: false, reason: 'incomplete' };
  if (target.type === 'place') {
    const place = placesSnapshot(accountId).places.find(candidate => candidate.id === target.placeId);
    return place ? { ok: true, trigger: placeReminderBody(draft.kind, place) } : { ok: false, reason: 'incomplete' };
  }
  const name = target.name.trim();
  if (!name) return { ok: false, reason: 'incomplete' };
  const pinned = await pinPlaceHere(accountId, { id: newPlaceId(), kind: 'custom', label: name });
  return pinned.ok ? { ok: true, trigger: placeReminderBody(draft.kind, pinned.place) } : pinned;
}

/**
 * After a place reminder is saved: "Always" (the region has to fire with the
 * app closed) and notifications (it has to be seen). Each OS prompt appears
 * at most once; after an answer these return it without asking.
 */
export async function afterPlaceReminderSaved(): Promise<void> {
  await requestAlwaysAccess();
  await refreshLocationAccess();
  await requestNotificationPermission();
}

export function resolveFailureText(reason: Exclude<ResolveResult, { ok: true }>['reason'], t: {
  placeDenied: string; placeUnavailable: string; placeLocateFailed: string;
}): string | null {
  if (reason === 'denied') return t.placeDenied;
  if (reason === 'unavailable') return t.placeUnavailable;
  if (reason === 'position') return t.placeLocateFailed;
  return null;
}

/** One answer out of a small set, drawn as a chip the way the priority track draws its three. */
function Choice({ label, selected, onPress, disabled, testID }: {
  label: string; selected: boolean; onPress: () => void; disabled?: boolean | undefined; testID: string;
}) {
  const { p } = useApp();
  return (
    <Btn
      testID={testID}
      label={label}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, disabled: !!disabled }}
      onPress={onPress}
      disabled={disabled}
      scaleTo={0.97}
      style={{
        minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
        borderWidth: 1, borderColor: selected ? p.ink : p.ln, backgroundColor: selected ? p.ink : p.sf,
      }}
    >
      <Txt size={14} weight={selected ? 600 : 400} color={selected ? p.onInk : p.tx}>{label}</Txt>
    </Btn>
  );
}

export function PlaceReminderEditor({ draft, onDraft, disabled }: {
  draft: PlaceDraft;
  onDraft: (next: PlaceDraft) => void;
  disabled?: boolean;
}) {
  const { t, p, ar } = useApp();
  const accountId = useOptionalAuth()?.user?.uid ?? null;
  const { places } = usePlaces(accountId);
  const access = useLocationAccess();
  const here = draft.target?.type === 'here' ? draft.target : null;

  return (
    <View style={{ gap: 12 }} testID="place-editor">
      <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Choice testID="place-kind-arrive" label={t.placeReminderArrive} selected={draft.kind === 'arrive'} disabled={disabled} onPress={() => onDraft({ ...draft, kind: 'arrive' })} />
        <Choice testID="place-kind-leave" label={t.placeReminderLeave} selected={draft.kind === 'leave'} disabled={disabled} onPress={() => onDraft({ ...draft, kind: 'leave' })} />
      </View>

      <Txt size={13} color={p.mu}>{t.placeReminderWhere}</Txt>
      <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {places.map(place => (
          <Choice
            key={place.id}
            testID={`place-pick-${place.id}`}
            label={place.label}
            selected={draft.target?.type === 'place' && draft.target.placeId === place.id}
            disabled={disabled}
            onPress={() => onDraft({ ...draft, target: { type: 'place', placeId: place.id } })}
          />
        ))}
        <Choice
          testID="place-pick-here"
          label={t.placeReminderHere}
          selected={here !== null}
          disabled={disabled}
          onPress={() => onDraft({ ...draft, target: { type: 'here', name: here?.name ?? '' } })}
        />
      </View>

      {here ? (
        <TextInput
          testID="place-here-name"
          accessibilityLabel={t.placeNamePlaceholder}
          placeholder={t.placeNamePlaceholder}
          placeholderTextColor={p.mu}
          value={here.name}
          maxLength={LOCATION_LABEL_MAX}
          editable={!disabled}
          onChangeText={name => onDraft({ ...draft, target: { type: 'here', name } })}
          style={{ backgroundColor: p.sf2, borderRadius: 18, paddingVertical: 12, paddingHorizontal: 16, fontSize: 15, minHeight: 48, color: p.tx, fontFamily: family(400, ar), textAlign: ar ? 'right' : 'left' }}
        />
      ) : null}

      {access === 'denied' ? (
        <View style={{ gap: 8, alignItems: 'flex-start' }}>
          <Txt size={13} color={p.wm} testID="place-denied">{t.placeDenied}</Txt>
          <Pill testID="place-open-settings" label={t.notifOpenSettings} kind="outline" size={14} pad={12} onPress={openLocationSettings} />
        </View>
      ) : access === 'foreground' || access === 'undetermined' ? (
        <Txt size={13} color={p.mu} testID="place-always-why">{t.placeReminderAlwaysWhy}</Txt>
      ) : null}
    </View>
  );
}
