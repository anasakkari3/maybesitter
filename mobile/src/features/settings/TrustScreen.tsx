import { ClarityConsent } from '../../clarity/ClarityConsent';
import React, { useState } from 'react';
import { ActivityIndicator, Linking, Platform, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { Btn, Card, Pill, Txt } from '../../ui/primitives';
import { Screen, ScreenScroll } from '../../ui/screen';
import {
  useCalendarConsentWritePending,
  useConsents,
  useSetPersonalizationConsent,
  useSetRecommendationConsent,
  useReportPilotIncident,
  useTrust,
  useTrustAction,
} from '../../api/queries';
import { apiLocale } from '../../i18n/locale';
import { isolateLatinRuns } from '../../i18n/bidi';
import { openLegal, privacyPolicyUrl } from '../../config/legalLinks';
import { ServerToggle } from './ServerToggle';
import { QueryBoundary } from '../../api/ui/QueryBoundary';
import { SettingsHeader, SettingsRow } from './SettingsChrome';
import { Dialog } from '../../ui/dialog';
import { SectionLabel, TextLink } from '../../ui/chrome';
import { toggleFailureKey, userFacingMessage, type UserFacingKey } from '../../api/ui/userFacingMessage';
import { useAnnounceOnIos } from '../../ui/announce';
import { LiveRegion } from '../../ui/liveRegion';
import type { PilotIncidentInput } from '../../api/schemas/trust';
import { deviceCalendar } from '../calendar/deviceCalendar';
import { useCalendarConnection } from '../calendar/calendarConnection';
import { exportPhaseCopy, useExportMyData } from '../account/useExportMyData';
import { useAuth } from '../../auth/AuthProvider';
import { clearVisitWait } from '../../lib/deviceSettings/visitThrottle';

const INCIDENT_SURFACES: readonly PilotIncidentInput['surface'][] = ['capture', 'recommendation', 'calendar', 'analytics', 'account'];
const INCIDENT_CATEGORIES: readonly PilotIncidentInput['category'][] = ['reliability', 'privacy', 'safety', 'consent', 'other'];

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
 * ── AI processing is told, not asked ─────────────────────────────
 *
 * AI processing can no longer be turned off (owner decision 2026-09-30): the
 * capture page is a chat on the model, and the server reads the AI question
 * as granted and refuses a decline (409 `ai_always_on`). So there is no switch
 * here to move — a switch that could only say "on" would be a control that
 * lies about being one. In its place is the disclosure: who reads what the
 * person writes or says, and what is kept. The recommendation and
 * personalization questions are still separate questions with their own
 * switches (#170, #202).
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
 * deletion`), and deletion is UC-1.5 (#149)'s flow, which is the real thing.
 * A grep test asserts no screen here sends `{type:'delete'}`.
 *
 * ── «وقّف» stops suggestions and learning, not the account ───────
 *
 * This card used to send the trust `revoke`, which stamped `revokedAt` and
 * locked the whole account behind «هالحساب موقوف» with no way back, while
 * its words only promised to stop suggesting and learning (QA v3, V3-F35-07).
 * Owner decision 2026-11-19: it answers exactly those two questions — the
 * next-step and the pattern-learning consents, through the same endpoints as
 * the switches above — and once both are off it offers them back. It never
 * sends `revoke`; the revoked screen stays for an account already locked.
 */
export function TrustScreen({ onBack, onKnows }: { onBack: () => void; onKnows: () => void }) {
  const { t, p, lang, actions } = useApp();
  const consents = useConsents();
  const trust = useTrust();
  const setRecommendations = useSetRecommendationConsent();
  const uid = useAuth().user?.uid ?? null;
  const setPersonalization = useSetPersonalizationConsent();
  const trustAction = useTrustAction();
  const report = useReportPilotIncident();
  const exportData = useExportMyData();
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  // The line under the stop card when a write failed: which words, from the
  // same rule as a switch's (`toggleFailureKey`), or the partial line when the
  // first answer landed and the second did not.
  const [stopFailure, setStopFailure] = useState<UserFacingKey | null>(null);
  // «موقّفين» / «رجّعناهم» are said out loud only as the answer to this
  // card's own tap, not every time the screen opens on an account already off.
  const [landed, setLanded] = useState<'stopped' | 'resumed' | null>(null);
  // A turn-back-on the person asked for and that has not fully landed: the
  // card keeps offering it — while it is on its way, after a partial one, and
  // after a retry that failed — rather than flipping to «stop» (review of #873).
  const [resumeOffered, setResumeOffered] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [incidentSurface, setIncidentSurface] = useState<PilotIncidentInput['surface']>('capture');
  const [incidentCategory, setIncidentCategory] = useState<PilotIncidentInput['category']>('reliability');

  const versions = consents.data?.currentVersions;
  const context = {
    locale: apiLocale(lang),
    platform: Platform.OS === 'ios' ? 'ios' as const : 'android' as const,
  };
  const state = trust.data?.trust;
  // The line under the calendar switch, from the answers Settings → Calendar
  // renders from (UAT round 6, D-d): the phone's answer is read on arrival and
  // on every return from phone settings, not only after this switch asked.
  const calendar = useCalendarConnection(state?.calendarConsent === true);
  const calendarWritePending = useCalendarConsentWritePending();
  const calendarLine = calendar.line === null || calendar.line === 'denied' ? undefined : t[calendar.line];
  const policy = privacyPolicyUrl(lang);

  // Off means both questions were answered, and neither with yes. Pattern
  // learning only counts where this server names its version (an older API
  // has no such question). A question never asked is not «stopped» — there is
  // nothing to turn back on (review of #873) — and unknown, the answers could
  // not be read, claims neither state.
  const asksPersonalization = versions?.personalization !== undefined;
  const answeredOff = (view: { state: string; asked?: boolean } | undefined) => view?.asked === true && view.state !== 'granted';
  const stopped = consents.data !== undefined
    && answeredOff(consents.data.recommendations)
    && (!asksPersonalization || answeredOff(consents.data.personalization));
  const answering = setRecommendations.isPending || setPersonalization.isPending;

  /**
   * Both answers, suggestions first: a failure between the two leaves less
   * switched on than the person asked for when stopping, and says why.
   */
  const answerBoth = async (state: 'granted' | 'declined') => {
    if (!versions) return;
    setStopFailure(null);
    setLanded(null);
    setResumeOffered(state === 'granted');
    const suggestions = () => setRecommendations.mutateAsync({ state, version: versions.recommendations, ...context });
    const learning = () => asksPersonalization
      ? setPersonalization.mutateAsync({ state, version: versions.personalization!, ...context })
      : Promise.resolve(null);
    // Stopping: suggestions first. Resuming: learning first. Either way a
    // failure between the two leaves suggestions — the louder of the two —
    // off, and the line under the card says which half did not land.
    const [first, second, partial] = state === 'declined'
      ? [suggestions, learning, 'trustStopPartial' as const]
      : [learning, suggestions, 'trustResumePartial' as const];
    try {
      await first();
    } catch (error) {
      setStopFailure(toggleFailureKey(error));
      return;
    }
    try {
      await second();
    } catch (error) {
      // Marks the error as said (the failure bridge stays quiet); the words
      // are the partial line, which names the half that did land.
      toggleFailureKey(error);
      setStopFailure(partial);
      return;
    }
    if (state === 'declined') setLanded('stopped');
    else {
      setResumeOffered(false);
      setLanded('resumed');
      // A visit refused while suggestions were off waits six hours; a yes
      // ends that wait, as the switch does (QA CA7.5).
      if (uid) clearVisitWait(uid);
    }
  };
  // After a turn-back-on that landed only its learning half, the card still
  // offers what the person asked for, not «stop» (review of #873).
  const showResume = stopped || resumeOffered;
  const stopLine = stopFailure ? t[stopFailure]
    : landed === 'stopped' && stopped ? t.trustRevoked
      : landed === 'resumed' && !stopped ? t.trustResumed
        : null;
  // A live region for TalkBack, and VoiceOver told: the line appears away
  // from the button, after the dialog closed (the switches' rule).
  useAnnounceOnIos(stopLine);

  /**
   * True when the write landed. A failure is thrown on to `ServerToggle`, which
   * says which one it was — a refusal is not "didn't reach the server" (N9).
   */
  const record = async (run: Promise<unknown>): Promise<boolean> => {
    // A switch moved by hand answers for itself; the stop card's old line no
    // longer describes what is on.
    setStopFailure(null);
    setLanded(null);
    setResumeOffered(false);
    await run;
    return true;
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
            body={t.trustRevokeConfirmBody}
            confirmLabel={t.trustRevoke}
            cancelLabel={t.cancel}
            tone="ink"
            onConfirm={() => { setConfirmRevoke(false); void answerBoth('declined'); }}
            onCancel={() => setConfirmRevoke(false)}
            confirmTestID="trust-revoke-confirm"
            cancelTestID="trust-revoke-cancel"
          />
        ) : null}
        </>
      )}
    >
      <ScreenScroll>
        {/* The disclosure that replaced the AI consent: read, not answered. */}
        <Card pad={18} style={{ gap: 8 }} testID="trust-ai-disclosure">
          <Txt role="section" size={15} weight={600}>{t.aiDisclosureTitle}</Txt>
          <Txt size={13} color={p.mu} lh={1.5} testID="trust-ai-disclosure-body">{isolateLatinRuns(t.aiDisclosure)}</Txt>
          <Txt size={13} color={p.mu} lh={1.5}>{t.aiDisclosureKept}</Txt>
        </Card>

        <Txt size={14} color={p.mu} lh={1.5}>{t.trustLede}</Txt>

        <SectionLabel>{t.settingsGroupYou}</SectionLabel>
        <Card pad={0} style={{ overflow: 'hidden' }}>
          {/* A switch whose position the server did not answer is not drawn:
              off would claim "nothing is shared" on no authority (QA v3
              V3-F35-09, CXA12.5). The read's failure and a retry instead. */}
          <QueryBoundary isPending={consents.isPending} error={consents.data ? null : consents.error} onRetry={() => void consents.refetch()}>
          <ServerToggle
            testID="trust-recommendations"
            title={t.obRecTitle}
            body={t.obRecBody}
            value={consents.data?.recommendations.state === 'granted'}
            disabled={versions === undefined}
            onChange={next => record(setRecommendations.mutateAsync({
              state: next ? 'granted' : 'declined', version: versions!.recommendations, ...context,
            }).then((saved) => {
              // A visit refused while they were off waits six hours; a yes
              // ends that wait, so «يتابع لك» can ask now (QA CA7.5).
              if (saved.recommendations.state === 'granted' && uid) clearVisitWait(uid);
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
          </QueryBoundary>
        </Card>

        <SectionLabel>{t.settingsGroupTrust}</SectionLabel>
        <Card pad={0} style={{ overflow: 'hidden' }}>
          <QueryBoundary isPending={trust.isPending} error={state ? null : trust.error} onRetry={() => void trust.refetch()}>
          <ServerToggle
            testID="trust-analytics"
            title={t.obAnalyticsTitle}
            body={t.obAnalyticsBody}
            value={state?.analyticsConsent === true}
            disabled={state === undefined}
            onChange={next => record(trustAction.mutateAsync({ type: 'set_analytics_consent', granted: next }))}
          />
          <ClarityConsent />
          <ServerToggle
            testID="trust-quiet-mode"
            title={t.trustQuietMode}
            body={t.trustQuietModeBody}
            value={state?.quietMode === true}
            disabled={state === undefined}
            onChange={next => record(trustAction.mutateAsync({ type: 'set_quiet_mode', enabled: next }))}
          />
          </QueryBoundary>
        </Card>

        <SectionLabel>{t.settingsGroupConnections}</SectionLabel>
        <Card pad={0} style={{ overflow: 'hidden' }}>
          {/* The same trust read as the card above, which already says it
              failed: the switch waits for it rather than claiming off. */}
          {state ? (
          <ServerToggle
            testID="trust-calendar"
            title={t.trustCalendar}
            // What is actually connected, not a fixed «مش موصول من هون»
            // (UAT round 6, D-d, shot 845). A refusal is the card below.
            body={calendarLine}
            // Off and still while the phone refuses, the same as Settings →
            // Calendar: consent alone reads and adds nothing, and a switch on
            // over the refusal card is a switch that lies (UAT round 6, shots
            // 882/883). The consent is kept on the account, so allowing access
            // in phone settings brings the switch straight back.
            value={state?.calendarConsent === true && calendar.access !== 'denied'}
            // Locked while any calendar-consent write for the account is on its
            // way, here or in Settings → Calendar (Codex M6B-R6-002).
            disabled={state === undefined || calendar.access === 'denied' || calendarWritePending}
            onChange={async next => {
              // On the way on, ask the phone first (first iPhone run, L7):
              // recording the consent alone left the busy read failing,
              // silently, as `denied`. `requestAccess` only prompts when the
              // phone has not answered; after that it reports the answer.
              if (next) calendar.setAccess(await deviceCalendar.requestAccess());
              return record(trustAction.mutateAsync({ type: 'set_calendar_consent', granted: next }));
            }}
          />
          ) : null}
          {calendar.access === 'denied' ? (
            <View style={{ paddingHorizontal: 18, paddingTop: 12, gap: 10 }}>
              <Txt size={13} color={p.mu} lh={1.5} testID="trust-calendar-denied">{t.calendarPermissionDenied}</Txt>
              <Btn
                label={t.notifOpenSettings}
                testID="trust-calendar-open-settings"
                onPress={() => void Linking.openSettings()}
                style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 999, borderWidth: 1, borderColor: p.ln }}
              >
                <Txt size={14} color={p.ac}>{t.notifOpenSettings}</Txt>
              </Btn>
            </View>
          ) : null}
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

        {state && !state.revokedAt ? <Card pad={18} style={{ gap: 10 }}>
          <Txt size={15} weight={600}>{t.trustReportTitle}</Txt>
          <Txt size={13} color={p.mu} lh={1.5}>{t.trustReportBody}</Txt>
          {reporting ? <>
            <Txt role="label">{t.trustReportWhere}</Txt>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {INCIDENT_SURFACES.map(surface => <Pill key={surface} label={t[`trustReportSurface_${surface}`]} kind={incidentSurface === surface ? 'accent' : 'outline'} onPress={() => setIncidentSurface(surface)} />)}
            </View>
            <Txt role="label">{t.trustReportKind}</Txt>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {INCIDENT_CATEGORIES.map(category => <Pill key={category} label={t[`trustReportCategory_${category}`]} kind={incidentCategory === category ? 'accent' : 'outline'} onPress={() => setIncidentCategory(category)} />)}
            </View>
            {report.error ? <Txt size={13} color={p.wm}>{userFacingMessage(report.error, t)}</Txt> : null}
            {report.isSuccess ? <Txt size={13} color={p.ac} testID="trust-report-saved">{t.trustReportSaved}</Txt> : null}
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Pill testID="trust-report-submit" label={t.trustReportSubmit} disabled={report.isPending || report.isSuccess} onPress={() => report.mutate({ surface: incidentSurface, category: incidentCategory })} />
              <Pill label={t.cancel} kind="outline" onPress={() => { setReporting(false); report.reset(); }} />
            </View>
          </> : <Pill testID="trust-report-open" label={t.trustReportOpen} kind="outline" onPress={() => setReporting(true)} />}
        </Card> : null}

        <Card pad={18} style={{ gap: 10 }}>
          <Txt size={15} weight={600}>{t.trustRevoke}</Txt>
          <Txt size={13} color={p.mu} lh={1.5}>{t.trustRevokeBody}</Txt>
          <Txt size={13} color={p.mu} lh={1.5} testID="trust-revoke-email">{t.trustRevokeEmail}</Txt>
          {showResume ? (
            <Btn
              label={t.trustResume}
              testID="trust-resume"
              accessibilityState={{ busy: answering }}
              disabled={answering}
              onPress={answering ? undefined : () => void answerBoth('granted')}
              style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 999, borderWidth: 1, borderColor: p.ln, opacity: answering ? 0.5 : 1 }}
            >
              <Txt size={14} color={p.ac}>{t.trustResume}</Txt>
            </Btn>
          ) : (
            <Btn
              label={t.trustRevoke}
              testID="trust-revoke"
              accessibilityState={{ busy: answering }}
              disabled={versions === undefined || answering}
              onPress={versions === undefined || answering ? undefined : () => setConfirmRevoke(true)}
              style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 999, borderWidth: 1, borderColor: p.ln, opacity: versions === undefined || answering ? 0.5 : 1 }}
            >
              <Txt size={14} color={p.wm}>{t.trustRevoke}</Txt>
            </Btn>
          )}
          {answering ? <ActivityIndicator testID="trust-stop-busy" color={p.ac} /> : null}
          {/* Mounted before anything fails, so TalkBack hears the line arrive. */}
          {/* One line or none, so an empty region takes no room. */}
          {/* The standing state, outside the live region: an account already
              off is not announced every time the answers arrive (TalkBack). */}
          {stopped && !stopFailure && landed !== 'stopped'
            ? <Txt size={13} color={p.mu} testID="trust-revoked">{t.trustRevoked}</Txt> : null}
          {/* What this card's own tap did, inside it. One line or none, so an
              empty region takes no room. */}
          <LiveRegion testID="trust-stop-live">
            {stopFailure ? <Txt size={13} color={p.wm} testID="trust-stop-failed">{t[stopFailure]}</Txt>
              : landed === 'stopped' && stopped ? <Txt size={13} color={p.mu} testID="trust-revoked">{t.trustRevoked}</Txt>
                : landed === 'resumed' && !stopped ? <Txt size={13} color={p.mu} testID="trust-resumed">{t.trustResumed}</Txt>
                  : null}
          </LiveRegion>
        </Card>

        {/* The real export (#174 step 7): the server builds it from the same
            collection list deletion uses, and the share sheet is handed the
            file. The line under the button says when it is working or why it
            did not. */}
        <Card pad={18} style={{ gap: 10 }}>
          <Txt size={15}>{t.trustExport}</Txt>
          <Txt size={13} color={p.mu} lh={1.5}>{t.trustExportBody}</Txt>
          <Pill
            testID="trust-export"
            kind="outline"
            label={exportData.phase === 'preparing' ? t.exportDataPreparing : t.exportDataAction}
            disabled={exportData.phase === 'preparing'}
            onPress={() => void exportData.start()}
          />
          {exportData.phase === 'failed' || exportData.phase === 'tooLarge' || exportData.phase === 'rateLimited' ? (
            <Txt size={13} color={p.wm} testID="trust-export-failed">{exportPhaseCopy(exportData.phase, t)}</Txt>
          ) : null}
        </Card>
      </ScreenScroll>
    </Screen>
  );
}
