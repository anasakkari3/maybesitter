import React, { useState } from 'react';
import { Platform, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { Btn, Card, Txt } from '../../ui/primitives';
import { Screen, ScreenScroll } from '../../ui/screen';
import {
  useConsents,
  useSetAiConsent,
  useSetPersonalizationConsent,
  useSetRecommendationConsent,
  useTrust,
  useTrustAction,
} from '../../api/queries';
import { apiLocale } from '../../i18n/locale';
import { openLegal, privacyPolicyUrl } from '../../config/legalLinks';
import { ServerToggle } from './ServerToggle';
import { SettingsHeader, SettingsRow } from './SettingsChrome';
import { Dialog } from '../../ui/dialog';
import { SectionLabel, TextLink } from '../../ui/chrome';

/**
 * The trust centre (UC-2.R4, #174).
 *
 * ── Everything here renders from the server ──────────────────────
 *
 * Not from local state, not from a cache the app is confident about. Two
 * queries back this screen — `GET /api/mobile/consents` for the two versioned
 * consents and `GET /api/mobile/pilot/trust` for analytics, quiet mode and
 * calendar — and each toggle's position is the last thing the server said.
 * `ServerToggle` explains why there is no optimistic update.
 *
 * ── The AI consent is never the recommendation one ───────────────
 *
 * They are separate questions with separate versions and separate storage
 * (#161, #170). The mistake worth naming is reading `recommendationConsent`
 * for the AI row: it would let somebody who agreed to *suggestions* have their
 * sentences sent to a model. The two hooks below are deliberately not
 * interchangeable, and a test asserts each writes to its own endpoint.
 *
 * ── The personalization question is a third question ────────────
 *
 * "Notice patterns in when you finish things" (UC-3.16, #202) is not a mode of
 * the recommendation consent. That one is about MaybeSitter choosing what to
 * put in front of you; this one is about it drawing a conclusion *about* you
 * from when you finish things. Off until it is answered here, and its own copy
 * names both things turning it off stops — the suggestions, and the daily plan
 * using a pattern that was kept.
 *
 * ── Deleting an account is not a trust action ────────────────────
 *
 * The old pilot `delete` action is retired (it answers 400 `use_account_
 * deletion`). This screen sends `revoke`, which stops participation and keeps
 * the data, and routes deletion to UC-1.5 (#149)'s flow, which is the real
 * thing. A grep test asserts no screen here sends `{type:'delete'}`.
 */
export function TrustScreen({ onBack, onKnows }: { onBack: () => void; onKnows: () => void }) {
  const { t, p, lang, actions } = useApp();
  const consents = useConsents();
  const trust = useTrust();
  const setAi = useSetAiConsent();
  const setRecommendations = useSetRecommendationConsent();
  const setPersonalization = useSetPersonalizationConsent();
  const trustAction = useTrustAction();
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  const versions = consents.data?.currentVersions;
  const context = {
    locale: apiLocale(lang),
    platform: Platform.OS === 'ios' ? 'ios' as const : 'android' as const,
  };
  const state = trust.data?.trust;
  const policy = privacyPolicyUrl(lang);

  /** True when the write landed. `ServerToggle` shows the failure otherwise. */
  const record = async (run: Promise<unknown>): Promise<boolean> => {
    try {
      await run;
      return true;
    } catch {
      return false;
    }
  };

  return (
    <Screen
      pinned={<SettingsHeader title={t.sTrust} onBack={onBack} />}
      overlay={(
        <>
        {/* The one shape for "are you sure" (Round 2). Stopping is hard to take
            back, so it asks in the middle of the screen, over the thing it is
            about. */}
        {confirmRevoke ? (
          <Dialog
            testID="trust-revoke-dialog"
            title={t.trustRevokeConfirm}
            body={t.trustRevokeBody}
            confirmLabel={t.trustRevoke}
            cancelLabel={t.cancel}
            tone="ink"
            onConfirm={() => { setConfirmRevoke(false); void trustAction.mutateAsync({ type: 'revoke' }).catch(() => undefined); }}
            onCancel={() => setConfirmRevoke(false)}
            confirmTestID="trust-revoke-confirm"
            cancelTestID="trust-revoke-cancel"
          />
        ) : null}
        </>
      )}
    >
      <ScreenScroll>
        <Txt size={14} color={p.mu} lh={1.5}>{t.trustLede}</Txt>

        <SectionLabel>{t.settingsGroupYou}</SectionLabel>
        <Card pad={0} style={{ overflow: 'hidden' }}>
          <ServerToggle
            testID="trust-ai-processing"
            title={t.obAiTitle}
            body={t.obAiWhy}
            value={consents.data?.aiProcessing.state === 'granted'}
            // Nothing to write against until the server has named the version
            // it recognises; a guessed one is refused.
            disabled={versions === undefined}
            onChange={next => record(setAi.mutateAsync({
              state: next ? 'granted' : 'declined', version: versions!.aiProcessing, ...context,
            }))}
          />
          <ServerToggle
            testID="trust-recommendations"
            title={t.obRecTitle}
            body={t.obRecBody}
            value={consents.data?.recommendations.state === 'granted'}
            disabled={versions === undefined}
            onChange={next => record(setRecommendations.mutateAsync({
              state: next ? 'granted' : 'declined', version: versions!.recommendations, ...context,
            }))}
          />
          <ServerToggle
            testID="trust-personalization"
            title={t.trustPersonalizationTitle}
            body={t.trustPersonalizationBody}
            value={consents.data?.personalization?.state === 'granted'}
            // A server that has not named this version cannot be answered: an
            // older build of the API has no such question, and a guessed
            // version is refused.
            disabled={versions?.personalization === undefined}
            onChange={next => record(setPersonalization.mutateAsync({
              state: next ? 'granted' : 'declined', version: versions!.personalization!, ...context,
            }))}
          />
        </Card>

        <SectionLabel>{t.settingsGroupTrust}</SectionLabel>
        <Card pad={0} style={{ overflow: 'hidden' }}>
          <ServerToggle
            testID="trust-analytics"
            title={t.obAnalyticsTitle}
            body={t.obAnalyticsBody}
            value={state?.analyticsConsent === true}
            disabled={state === undefined}
            onChange={next => record(trustAction.mutateAsync({ type: 'set_analytics_consent', granted: next }))}
          />
          <ServerToggle
            testID="trust-quiet-mode"
            title={t.trustQuietMode}
            body={t.trustQuietModeBody}
            value={state?.quietMode === true}
            disabled={state === undefined}
            onChange={next => record(trustAction.mutateAsync({ type: 'set_quiet_mode', enabled: next }))}
          />
        </Card>

        <SectionLabel>{t.settingsGroupConnections}</SectionLabel>
        <Card pad={0} style={{ overflow: 'hidden' }}>
          <ServerToggle
            testID="trust-calendar"
            title={t.trustCalendar}
            // The connect/refresh/disconnect UI ships with the S3 calendar
            // issue. Until then this records an answer and nothing reads it,
            // which the body says rather than implying a connection exists.
            body={t.trustCalendarNotConnected}
            value={state?.calendarConsent === true}
            disabled={state === undefined}
            onChange={next => record(trustAction.mutateAsync({ type: 'set_calendar_consent', granted: next }))}
          />
          {/* The switch records consent; connecting the calendar is done in
              Calendar settings, which is one tap from here (Round 2). */}
          <View style={{ paddingHorizontal: 18, paddingBottom: 12 }}>
            <TextLink label={t.calendarWriteTitle} onPress={() => actions.go('calendarSettings')} testID="trust-calendar-settings" size={13} />
          </View>
        </Card>

        <Card pad={0} style={{ paddingHorizontal: 18 }}>
          <SettingsRow first label={t.trustKnows} onPress={onKnows} testID="trust-knows" />
          {policy ? (
            <SettingsRow
              label={t.legalPrivacyPolicy}
              value={t.legalOpensInBrowser}
              onPress={() => void openLegal(policy)}
              testID="trust-privacy-policy"
            />
          ) : null}
        </Card>

        <Card pad={18} style={{ gap: 10 }}>
          <Txt size={15} weight={600}>{t.trustRevoke}</Txt>
          <Txt size={13} color={p.mu} lh={1.5}>{t.trustRevokeBody}</Txt>
          {state?.revokedAt ? (
            <Txt size={13} color={p.mu} testID="trust-revoked">{t.trustRevoked}</Txt>
          ) : (
            <Btn
              label={t.trustRevoke}
              testID="trust-revoke"
              onPress={() => setConfirmRevoke(true)}
              style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 999, borderWidth: 1, borderColor: p.ln }}
            >
              <Txt size={14} color={p.wm}>{t.trustRevoke}</Txt>
            </Btn>
          )}
        </Card>

        {/* Visible, honest, and not a fake. There is no export endpoint, so
            this says so rather than producing a file that is not the user's
            data (#174 step 7). */}
        <Card pad={18} style={{ gap: 6 }}>
          <Txt size={15}>{t.trustExport}</Txt>
          <Txt size={13} color={p.mu} lh={1.5} testID="trust-export-unavailable">{t.trustExportBody}</Txt>
        </Card>
      </ScreenScroll>
    </Screen>
  );
}
