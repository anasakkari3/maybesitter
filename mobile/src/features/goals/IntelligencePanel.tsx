import React from 'react';
import { AccessibilityInfo, Keyboard, Platform, TextInput, View } from 'react-native';
import {
  analyzeIntelligenceStatement, decideIntelligenceSuggestion,
  generateIntelligenceSuggestions, getIntelligenceInbox, reviewIntelligenceObservation,
  scanGmailForIntelligence,
  answerIntelligenceQuestion,
  getGmailIntelligenceMonitor, setGmailIntelligenceMonitor,
} from '../../api/endpoints/intelligence';
import type { IntelligenceInbox, IntelligenceObservation } from '../../api/schemas/intelligence';
import type { z } from 'zod';
import { intelligenceGmailMonitorSchema } from '../../api/schemas/intelligence';
import { forbiddenReason, userFacingMessage } from '../../api/ui/userFacingMessage';
import { fill, ltr } from '../../i18n/strings';
import { formatDate, formatTime } from '../../i18n/format';
import { useTimeZone } from '../../i18n/timezone';
import { useApp } from '../../state/AppContext';
import { Pill, Txt } from '../../ui/primitives';
import { Disclosure } from '../../ui/Disclosure';
import { useLayoutMode } from '../../theme/textScale';
import { LiveRegion } from '../../ui/liveRegion';
import { ProductSection } from '../../ui/product';
import { QueryBoundary } from '../../api/ui/QueryBoundary';
import { isolateAuto } from '../../i18n/bidi';
import { useOptionalAuth } from '../../auth/AuthProvider';
import type { Strings } from '../../i18n/strings';
import { claimVisit, recordVisitAnswer, recordVisitFailure } from '../../lib/deviceSettings/visitThrottle';
import { useConsents } from '../../api/queries';
import { PlanFlowView } from '../goalPlan/PlanFlow';
import { usePlanPathAvailable } from '../goalPlan/planAvailability';
import type { PlanRecovery } from '../goalPlan/planFailures';
import { useGoalPlanFlow } from '../goalPlan/useGoalPlanFlow';

/** The person's own records are facts already; only what was read from their words is asked about. */
const SELF_CONFIRMED_SOURCES: ReadonlySet<string> = new Set(['memory', 'commitment', 'behavior']);
/** At most this many "is this right?" cards at once, below the suggestions. */
export const MAX_CONFIRM_CARDS = 4;

/**
 * The actions the person confirms before they run (owner audit 2026-10-06,
 * image 8). «اقترح خطوات» is gone from this row: «اقترحلي خطة» opens the one
 * plan path instead (M3a, council condition 2), and needs no explanation step
 * of its own — its first screen, «هيك فهمت», is the check before anything runs.
 */
type PanelAction = 'analyze' | 'scan';
const ACTION_TEST_ID: Record<PanelAction, string> = {
  analyze: 'intelligence-analyze', scan: 'intelligence-gmail-scan',
};

const UNDERSTOOD_KEY = {
  goal: 'xIntelligenceUnderstoodGoal',
  intention: 'xIntelligenceUnderstoodIntention',
  request: 'xIntelligenceUnderstoodRequest',
  event: 'xIntelligenceUnderstoodEvent',
  commitment: 'xIntelligenceUnderstoodCommitment',
  preference: 'xIntelligenceUnderstoodPreference',
  constraint: 'xIntelligenceUnderstoodConstraint',
  opportunity: 'xIntelligenceUnderstoodOpportunity',
  outcome: 'xIntelligenceUnderstoodOutcome',
} as const satisfies Record<IntelligenceObservation['kind'], keyof Strings>;

/**
 * The proactive loop's review: evidence, suggestions, and the taps that decide
 * them. Every write needs a tap; nothing becomes a goal or a task without one.
 *
 * Shown in every environment when the server answers. Whether the loop is on
 * is the server's call — its gate, kill switch and consent — not the build's
 * (until 2026-10-03 a client-side `appEnv() === 'staging'` check hid it from
 * the production release the owner made on 2026-10-01). A loop that is off
 * (404 `feature_unavailable`) or refused (403 `consent_required`) is a state,
 * not an error: the panel steps aside, and `whenOff` says so where the screen
 * wants it said.
 *
 * `autoGenerate` (on «يتابع لك»): the inbox is read and shown first; then,
 * when the visit throttle allows (`visitThrottle.ts`), suggestions are asked
 * for as a visit in the background, and the inbox is read again only if that
 * brought something new.
 *
 * What it shows, review first: the waiting suggestions with their evidence,
 * then what was understood from the person's words and needs a yes or no
 * (never their own saved records), then the ways to tell it more.
 */
type IntelligencePanelProps = {
  onChanged: () => void;
  autoGenerate?: boolean;
  /** Embedded mode: shown when the loop is off, and a failed read offers Retry. */
  whenOff?: React.ReactNode;
};

/**
 * One panel per account. Its inbox, draft, answers and status are local
 * state; keyed by uid, a direct switch from one account to another mounts a
 * fresh panel, so not a frame of the first account's words is drawn for the
 * second, and the first account's reads in flight land on an unmounted panel
 * and are dropped (inspection A3-001; queryLayer's A→B invariant).
 */
export function IntelligencePanel(props: IntelligencePanelProps) {
  const uid = useOptionalAuth()?.user?.uid ?? '';
  // A new generation whenever a known account gives way to another (or to
  // signing out) — not when the first account becomes known, which would
  // read the inbox twice. Set during render, so the old panel never commits
  // a frame for the new account.
  const [account, setAccount] = React.useState({ uid, generation: 0 });
  if (uid !== account.uid) {
    setAccount({ uid, generation: account.uid ? account.generation + 1 : account.generation });
  }
  return <IntelligencePanelForAccount key={account.generation} {...props} />;
}

function IntelligencePanelForAccount({ onChanged, autoGenerate = false, whenOff }: IntelligencePanelProps) {
  const { t, tr, p, rtl, lang, actions } = useApp();
  // One row of three equal buttons at the ordinary sizes; at the larger text
  // sizes they wrap at their natural widths instead of squeezing the words.
  const actionStyle = useLayoutMode() === 'normal'
    ? { flexGrow: 1, flexBasis: 0, minWidth: 0, paddingHorizontal: 8 }
    : { paddingHorizontal: 14 };
  const uid = useOptionalAuth()?.user?.uid ?? '';
  const consents = useConsents();
  const recommendationsEnabled = consents.data?.recommendations.state === 'granted';
  const zone = useTimeZone();
  const planPathOn = usePlanPathAvailable();
  const plan = useGoalPlanFlow();
  const onPlanRecover = (recovery: PlanRecovery | 'open_today', detail: { currentGoalId?: string | undefined }) => {
    if (recovery === 'capture') return actions.go('capture');
    if (recovery === 'thoughts') return actions.go('seeds');
    if (recovery === 'open_today') return actions.go('today');
    if (recovery === 'open_new_goal' && detail.currentGoalId) return actions.openGoal(detail.currentGoalId);
    return plan.reset();
  };
  const [phase, setPhase] = React.useState<'loading' | 'ready' | 'off' | 'failed'>('loading');
  const [loadError, setLoadError] = React.useState<unknown>(null);
  const [inbox, setInbox] = React.useState<IntelligenceInbox | null>(null);
  const [draft, setDraft] = React.useState('');
  const [answers, setAnswers] = React.useState<Record<string, string>>({});
  const [editedTitles, setEditedTitles] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const [gmailScanProgress, setGmailScanProgress] = React.useState<number | null>(null);
  // Which action's one-line explanation is open, waiting for «كمّل».
  const [confirming, setConfirming] = React.useState<PanelAction | null>(null);
  // Opening an explanation moves a screen reader to it, so the person hears
  // what the action will do and finds «كمّل» next (inspection A2-004).
  React.useEffect(() => {
    if (confirming === null) return undefined;
    const timer = setTimeout(() => {
      if (explainRef.current) AccessibilityInfo.sendAccessibilityEvent(explainRef.current, 'focus');
    }, 50);
    return () => clearTimeout(timer);
  }, [confirming]);
  // False once the panel unmounts: a scan stops asking, and nothing more is said.
  const scanMounted = React.useRef(true);
  React.useEffect(() => {
    scanMounted.current = true;
    return () => { scanMounted.current = false; };
  }, []);
  // The statement as it was when its explanation opened; that is what is sent.
  const [snapshot, setSnapshot] = React.useState('');
  // Said aloud: only the start, the result and a failure — never per page.
  // The line sits in an always-mounted LiveRegion (TalkBack); VoiceOver is
  // told at the moment of each change, not from an effect, because a fast
  // answer lands in the same render as «started» and an effect would only
  // ever see the last of the two.
  // (`useAnnounceOnIos` is that effect, so it is not used here.) Nothing is
  // said once the panel has left the screen.
  const [announced, setAnnounced] = React.useState<string | null>(null);
  // `spoken` is what VoiceOver hears when it says more than the status line
  // (a result, then that the list could not refresh — the failure line itself
  // sits in the live region, which iOS does not read out).
  const say = React.useCallback((text: string | null, spoken?: string) => {
    if (!scanMounted.current) return;
    setAnnounced(text);
    const heard = spoken ?? text;
    if (heard && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(heard);
  }, []);
  // The action itself succeeded, but re-reading the inbox afterwards did not.
  const [refreshFailed, setRefreshFailed] = React.useState(false);
  // What a successful action will say once the inbox can be read again: a
  // count of new suggestions is only true of a list that is on screen.
  const pendingResult = React.useRef<((next: IntelligenceInbox) => string | null) | null>(null);
  // Where a screen reader goes when an action's explanation opens.
  const explainRef = React.useRef<View>(null);
  // React state lands a render later; two presses in one frame both see
  // `busy === false`. This ref is the guard that is set before either returns.
  const inFlight = React.useRef(false);
  const [gmailMonitor, setGmailMonitor] = React.useState<z.infer<typeof intelligenceGmailMonitorSchema> | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const read = React.useCallback(async () => {
    // The Gmail switch is one row of the panel; its failure must not take
    // the evidence and suggestions with it.
    const [next, monitor] = await Promise.all([getIntelligenceInbox(), getGmailIntelligenceMonitor().catch(() => null)]);
    return { next, monitor };
  }, []);
  const refresh = React.useCallback(async () => {
    const { next, monitor } = await read();
    setInbox(next);
    setGmailMonitor(monitor);
    setPhase('ready');
    return next;
  }, [read]);
  const load = React.useCallback((alive: () => boolean) => {
    void (async () => {
      try {
        const { next, monitor } = await read();
        if (!alive()) return;
        setInbox(next); setGmailMonitor(monitor); setPhase('ready');
      } catch (cause) {
        if (!alive()) return;
        // Off or refused is a state, not an error: nothing to retry.
        setLoadError(cause);
        setPhase(forbiddenReason(cause) !== null ? 'off' : 'failed');
      }
    })();
  }, [read]);
  React.useEffect(() => {
    let alive = true;
    load(() => alive);
    return () => { alive = false; };
  }, [load]);
  // The visit, once per mount, after the inbox is on screen and the account
  // is known; never on a loop that answered off.
  const visited = React.useRef(false);
  const shown = React.useRef<IntelligenceInbox | null>(null);
  React.useEffect(() => { shown.current = inbox; }, [inbox]);
  React.useEffect(() => {
    if (!autoGenerate || !uid || !recommendationsEnabled || phase !== 'ready' || visited.current) return undefined;
    visited.current = true;
    let alive = true;
    void (async () => {
      if (!(await claimVisit(uid))) return;
      try {
        const answer = await generateIntelligenceSuggestions({ visit: true });
        recordVisitAnswer(uid, answer.nextVisitAt);
        const known = new Set((shown.current?.suggestions ?? []).map(item => item.id));
        if (alive && answer.suggestions.some(item => item.status === 'pending' && !known.has(item.id))) await refresh();
      } catch (cause) {
        recordVisitFailure(uid, forbiddenReason(cause) !== null);
      }
    })();
    return () => { alive = false; };
  }, [autoGenerate, uid, recommendationsEnabled, phase, refresh]);
  // A decision on a card. The mutation decides success; a failed re-read of
  // the inbox afterwards is its own state, retried by re-reading only — never
  // by sending the decision again.
  const run = async (action: () => Promise<unknown>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    say(null);
    setRefreshFailed(false);
    pendingResult.current = null;
    try {
      try {
        await action();
      } catch (cause) {
        setError(cause);
        try { await refresh(); } catch { /* Keep the original action error visible. */ }
        return;
      }
      onChanged();
      try { await refresh(); } catch { setRefreshFailed(true); }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const openConfirm = (action: PanelAction) => {
    if (busy || inFlight.current) return;
    if (action === 'analyze') setSnapshot(draft.trim());
    // The field is locked now; a keyboard left open covered «كمّل» and
    // «إلغاء» at the largest text size (Codex simulator run, R-A4).
    Keyboard.dismiss();
    setConfirming(action);
  };

  // One of the three confirmed actions: says it started, runs it once, then
  // says what came of it.
  const runConfirmed = async (action: PanelAction) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setConfirming(null);
    setBusy(true);
    setError(null);
    setRefreshFailed(false);
    pendingResult.current = null;
    say(action === 'analyze' ? t.xIntelligenceAnalyzing : t.xIntelligenceGmailScanStarted);
    try {
      // Null when the result cannot be said truthfully: the refresh failed, so
      // nothing new is visible to point at.
      let result: (next: IntelligenceInbox | null) => string | null;
      try {
        if (action === 'analyze') {
          const sent = snapshot;
          const answer = await analyzeIntelligenceStatement(sent);
          // Cleared only if the field still holds what was sent.
          setDraft(current => (current.trim() === sent ? '' : current));
          if (answer.route === 'plan_flow') {
            // «ابنيلي خطة …» (M3A-032): the statement asked for a plan, so the
            // plan path opens on it, at its summary, without another tap.
            say(null);
            plan.fromStatement(sent, lang);
            return;
          }
          result = () => tr('xIntelligenceUnderstoodN', { n: answer.observations.length });
        } else {
          let status: 'running' | 'complete' | 'busy' = 'running';
          let visited = 0;
          setGmailScanProgress(0);
          while (scanMounted.current && status !== 'complete') {
            const answer = await scanGmailForIntelligence();
            status = answer.scan.status;
            visited = answer.scan.messagesVisited;
            if (scanMounted.current) setGmailScanProgress(visited);
            if (status === 'busy') await new Promise(resolve => setTimeout(resolve, 1500));
          }
          // Left the screen mid-scan: the scan is not done, so it is not said to be.
          if (status !== 'complete') return;
          result = () => tr('xIntelligenceGmailScanDone', { count: visited });
        }
      } catch (cause) {
        setError(cause);
        say(userFacingMessage(cause, t));
        try { await refresh(); } catch { /* Keep the action's own error visible. */ }
        return;
      }
      onChanged();
      let next: IntelligenceInbox | null = null;
      let refreshed = true;
      try { next = await refresh(); } catch { setRefreshFailed(true); refreshed = false; }
      const said = result(next);
      if (said === null) {
        // Nothing true to count yet: the failure line (inside the live
        // region) says why, and a successful retry says the result.
        pendingResult.current = result;
        say(null);
        if (Platform.OS === 'ios' && scanMounted.current) AccessibilityInfo.announceForAccessibility(t.xIntelligenceRefreshFailed);
      } else {
        say(said, refreshed ? undefined : `${said} ${t.xIntelligenceRefreshFailed}`);
      }
    } finally {
      inFlight.current = false;
      setGmailScanProgress(null);
      setBusy(false);
    }
  };

  const retryRefresh = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const next = await refresh();
      setRefreshFailed(false);
      const pending = pendingResult.current;
      pendingResult.current = null;
      if (pending) say(pending(next));
    } catch { /* Still failing: the line stays. */ } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  if (phase === 'off') return whenOff === undefined ? null : <>{whenOff}</>;
  if (whenOff !== undefined && phase !== 'ready') {
    return <QueryBoundary isPending={phase === 'loading'} error={phase === 'failed' ? loadError : null} onRetry={() => { setPhase('loading'); load(() => true); }}>{null}</QueryBoundary>;
  }
  if (phase !== 'ready' || !inbox) return null;
  const evidence = new Map(inbox.observations.map(item => [item.id, item.evidence]));
  const schedule = new Map(inbox.schedule.map(item => [item.suggestionId, item]));
  return <ProductSection title={t.xIntelligenceTitle} why={{ id: 'intelligence-panel', body: t.xIntelligenceBody }} icon="goal">
    {error && announced === null ? <Txt role="supporting" color={p.wm}>{userFacingMessage(error, t)}</Txt> : null}
    {recommendationsEnabled && inbox.suggestions.filter(item => item.status === 'pending').length === 0
      ? <Txt role="supporting">{t.xIntelligenceNoIdeas}</Txt> : null}
    {recommendationsEnabled && inbox.suggestions.filter(item => item.status === 'pending').map(item => <View key={item.id} testID={`intelligence-suggestion-${item.id}`}>
      <Txt role="body">{isolateAuto(item.title)}</Txt>
      <Txt role="supporting">{isolateAuto(item.reason)}</Txt>
      {(item.kind === 'action' || item.kind === 'goal') ? <TextInput
        testID={`intelligence-edit-${item.id}`}
        accessibilityLabel={t.xIntelligenceEditTitle}
        value={editedTitles[item.id] ?? ''}
        onChangeText={value => setEditedTitles(current => ({ ...current, [item.id]: value }))}
        placeholder={item.title}
        placeholderTextColor={p.mu}
        maxLength={100}
        style={{ color: p.tx, backgroundColor: p.bg, padding: 12, borderRadius: 12, fontSize: 16, textAlign: rtl ? 'right' : 'left' }}
      /> : null}
      <Txt role="supporting">{fill(t.xIntelligenceEvidence, { evidence: item.observationIds.map(id => evidence.get(id) ?? '').filter(Boolean).map(isolateAuto).join(' · ') })}</Txt>
      {item.kind === 'action' && schedule.get(item.id)?.slot ? <Txt role="supporting">{fill(t.xIntelligenceSlot, {
        date: formatDate(new Date(schedule.get(item.id)!.slot!.startsAt), 'short', { locale: lang, timeZone: zone }),
        time: ltr(formatTime(new Date(schedule.get(item.id)!.slot!.startsAt), { locale: lang, timeZone: zone })),
      })}</Txt> : null}
      {item.kind === 'action' && schedule.get(item.id) && !schedule.get(item.id)?.slot
        ? <Txt role="supporting">{t.xIntelligenceNoSlot}</Txt> : null}
      {item.kind === 'question' ? <TextInput
        testID={`intelligence-answer-${item.id}`}
        accessibilityLabel={item.title}
        value={answers[item.id] ?? ''}
        onChangeText={value => setAnswers(current => ({ ...current, [item.id]: value }))}
        placeholder={t.xIntelligenceAnswerPlaceholder}
        placeholderTextColor={p.mu}
        maxLength={500}
        multiline
        style={{ color: p.tx, backgroundColor: p.bg, padding: 12, minHeight: 48, borderRadius: 12, textAlign: rtl ? 'right' : 'left' }}
      /> : null}
      <View style={{ flexDirection: rtl ? 'row-reverse' : 'row', gap: 8 }}>
        <Pill label={item.kind === 'question' ? t.xIntelligenceAnswer : item.kind === 'warning' ? t.xIntelligenceAcknowledge : t.xIntelligenceAccept}
          disabled={busy || (item.kind === 'question' && !(answers[item.id] ?? '').trim())}
          onPress={() => void run(() => item.kind === 'question'
            ? answerIntelligenceQuestion(item.id, (answers[item.id] ?? '').trim())
            : decideIntelligenceSuggestion(item.id, 'accept', (editedTitles[item.id] ?? '').trim() || undefined,
              item.kind === 'action' ? schedule.get(item.id)?.slot ?? undefined : undefined))} />
        <Pill label={t.xIntelligenceDismiss} kind="outline" disabled={busy} onPress={() => void run(() => decideIntelligenceSuggestion(item.id, 'dismiss'))} />
      </View>
      {item.kind !== 'question' ? <Txt role="supporting" color={p.mu}>{t.suggestionNote}</Txt> : null}
    </View>)}
    {inbox.observations.filter(item => item.review === 'pending' && !SELF_CONFIRMED_SOURCES.has(item.source)).slice(0, MAX_CONFIRM_CARDS).map(item => <View key={item.id} testID={`intelligence-observation-${item.id}`}>
      <Txt role="supporting">{fill(t[UNDERSTOOD_KEY[item.kind]], { evidence: isolateAuto(item.evidence) })}</Txt>
      <View style={{ flexDirection: rtl ? 'row-reverse' : 'row', gap: 8 }}>
        <Pill label={t.xIntelligenceConfirm} disabled={busy} onPress={() => void run(() => reviewIntelligenceObservation(item.id, 'confirmed'))} />
        <Pill label={t.xIntelligenceDismiss} kind="outline" disabled={busy} onPress={() => void run(() => reviewIntelligenceObservation(item.id, 'dismissed'))} />
      </View>
    </View>)}
    <TextInput
      testID="intelligence-statement"
      accessibilityLabel={t.xIntelligenceTitle}
      value={draft}
      onChangeText={setDraft}
      editable={!busy && confirming === null}
      placeholder={t.xIntelligencePlaceholder}
      placeholderTextColor={p.mu}
      maxLength={2000}
      multiline
      style={{ color: p.tx, backgroundColor: p.bg, padding: 14, minHeight: 60, borderRadius: 14, fontSize: 17, textAlign: rtl ? 'right' : 'left' }}
    />
    {/* Three small actions in a row, each named for what it does. A press
        opens a one-line explanation; only «كمّل» runs it. */}
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      <Pill style={actionStyle} testID={ACTION_TEST_ID.analyze} label={t.xIntelligenceAnalyze} size={13} pad={10} kind={confirming === 'analyze' ? 'accent' : 'outline'} expanded={confirming === 'analyze'}
        disabled={busy || !draft.trim()} onPress={() => openConfirm('analyze')} />
      {planPathOn ? <Pill style={actionStyle} testID="intelligence-plan-flow" label={t.xPlanFromStatement} size={13} pad={10} kind="outline"
        disabled={busy || plan.state.busy || !draft.trim()} onPress={() => {
          Keyboard.dismiss();
          setConfirming(null);
          plan.fromStatement(draft.trim(), lang);
        }} /> : null}
      <Pill style={actionStyle} testID={ACTION_TEST_ID.scan} label={t.xIntelligenceGmailScan} size={13} pad={10} kind={confirming === 'scan' ? 'accent' : 'outline'} expanded={confirming === 'scan'}
        disabled={busy} onPress={() => openConfirm('scan')} />
    </View>
    {confirming ? <View testID="intelligence-confirm" style={{ gap: 10, backgroundColor: p.sf2, borderRadius: 14, padding: 12 }}>
      <View ref={explainRef} accessible testID="intelligence-confirm-explain"><Txt role="supporting">{confirming === 'analyze' ? t.xIntelligenceAnalyzeExplain : t.xIntelligenceGmailScanExplain}</Txt></View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Pill testID={`${ACTION_TEST_ID[confirming]}-confirm`} label={t.xIntelligenceRun} size={14} pad={12} disabled={busy}
          onPress={() => void runConfirmed(confirming)} />
        <Pill testID={`${ACTION_TEST_ID[confirming]}-cancel`} label={t.cancel} kind="outline" size={14} pad={12}
          onPress={() => setConfirming(null)} />
      </View>
    </View> : null}
    {/* One region for what the panel says: the status, and a failed refresh
        with its retry — said once, never repeated in a second line. */}
    <LiveRegion testID="intelligence-status">
      {announced || refreshFailed ? <View style={{ gap: 8 }}>
      {announced ? <Txt role="supporting" testID="intelligence-status-text">{announced}</Txt> : null}
      {refreshFailed ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <Txt role="supporting" color={p.wm} testID="intelligence-refresh-failed">{t.xIntelligenceRefreshFailed}</Txt>
        <Pill testID="intelligence-refresh-retry" label={t.errorsRetry} kind="outline" size={14} pad={12} disabled={busy} onPress={() => void retryRefresh()} />
      </View> : null}
      </View> : null}
    </LiveRegion>
    {plan.state.stage.kind !== 'idle' || plan.state.busy || plan.state.error ? <PlanFlowView flow={plan} onRecover={onPlanRecover} /> : null}
    {gmailScanProgress !== null && gmailScanProgress > 0
      ? <Txt role="supporting" color={p.mu} testID="intelligence-gmail-progress">{tr('xIntelligenceGmailScanProgress', { count: gmailScanProgress })}</Txt> : null}
    <Disclosure id="intelligence-gmail-monitor-info" body={t.xIntelligenceGmailMonitorInfo} label={gmailMonitor?.enabled ? t.xIntelligenceGmailMonitorOff : t.xIntelligenceGmailMonitorOn}>
      <Pill testID="intelligence-gmail-monitor" label={gmailMonitor?.enabled ? t.xIntelligenceGmailMonitorOff : t.xIntelligenceGmailMonitorOn}
        kind="outline" disabled={busy || gmailMonitor === null} onPress={() => void run(() => setGmailIntelligenceMonitor(!gmailMonitor?.enabled))} />
    </Disclosure>
    {gmailMonitor?.error ? <Txt role="supporting" color={p.wm}>{t.xIntelligenceGmailMonitorError}</Txt> : null}
  </ProductSection>;
}
