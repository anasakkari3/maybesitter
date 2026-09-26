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
import { useOptionalAuth } from '../../auth/AuthProvider';
import { family } from '../../theme/fonts';
import { Card, Pill, Txt } from '../../ui/primitives';
import { Screen, ScreenScroll } from '../../ui/screen';
import { ActionRow } from '../../ui/chrome';
import { SettingsHeader } from '../settings/SettingsChrome';
import type { Place, PlaceKind } from '../../lib/deviceSettings/placeReminders';
import { LOCATION_LABEL_MAX } from './placeReminderEngine';
import { HOME_ID, WORK_ID, newPlaceId, pinPlaceHere, refreshLocationAccess, removePlace, useLocationAccess, usePlaces } from './placesStore';
import { openLocationSettings } from './nativeLocation';
import { resolveFailureText } from './PlaceReminderEditor';

export function PlacesScreen({ onBack }: { onBack: () => void }) {
  const { t, p, ar } = useApp();
  const accountId = useOptionalAuth()?.user?.uid ?? null;
  const { places } = usePlaces(accountId);
  const access = useLocationAccess();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [name, setName] = React.useState('');

  const pin = async (id: string, kind: PlaceKind, label: string) => {
    if (!accountId || busy) return;
    setBusy(id);
    setProblem(null);
    try {
      const result = await pinPlaceHere(accountId, { id, kind, label });
      await refreshLocationAccess();
      if (!result.ok) setProblem(resolveFailureText(result.reason, t));
      else if (kind === 'custom') setName('');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    if (!accountId || busy) return;
    setBusy(id);
    try {
      await removePlace(accountId, id);
    } finally {
      setBusy(null);
    }
  };

  const home = places.find(place => place.id === HOME_ID);
  const work = places.find(place => place.id === WORK_ID);
  const others = places.filter(place => place.id !== HOME_ID && place.id !== WORK_ID);

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
          onPin={() => void pin(HOME_ID, 'home', t.placeHome)} onRemove={() => void remove(HOME_ID)} />
        <NamedPlace testID="places-work" title={t.placeWork} place={work} busy={busy === WORK_ID} disabled={busy !== null}
          onPin={() => void pin(WORK_ID, 'work', t.placeWork)} onRemove={() => void remove(WORK_ID)} />

        <Card style={{ gap: 12 }} testID="places-others">
          <Txt role="card">{t.placeOther}</Txt>
          {others.map(place => (
            <View key={place.id} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, minHeight: 44 }}>
              <Txt size={15} style={{ flexShrink: 1 }}>{place.label}</Txt>
              <Pill testID={`places-remove-${place.id}`} label={t.placeRemove} kind="ghost" size={14} pad={10} disabled={busy !== null} onPress={() => void remove(place.id)} />
            </View>
          ))}
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

        {problem ? <Txt size={13} color={p.wm} testID="places-problem">{problem}</Txt> : null}
      </ScreenScroll>
    </Screen>
  );
}

function NamedPlace({ title, place, busy, disabled, onPin, onRemove, testID }: {
  title: string; place: Place | undefined; busy: boolean; disabled: boolean; onPin: () => void; onRemove: () => void; testID: string;
}) {
  const { t, p } = useApp();
  return (
    <Card style={{ gap: 12 }} testID={testID}>
      <View style={{ gap: 4, alignItems: 'flex-start' }}>
        <Txt role="card">{title}</Txt>
        <Txt size={13} color={p.mu} testID={`${testID}-state`}>{busy ? t.placeLocating : place ? t.placeSet : t.xNotSet}</Txt>
      </View>
      <ActionRow>
        <Pill testID={`${testID}-pin`} label={t.placeSetHere} kind="outline" size={14} pad={12} disabled={disabled} onPress={onPin} />
        {place ? <Pill testID={`${testID}-remove`} label={t.placeRemove} kind="ghost" size={14} pad={12} disabled={disabled} onPress={onRemove} /> : null}
      </ActionRow>
    </Card>
  );
}
