import React, { useState } from 'react';
import { View } from 'react-native';
import Constants from 'expo-constants';
import { useApp } from '../state/AppContext';
import { useOptionalAuth } from '../auth/AuthProvider';
import { Btn, Txt } from '../ui/primitives';
import { avatarInitial } from '../ui/chrome';
import { Dialog } from '../ui/dialog';
import { Screen, ScreenScroll } from '../ui/screen';
import { SettingsHeader, SettingsHubRow, type SettingsGlyphName } from '../features/settings/SettingsChrome';
import { useNotificationPermission } from '../notifications/useNotificationPermission';
import { ReferenceIcon } from '../ui/referenceIcons';
import { ChevronIcon } from '../ui/icons';
import { scriptOfText } from '../theme/fonts';

/**
 * The Settings hub (Stitch `06-settings`): who is signed in, five clear
 * destinations, and the two account actions at the bottom. The detailed
 * controls live one level down, and every leaf is still where it was.
 *
 * Since the Stitch redesign (2026-10-02) Settings is opened from the avatar in
 * a tab root's header, not from the bar. It is pushed onto that tab, so it
 * renders without the bar and the «احكيها» pill, and its back — this header's
 * and Android's — returns to the tab it was opened from.
 *
 * Each destination says what is inside it in the words of the rows it holds,
 * so nothing has to be opened to be found. Signing out asks first, through the
 * same dialog the account page uses; deleting leads to its own flow, which
 * asks again in its own words.
 */
export function SettingsScreen() {
  const { t, p, actions } = useApp();
  const notificationPermission = useNotificationPermission();
  const auth = useOptionalAuth();
  const user = auth?.user ?? null;
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const join = (...parts: string[]) => parts.join(' · ');
  const categories: readonly {
    screen: 'settingsDay' | 'settingsAlerts' | 'settingsConnections' | 'settingsPrivacy' | 'settingsApp';
    label: string; sub: string; glyph: SettingsGlyphName; tint: string; id: string;
  }[] = [
    { screen: 'settingsDay', label: t.settingsCategoryDay, sub: join(t.settingsRoutine, t.wbTitle, t.financialTitle), glyph: 'calendar', tint: p.wm, id: 'settings-category-day' },
    { screen: 'settingsAlerts', label: t.settingsCategoryAlerts, sub: join(t.settingsAlertsNotifications, t.settingsWidget, t.placesTitle), glyph: 'bell', tint: p.wm, id: 'settings-category-alerts' },
    { screen: 'settingsConnections', label: t.settingsCategoryConnections, sub: join(t.xIntegrations, t.calendarWriteTitle, t.aiImportTitle), glyph: 'link', tint: p.acd, id: 'settings-category-connections' },
    { screen: 'settingsPrivacy', label: t.settingsCategoryPrivacy, sub: join(t.settingsKnows, t.sTrust, t.activityTitle), glyph: 'shield', tint: p.success, id: 'settings-category-privacy' },
    { screen: 'settingsApp', label: t.settingsCategoryApp, sub: join(t.settingsLangAppearance, ...(user ? [t.accountTitle] : []), t.settingsAbout), glyph: 'sliders', tint: p.tx, id: 'settings-category-app' },
  ];
  const version = Constants.expoConfig?.version;

  return <Screen
    testID="settings-root"
    pinned={<SettingsHeader title={t.settingsTitle} onBack={() => actions.back()} />}
    overlay={confirmSignOut && auth ? (
      <Dialog
        testID="sign-out-dialog"
        title={t.authSignOutConfirm}
        body={t.authSignOutBody}
        confirmLabel={t.authSignOut}
        cancelLabel={t.cancel}
        tone="ink"
        onConfirm={() => { setConfirmSignOut(false); void auth.signOut({ reason: 'user' }); }}
        onCancel={() => setConfirmSignOut(false)}
        confirmTestID="sign-out-confirm"
        cancelTestID="sign-out-cancel"
      />
    ) : null}
  >
    <ScreenScroll testID="settings-scroll" gap={10} topGap={14} bottom={48}>
      {user ? <AccountCard user={user} onPress={() => actions.go('account')} /> : null}
      <View style={{ gap: 10, marginTop: user ? 12 : 0 }}>
        {categories.map(category => (
          <SettingsHubRow
            key={category.screen}
            label={category.label}
            sub={category.sub}
            glyph={category.glyph}
            tint={category.tint}
            testID={category.id}
            onPress={() => actions.go(category.screen)}
            {...(category.screen === 'settingsAlerts' && notificationPermission === 'denied'
              ? { sub: t.notifBlockedByPhone, subTone: 'warn' as const, subTestID: 'settings-alerts-blocked' }
              : {})}
          />
        ))}
      </View>

      {user ? (
        <View style={{ gap: 6, marginTop: 20, alignItems: 'stretch' }}>
          <Btn testID="settings-sign-out" label={t.authSignOut} onPress={() => setConfirmSignOut(true)} scaleTo={0.98}
            style={{ minHeight: 48, borderRadius: 999, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 }}>
            <Txt size={16} weight={600} color={p.tx} align="center">{t.authSignOut}</Txt>
          </Btn>
          {/* Destructive, but not shouting: the accent's own text colour, and
              last, so it is never the thing a thumb lands on by accident. The
              flow it opens asks again before anything is sent. */}
          <Btn testID="settings-delete-account" label={t.accountDeleteAction} onPress={() => actions.go('deleteAccount')} scaleTo={0.98}
            style={{ minHeight: 44, borderRadius: 999, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 }}>
            <Txt size={15} weight={600} color={p.acd} align="center">{t.accountDeleteAction}</Txt>
          </Btn>
        </View>
      ) : null}
      {version ? (
        <Txt latin size={13} color={p.mu} align="center" style={{ marginTop: 8 }} testID="settings-version">{`MaybeSitter v${version}`}</Txt>
      ) : null}
    </ScreenScroll>
  </Screen>;
}

/** Who is signed in: their initial, their name (or address), and the way to the account page. */
function AccountCard({ user, onPress }: { user: { displayName: string | null; email: string | null }; onPress: () => void }) {
  const { t, p, rtl, script } = useApp();
  const letter = avatarInitial(user);
  const run = letter ? scriptOfText(letter, script) : null;
  const drawable = letter !== null && (run === script || run === 'latin');
  const name = user.displayName?.trim() || user.email || t.authSignedInPrivateApple;
  const sub = user.displayName?.trim() ? (user.email ?? t.accountTitle) : t.accountTitle;
  return (
    <Btn testID="settings-account-card" label={`${name}. ${sub}`} hint={t.accountTitle} onPress={onPress} scaleTo={0.985}
      style={{ minHeight: 80, borderRadius: 20, borderWidth: 1, borderColor: p.ln, backgroundColor: p.sf, paddingVertical: 14, paddingHorizontal: 16, gap: 14, flexDirection: 'row', alignItems: 'center' }}>
      <View accessible={false} style={{ width: 56, height: 56, borderRadius: 28, borderWidth: 2, borderColor: p.ac, backgroundColor: p.bg, alignItems: 'center', justifyContent: 'center' }}>
        {drawable
          ? <Txt size={22} weight={700} color={p.acd} align="center" lh={1.2} latin={run === 'latin'}>{letter}</Txt>
          : <ReferenceIcon name="person" size={24} color={p.acd} />}
      </View>
      <View style={{ flex: 1, gap: 2, alignItems: 'flex-start' }}>
        <Txt size={16} weight={700} color={p.tx}>{name}</Txt>
        <Txt size={13} color={p.mu}>{sub}</Txt>
      </View>
      <ChevronIcon color={p.mu} rtl={rtl} />
    </Btn>
  );
}
