/**
 * Google: Calendar busy time, Gmail and one Drive file, through one grant (CL6a).
 *
 * ── Five states, and what each one offers ────────────────────────
 *
 *  - **not configured** — the owner has not put the OAuth client in place. One
 *    honest line, «ربط Google بستنّى إعداد من صاحب التطبيق», and no connect
 *    button anywhere. Not "coming soon": everything else is built.
 *  - **connect** — the account (or this feature) is not connected: «اربط».
 *  - **connected** — the address, and the feature's own action: refresh busy
 *    times, «جيب التزامات من إيميلي», «اختار ملف من Drive».
 *  - **reconnect** — Google stopped honouring the grant (a Testing-mode grant
 *    lapses after seven days): «أعد الربط», which asks again for every feature
 *    the lapsed grant held.
 *  - **disconnect** — once, for the account, behind a confirm: it withdraws
 *    the grant at Google, which takes all three features with it.
 *
 * Gmail and Drive read through the model, so without AI consent they say so
 * and point at the setting instead of offering a button that can only be
 * refused. What they read lands in the ordinary review screen: nothing is
 * saved until the person confirms it there.
 *
 * Every message is a locale key (`userFacingMessageKey`), never a server or
 * Google sentence.
 */
import React from 'react';
import { AccessibilityInfo, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { useAiConsentGranted, useTrust } from '../../api/queries';
import { userFacingMessageKey, type UserFacingKey } from '../../api/ui/userFacingMessage';
import type { GoogleFeature, GoogleStatus } from '../../api/schemas/google';
import { fill } from '../../i18n/strings';
import { isolate } from '../../i18n/bidi';
import { Dialog } from '../../ui/dialog';
import { Pill, Txt } from '../../ui/primitives';
import { AvailabilityBadge, ProductActions, ProductPage, ProductSection } from '../../ui/product';
import { useCaptureFlow } from '../capture/CaptureProvider';
import {
  useDrivePick,
  useGmailScan,
  useGoogleCalendarSync,
  useGoogleConnect,
  useGoogleDisconnect,
  useGoogleStatus,
} from './useGoogle';

/** What the page says under the rows after the last action. A key, never a sentence. */
type Notice = { key: UserFacingKey; tone: 'info' | 'problem' } | null;

const TITLES: Record<GoogleFeature, string> = { calendar: 'Google Calendar', gmail: 'Gmail', drive: 'Google Drive' };

export function GoogleIntegrationScreen() {
  const { t, p, actions } = useApp();
  const status = useGoogleStatus();
  const connect = useGoogleConnect();
  const disconnect = useGoogleDisconnect();
  const sync = useGoogleCalendarSync();
  const scan = useGmailScan();
  const pick = useDrivePick();
  const { adoptProposal } = useCaptureFlow();
  const { granted: aiGranted, loading: aiLoading } = useAiConsentGranted();
  const trust = useTrust();
  const [notice, setNotice] = React.useState<Notice>(null);
  const [confirming, setConfirming] = React.useState(false);
  // The live region below speaks on Android only; VoiceOver has to be told.
  // The outcome of a press lands after the auth session closes, away from
  // the button, so without this it is silent on iOS.
  React.useEffect(() => {
    if (notice) AccessibilityInfo.announceForAccessibility(t[notice.key]);
  }, [notice, t]);

  const busy = connect.isPending || disconnect.isPending || sync.isPending || scan.isPending || pick.isPending;
  const google: GoogleStatus | undefined = status.data;
  const configured = google !== undefined && google.status !== 'not_configured';
  const live = google?.status === 'connected' || google?.status === 'needs_reauth';
  const aiBlocked = !aiLoading && !aiGranted;
  const calendarConsent = trust.data?.trust.calendarConsent === true;

  const fail = (error: unknown) => setNotice({ key: userFacingMessageKey(error), tone: 'problem' });

  const onConnect = (feature: GoogleFeature) => {
    setNotice(null);
    connect.mutate(feature, {
      onSuccess: (outcome) => { if (outcome === 'connected') setNotice({ key: 'googleConnected', tone: 'info' }); },
      onError: fail,
    });
  };
  const onSync = () => {
    setNotice(null);
    sync.mutate(undefined, { onSuccess: () => setNotice({ key: 'googleSynced', tone: 'info' }), onError: fail });
  };
  const onScan = () => {
    setNotice(null);
    scan.mutate(undefined, {
      onSuccess: (proposal) => { adoptProposal(proposal); actions.go('capture'); },
      onError: fail,
    });
  };
  const onPick = () => {
    setNotice(null);
    pick.mutate(undefined, {
      onSuccess: (outcome) => {
        if (outcome.kind === 'proposal') {
          adoptProposal(outcome.proposal);
          actions.go('capture');
        } else if (outcome.kind === 'expired') setNotice({ key: 'googleErrExpired', tone: 'problem' });
        else if (outcome.kind === 'failed') setNotice({ key: 'googleErrUnavailable', tone: 'problem' });
      },
      onError: fail,
    });
  };
  const onDisconnect = () => {
    disconnect.mutate(undefined, {
      onSuccess: () => { setConfirming(false); setNotice(null); },
      onError: (error) => { setConfirming(false); fail(error); },
    });
  };

  /** The one line under a feature's title, and the action it offers. */
  const row = (feature: GoogleFeature, body: string) => {
    const held = google?.features[feature] === true;
    let line: string | null = null;
    let lineTone: 'muted' | 'problem' = 'muted';
    let action: React.ReactNode = null;
    if (!configured) {
      // Not configured: no line of its own (the page says it once), no button.
    } else if (google!.status === 'needs_reauth' && held) {
      line = t.googleReconnectBody;
      lineTone = 'problem';
      action = <Pill testID={`google-reconnect-${feature}`} label={t.googleReconnect} kind="accent" disabled={busy} onPress={() => onConnect(feature)} />;
    } else if (!held || google!.status !== 'connected') {
      action = <Pill testID={`google-connect-${feature}`} label={t.googleConnect} kind="accent" disabled={busy} onPress={() => onConnect(feature)} />;
    } else {
      line = google!.accountEmail ? fill(t.googleConnectedAs, { email: isolate(google!.accountEmail) }) : t.googleConnected;
      if (feature === 'calendar') {
        action = calendarConsent
          ? <Pill testID="google-calendar-sync" label={t.googleSyncCalendar} kind="soft" disabled={busy} onPress={onSync} />
          : <View style={{ gap: 10, alignItems: 'flex-start' }}>
            <Txt role="supporting" color={p.wm} testID="google-calendar-needs-consent">{t.googleNeedsCalendarConsent}</Txt>
            <Pill testID="google-calendar-trust" label={t.sTrust} kind="outline" onPress={() => actions.go('trust')} />
          </View>;
      } else if (aiBlocked) {
        action = <View style={{ gap: 10, alignItems: 'flex-start' }}>
          <Txt role="supporting" color={p.wm} testID={`google-${feature}-needs-ai`}>{t.googleNeedsAi}</Txt>
          <Pill testID={`google-${feature}-turn-on-ai`} label={t.shareTurnOnAi} kind="outline" onPress={() => actions.go('trust')} />
        </View>;
      } else if (feature === 'gmail') {
        action = <Pill testID="google-gmail-scan" label={t.googleGmailScan} kind="accent" disabled={busy} onPress={onScan} />;
      } else if (google!.pickerAvailable) {
        action = <Pill testID="google-drive-pick" label={t.googleDrivePick} kind="accent" disabled={busy} onPress={onPick} />;
      } else {
        action = <Txt role="supporting" color={p.mu} testID="google-drive-picker-unavailable">{t.googleErrPickerUnavailable}</Txt>;
      }
    }
    return <View testID={`google-row-${feature}`} style={{ gap: 12 }}>
      <ProductSection title={TITLES[feature]} body={body} icon={feature === 'calendar' ? 'calendar' : 'file'}>
        {line ? <Txt role="supporting" color={lineTone === 'problem' ? p.wm : p.mu} testID={`google-${feature}-line`}>{line}</Txt> : null}
        {google?.status === 'needs_reauth' && held ? <AvailabilityBadge status="NEEDS_REAUTH" testID={`google-${feature}-reauth`} /> : null}
        {action ? <ProductActions>{action}</ProductActions> : null}
      </ProductSection>
    </View>;
  };

  return <ProductPage id="google" title={t.xGoogleDetail} subtitle={t.xGoogleBody}
    overlay={confirming ? <Dialog
      testID="google-disconnect-dialog"
      title={t.googleDisconnectTitle}
      body={t.googleDisconnectBody}
      confirmLabel={t.googleDisconnect}
      cancelLabel={t.googleDisconnectKeep}
      tone="warm"
      busy={disconnect.isPending}
      confirmTestID="google-disconnect-confirm"
      cancelTestID="google-disconnect-keep"
      onConfirm={onDisconnect}
      onCancel={() => setConfirming(false)}
    /> : null}>
    {google?.status === 'not_configured'
      ? <Txt role="supporting" color={p.mu} testID="google-not-configured">{t.googleNotConfigured}</Txt>
      : null}
    {status.isError
      ? <View style={{ gap: 10, alignItems: 'flex-start' }}>
        <Txt role="supporting" color={p.wm} testID="google-status-error">{t[userFacingMessageKey(status.error)]}</Txt>
        <Pill testID="google-status-retry" label={t.errorsRetry} kind="outline" onPress={() => void status.refetch()} />
      </View>
      : null}
    {row('calendar', t.googleCalendarBody)}
    {row('gmail', t.googleGmailBody)}
    {row('drive', t.googleDriveBody)}
    <View accessibilityLiveRegion="polite" style={{ gap: 8 }}>
      {busy ? <Txt role="supporting" color={p.mu} testID="google-working">{t.googleWorking}</Txt> : null}
      {notice ? <Txt role="supporting" color={notice.tone === 'problem' ? p.wm : p.mu} testID="google-notice">{t[notice.key]}</Txt> : null}
    </View>
    {live ? <ProductActions>
      <Pill testID="google-disconnect" label={t.googleDisconnect} kind="outline" disabled={busy} onPress={() => setConfirming(true)} />
    </ProductActions> : null}
    {/* The phone's own calendar still works without any of this, and is
        where its settings live. */}
    <ProductSection title={t.xDeviceCalendar} body={t.xDeviceBody} icon="calendar">
      <Pill testID="google-device-settings" label={t.calendarWriteTitle} kind="soft" onPress={() => actions.go('calendarSettings')} />
    </ProductSection>
    <ProductSection title={t.xPrivacy} body={t.xCalendarPrivacy} icon="shield">
      <Pill label={t.sTrust} kind="outline" onPress={() => actions.go('trust')} />
    </ProductSection>
  </ProductPage>;
}
