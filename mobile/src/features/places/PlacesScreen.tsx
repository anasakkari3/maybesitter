/**
 * Settings → My places (closure CL4).
 *
 * Home, Work and any other place, each set from where the phone is now. This
 * is the first moment the app asks for location ("While Using"): the person
 * just pressed a button that says it will use it. The pins are kept on this
 * phone only — the screen says so — and removing a place stops every reminder
 * that named it.
 */
import React from 'react';
import { TextInput, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { fill } from '../../i18n/strings';
import { isolateAuto } from '../../i18n/bidi';
import { formatDate, formatTime } from '../../i18n/format';
import { useTimeZone } from '../../i18n/timezone';
import { useOptionalAuth } from '../../auth/AuthProvider';
import { family } from '../../theme/fonts';
import { Card, Pill, Txt } from '../../ui/primitives';
import { Screen, ScreenScroll } from '../../ui/screen';
import { ActionRow } from '../../ui/chrome';
import { SettingsHeader } from '../settings/SettingsChrome';
import type { Place, PlaceKind } from '../../lib/deviceSettings/placeReminders';
import { LOCATION_LABEL_MAX } from './placeReminderEngine';
import { HOME_ID, WORK_ID, newPlaceId, openPlaceInMaps, pinPlaceHere, refreshLocationAccess, removePlace, useLocationAccess, usePlaces } from './placesStore';
import { openLocationSettings } from './nativeLocation';
import { resolveFailureText } from './PlaceReminderEditor';
import { LiveRegion } from '../../ui/liveRegion';
import { useAnnounceOnIos } from '../../ui/announce';

export function PlacesScreen({ onBack }: { onBack: () => void }) {
  const { t, p, ar, lang } = useApp();
  const zone = useTimeZone();
  const accountId = useOptionalAuth()?.user?.uid ?? null;
  const { places } = usePlaces(accountId);
  const access = useLocationAccess();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [feedback, setFeedback] = React.useState<{ text: string; problem: boolean; placeId: string } | null>(null);
  const [name, setName] = React.useState('');

  const pin = async (id: string, kind: PlaceKind, label: string) => {
    if (!accountId || busy) return;
    setBusy(id);
    setFeedback(null);
    try {
      const result = await pinPlaceHere(accountId, { id, kind, label });
      await refreshLocationAccess();
      if (!result.ok) setFeedback({ text: resolveFailureText(result.reason, t) ?? t.placeLocateFailed, problem: true, placeId: id });
      else {
        setFeedback({ text: fill(t.placeSavedConfirm, { place: result.place.label }), problem: false, placeId: id });
        if (kind === 'custom') setName('');
      }
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    if (!accountId || busy) return;
    setBusy(id);
    setFeedback(null);
    try {
      await removePlace(accountId, id);
    } finally {
      setBusy(null);
    }
  };

  const home = places.find(place => place.id === HOME_ID);
  const work = places.find(place => place.id === WORK_ID);
  const others = places.filter(place => place.id !== HOME_ID && place.id !== WORK_ID);
  // A save confirmation belongs to that saved record. If another local
  // consumer removes it, the event is no longer visible or announced.
  const visibleFeedback = feedback && (feedback.problem || places.some(place => place.id === feedback.placeId))
    ? feedback
    : null;
  useAnnounceOnIos(visibleFeedback?.text ?? null);

  const savedAt = (place: Place): string => {
    const date = new Date(place.updatedAt);
    if (!Number.isFinite(date.getTime())) return t.placeSavedTimeUnknown;
    const when = `${formatDate(date, 'short', { locale: lang, timeZone: zone })} · ${formatTime(date, { locale: lang, timeZone: zone })}`;
    return fill(t.placeSavedAt, { when: isolateAuto(when) });
  };

  const showOnMap = async (place: Place, openMap: () => Promise<boolean>) => {
    setFeedback(null);
    if (!await openMap()) {
      setFeedback({ text: t.placeMapFailed, problem: true, placeId: place.id });
    }
  };

  const homeMap = home ? openPlaceInMaps(home) : null;
  const workMap = work ? openPlaceInMaps(work) : null;

  return (
    <Screen pinned={<SettingsHeader title={t.placesTitle} onBack={onBack} />}>
      <ScreenScroll bottom={130} testID="places-screen" keyboardShouldPersistTaps="handled">
        <Txt size={14} color={p.mu} lh={1.5}>{t.placesBody}</Txt>

        {access === 'denied' ? (
          <Card style={{ gap: 10, alignItems: 'flex-start' }} testID="places-denied">
            <Txt size={14} color={p.wm}>{t.placeDenied}</Txt>
            <Pill label={t.notifOpenSettings} kind="outline" size={14} pad={12} onPress={openLocationSettings} testID="places-open-settings" />
          </Card>
        ) : access === 'foreground' && places.length > 0 ? (
          <Card style={{ gap: 10, alignItems: 'flex-start' }} testID="places-foreground-only">
            <Txt size={14} color={p.mu}>{t.placeReminderAlwaysWhy}</Txt>
            <Pill label={t.notifOpenSettings} kind="outline" size={14} pad={12} onPress={openLocationSettings} testID="places-open-settings" />
          </Card>
        ) : null}

        <NamedPlace testID="places-home" title={t.placeHome} place={home} busy={busy === HOME_ID} disabled={busy !== null}
          savedAt={home ? savedAt(home) : null} onMap={home && homeMap ? () => showOnMap(home, homeMap) : undefined}
          onPin={() => void pin(HOME_ID, 'home', t.placeHome)} onRemove={() => void remove(HOME_ID)} />
        <NamedPlace testID="places-work" title={t.placeWork} place={work} busy={busy === WORK_ID} disabled={busy !== null}
          savedAt={work ? savedAt(work) : null} onMap={work && workMap ? () => showOnMap(work, workMap) : undefined}
          onPin={() => void pin(WORK_ID, 'work', t.placeWork)} onRemove={() => void remove(WORK_ID)} />

        <Card style={{ gap: 12 }} testID="places-others">
          <Txt role="card">{t.placeOther}</Txt>
          {others.map(place => {
            const openMap = openPlaceInMaps(place);
            return <View key={place.id} style={{ gap: 8, minHeight: 44 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <View style={{ flexShrink: 1, gap: 3 }}>
                  <Txt size={15}>{place.label}</Txt>
                  <Txt size={13} color={p.mu}>{savedAt(place)}</Txt>
                </View>
                <Pill testID={`places-remove-${place.id}`} label={t.placeRemove} accessibilityLabel={fill(t.placeRemoveNamed, { place: place.label })} kind="ghost" size={14} pad={10} disabled={busy !== null} onPress={() => void remove(place.id)} />
              </View>
              <Pill testID={`places-map-${place.id}`} label={t.placeViewMap} kind="outline" size={14} pad={10} disabled={busy !== null} onPress={() => void showOnMap(place, openMap)} />
            </View>
          })}
          <TextInput
            testID="places-new-name"
            accessibilityLabel={t.placeNamePlaceholder}
            placeholder={t.placeNamePlaceholder}
            placeholderTextColor={p.mu}
            value={name}
            maxLength={LOCATION_LABEL_MAX}
            onChangeText={setName}
            style={{ backgroundColor: p.sf2, borderRadius: 18, paddingVertical: 12, paddingHorizontal: 16, fontSize: 15, minHeight: 48, color: p.tx, fontFamily: family(400, ar), textAlign: ar ? 'right' : 'left' }}
          />
          <Pill testID="places-add-here" label={busy && busy !== HOME_ID && busy !== WORK_ID ? t.placeLocating : t.placeAddHere} size={15} pad={12}
            disabled={busy !== null || name.trim().length === 0} onPress={() => void pin(newPlaceId(), 'custom', name)} />
        </Card>

        <LiveRegion testID="places-feedback-live">
          {visibleFeedback ? (
            <Txt size={13} color={visibleFeedback.problem ? p.wm : p.success} testID={visibleFeedback.problem ? 'places-problem' : 'places-saved'}>
              {visibleFeedback.text}
            </Txt>
          ) : null}
        </LiveRegion>
      </ScreenScroll>
    </Screen>
  );
}

function NamedPlace({ title, place, savedAt, busy, disabled, onPin, onRemove, onMap, testID }: {
  title: string; place: Place | undefined; savedAt: string | null; busy: boolean; disabled: boolean; onPin: () => void; onRemove: () => void; onMap?: (() => void | Promise<void>) | undefined; testID: string;
}) {
  const { t, p } = useApp();
  return (
    <Card style={{ gap: 12 }} testID={testID}>
      <View style={{ gap: 4, alignItems: 'flex-start' }}>
        <Txt role="card">{title}</Txt>
        <Txt size={13} color={p.mu} testID={`${testID}-state`}>{busy ? t.placeLocating : place ? t.placeSet : t.xNotSet}</Txt>
        {place && savedAt ? <Txt size={13} color={p.mu} testID={`${testID}-saved-at`}>{savedAt}</Txt> : null}
      </View>
      <ActionRow>
        <Pill testID={`${testID}-pin`} label={t.placeSetHere} kind="outline" size={14} pad={12} disabled={disabled} onPress={onPin} />
        {place && onMap ? <Pill testID={`${testID}-map`} label={t.placeViewMap} kind="outline" size={14} pad={12} disabled={disabled} onPress={onMap} /> : null}
        {place ? <Pill testID={`${testID}-remove`} label={t.placeRemove} accessibilityLabel={fill(t.placeRemoveNamed, { place: title })} kind="ghost" size={14} pad={12} disabled={disabled} onPress={onRemove} /> : null}
      </ActionRow>
    </Card>
  );
}
