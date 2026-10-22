import React from 'react';
import { AccessibilityInfo, Keyboard, Platform, TextInput, View } from 'react-native';
import {
  analyzeIntelligenceStatement, decideIntelligenceSuggestion,
  generateIntelligenceSuggestions, getIntelligenceInbox, reviewIntelligenceObservation,
  scanGmailForIntelligence,
  answerIntelligenceQuestion,
  getGmailIntelligenceMonitor, setGmailIntelligenceMonitor,
} from '../../api/endpoints/intelligence';
import type { IntelligenceInbox, IntelligenceObservation, IntelligenceSuggestion } from '../../api/schemas/intelligence';
import type { MemoryItem } from '../../api/schemas/profile';
import { SuggestionUnavailableError } from '../../api/errors';
import { basisClassVisible, useBasisStamp, useSuggestionBasisSignals, type BasisClass } from '../m5b/suggestionBasis';
import type { z } from 'zod';
import { intelligenceGmailMonitorSchema } from '../../api/schemas/intelligence';
import { forbiddenReason, userFacingMessage } from '../../api/ui/userFacingMessage';
import { fill, ltr } from '../../i18n/strings';
import { formatDate, formatTime } from '../../i18n/format';
import { deviceTimeZone, useTimeZone } from '../../i18n/timezone';
import { useApp } from '../../state/AppContext';
import { Btn, Pill, Txt } from '../../ui/primitives';
import { ReferenceIcon } from '../../ui/referenceIcons';
import { useFreshM5bOn, useM5bOn } from '../m5b/capabilities';
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
import { M5A_NOT_NOW, useFreshM5aCapability, useM5aCapabilities } from '../m5a/capabilities';
import { EmailScanEntry, EmailScanStatus, WaitLine, useEmailScanOverview } from '../m5a/emailScan';
import { AddedCard } from '../m5a/AddedCard';
import { postEmailScan } from '../../api/endpoints/m5a';
import { loadMonitorUpgradeDismissed, saveMonitorUpgradeDismissed } from '../../lib/deviceSettings/m5aNotices';

/** What the panel can do for a plan failure (inspection A-009); «ارجع للأهداف» closes the flow, because the goals are right here. */
/** A day, for the backfill offer's «not while a scan of the last day exists». */
const DAY_MS = 24 * 60 * 60_000;

const PANEL_RECOVERIES: readonly PlanRecovery[] = ['capture', 'thoughts', 'see_saved', 'open_new_goal', 'back_to_goals'];

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
    // What was saved lives on the goal the statement became.
    if (recovery === 'see_saved' && plan.state.goalId) return actions.openGoal(plan.state.goalId);
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
  // M5b-2a (R1): «شو تعلّمت من اللي عملته» — the person's own tapped outcomes,
  // each with «مش صحيح». Shown only when M5b is known to be on.
  const m5bOn = useM5bOn();
  const freshM5b = useFreshM5bOn();
  const [learnedOpen, setLearnedOpen] = React.useState(false);
  // What the panel's one live region says after a dismissal; the region is
  // always mounted, so it outlives the card when its last row leaves (M5B2A-009).
  const [learnedStatus, setLearnedStatus] = React.useState<string | null>(null);
  // What a successful action will say once the inbox can be read again: a
  // count of new suggestions is only true of a list that is on screen.
  const pendingResult = React.useRef<((next: IntelligenceInbox) => string | null) | null>(null);
  // Where a screen reader goes when an action's explanation opens.
  const explainRef = React.useRef<View>(null);
  // React state lands a render later; two presses in one frame both see
  // `busy === false`. This ref is the guard that is set before either returns.
  const inFlight = React.useRef(false);
  const backfillAnswering = React.useRef(false);
  const [gmailMonitor, setGmailMonitor] = React.useState<z.infer<typeof intelligenceGmailMonitorSchema> | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  // M5a (R2.3, R4.1): one email scan shared with the Google screen, and
  // monitoring that says what it reads. Unknown or off is today's panel.
  const emailM5 = useM5aCapabilities()?.emailSources === true;
  const freshCapability = useFreshM5aCapability();
  const scanOverview = useEmailScanOverview(emailM5);
  const [monitorInfo, setMonitorInfo] = React.useState(false);
  const [backfillOffer, setBackfillOffer] = React.useState(false);
  const [upgradeDismissed, setUpgradeDismissed] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    if (!uid) return undefined;
    let alive = true;
    void loadMonitorUpgradeDismissed(uid).then((dismissed) => { if (alive) setUpgradeDismissed(dismissed); });
    return () => { alive = false; };
  }, [uid]);
  // Every call the panel makes carries the account it was opened for
  // (M5B2A-R14-001).
  const bound = React.useMemo(() => (uid ? { asUid: uid } : {}), [uid]);
  // The reads take it when they run, so the account arriving after the first
  // render does not read the inbox a second time.
  const readUid = React.useRef(uid);
  React.useEffect(() => { readUid.current = uid; });
  // M5b-2b-1 (R13-001): each answer is held with the mode it was filtered
  // under and the capability it was read under, and drawn only while that
  // classification allows.
  const { stamp, classify } = useBasisStamp();
  const [basis, setBasis] = React.useState<BasisClass | null>(null);
  const lastReadStart = React.useRef(0);
  const read = React.useCallback(async () => {
    const asOf = readUid.current ? { asUid: readUid.current } : {};
    const at = stamp();
    lastReadStart.current = Math.max(lastReadStart.current, at.startedAt);
    // The Gmail switch is one row of the panel; its failure must not take
    // the evidence and suggestions with it.
    const [next, monitor] = await Promise.all([getIntelligenceInbox(asOf), getGmailIntelligenceMonitor(asOf).catch(() => null)]);
    return { next, monitor, cls: classify(next, at) };
  }, [stamp, classify]);
  // Only the newest read is applied (M5B2A-R28-004): a background read that
  // started before «مش صحيح» and answers after the dismissal's own read would
  // otherwise put the dismissed outcome, and what cites it, back on screen.
  const readSeq = React.useRef(0);
  const refresh = React.useCallback(async () => {
    const seq = ++readSeq.current;
    const { next, monitor, cls } = await read();
    if (seq !== readSeq.current) return next;
    setInbox(next);
    setBasis(cls);
    setGmailMonitor(monitor);
    setPhase('ready');
    return next;
  }, [read]);
  const load = React.useCallback((alive: () => boolean) => {
    void (async () => {
      const seq = ++readSeq.current;
      try {
        const { next, monitor, cls } = await read();
        if (!alive() || seq !== readSeq.current) return;
        setInbox(next); setBasis(cls); setGmailMonitor(monitor); setPhase('ready');
      } catch (cause) {
        // A failure only counts for the newest read, as an answer does (R29-004).
        if (!alive() || seq !== readSeq.current) return;
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
  // What is held when a read that had to check it failed (M5b-2b-1): the
  // suggestions and their schedule go, and so does the classification, so
  // nothing — not even «no ideas» — is claimed until an inbox answers again
  // (R9-001, APP-003). The failed-refresh line offers the retry.
  const failClosed = React.useCallback(() => {
    setInbox(current => (current ? { ...current, suggestions: [], schedule: [] } : current));
    setBasis(null);
    setRefreshFailed(true);
  }, []);
  // A read asked for by a signal, not a tap (M5b-2b-1: a memory write, the
  // memory list settling, a capability transition). Only the newest read
  // lands; if it fails, the suggestions it would have checked are cleared
  // rather than left standing unverified.
  const signalReread = React.useCallback(() => {
    void (async () => {
      const seq = ++readSeq.current;
      try {
        const { next, monitor, cls } = await read();
        if (!scanMounted.current || seq !== readSeq.current) return;
        setInbox(next); setBasis(cls); setGmailMonitor(monitor); setRefreshFailed(false);
      } catch {
        if (!scanMounted.current || seq !== readSeq.current) return;
        failClosed();
      }
    })();
  }, [read, failClosed]);
  const m5bReady = phase === 'ready' && inbox !== null;
  const holding = inbox?.suggestions.some(item => item.status === 'pending') === true;
  const signals = useSuggestionBasisSignals({
    held: basis,
    ready: m5bReady,
    holding,
    // Watched only while pending suggestions filtered under on_basis are
    // held (APP-004): the basis line quotes only a list fetched since mount,
    // and a mode or fence change can change what may stand while the list
    // stays the same (R10-002). An empty holder polls nothing; memory writes
    // and capability transitions still reach it.
    watchList: m5bOn === true && basis?.mode === 'on_basis' && holding,
    lastReadStart: () => lastReadStart.current,
    reread: signalReread,
  });

  // The visit, once per mount, after the inbox is on screen and the account
  // is known; never on a loop that answered off.
  const visited = React.useRef(false);
  const shown = React.useRef<{ inbox: IntelligenceInbox | null; basis: BasisClass | null }>({ inbox: null, basis: null });
  React.useEffect(() => { shown.current = { inbox, basis }; }, [inbox, basis]);
  React.useEffect(() => {
    if (!autoGenerate || !uid || !recommendationsEnabled || phase !== 'ready' || visited.current) return undefined;
    visited.current = true;
    let alive = true;
    void (async () => {
      if (!(await claimVisit(uid))) return;
      try {
        const answer = await generateIntelligenceSuggestions({ visit: true, ...bound });
        recordVisitAnswer(uid, answer.nextVisitAt);
        // Read again when the visit's answer differs from what is held in
        // anything drawn (M5b-2b-1, APP-001): a suggestion keeps its id when
        // its basis or mode changes, or when a row of another mode replaces
        // it, so a new id is not the only sign that what is held went stale.
        // A visit that changed nothing still costs no second read.
        const held = shown.current;
        if (alive && (!held.inbox || visitSignature(answer.suggestions, answer.schedule, answer.basisMode ?? null)
          !== visitSignature(held.inbox.suggestions, held.inbox.schedule, held.basis?.mode ?? null))) await refresh();
      } catch (cause) {
        recordVisitFailure(uid, forbiddenReason(cause) !== null);
      }
    })();
    return () => { alive = false; };
  }, [autoGenerate, uid, recommendationsEnabled, phase, refresh, bound]);
  // A decision on a card. The mutation decides success; a failed re-read of
  // the inbox afterwards is its own state, retried by re-reading only — never
  // by sending the decision again.
  const run = async (action: () => Promise<unknown>, suggestionId?: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    say(null);
    // One action's status at a time in the panel's region (M5B2A-R4-002).
    setLearnedStatus(null);
    setRefreshFailed(false);
    pendingResult.current = null;
    try {
      try {
        await action();
      } catch (cause) {
        // M5b-2b-1 (R4-003): the suggestion can no longer be acted on (the
        // memory mode changed, or a memory that shaped it went). Not an error
        // to show or say: the inbox is read again and the card leaves.
        // The card and its schedule leave at once (APP-002); the read after
        // it can only replace them, and if it fails, nothing held is left
        // standing unverified.
        if (cause instanceof SuggestionUnavailableError) {
          if (suggestionId !== undefined) {
            setInbox(current => (current ? {
              ...current,
              suggestions: current.suggestions.filter(item => item.id !== suggestionId),
              schedule: current.schedule.filter(item => item.suggestionId !== suggestionId),
            } : current));
          }
          try { await refresh(); } catch { failClosed(); }
          return;
        }
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

  // «مش صحيح» on a tapped outcome (R1, M5B2A-008): asked fresh first, and
  // counted only when the server answers that the outcome is dismissed.
  const dismissOutcome = async (id: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setLearnedStatus(null);
    // …and the previous action's result, retry and pending count leave the
    // region with it (M5B2A-R4-002).
    say(null);
    setRefreshFailed(false);
    pendingResult.current = null;
    try {
      if (await freshM5b() !== true) return;
      let answer;
      try {
        answer = await reviewIntelligenceObservation(id, 'dismissed', bound);
      } catch (cause) {
        setError(cause);
        try { await refresh(); } catch { /* Keep the original error visible. */ }
        return;
      }
      if (answer.observation.review !== 'dismissed') {
        // Turned off after this was drawn: nothing was learned away. The
        // switch and the list are read again, and nothing is announced.
        void freshM5b();
        try { await refresh(); } catch { setRefreshFailed(true); }
        return;
      }
      // Nothing is said once the panel has left the screen (as `say`).
      if (!scanMounted.current) return;
      // The server's answer is the outcome now: the row leaves at once, even
      // if the re-read below fails (M5B2A-REV-003).
      const dismissed = answer.observation;
      setInbox(current => current
        ? { ...current, observations: current.observations.map(item => (item.id === dismissed.id ? dismissed : item)) }
        : current);
      setLearnedStatus(t.m5bLearnedWrongDone);
      if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(t.m5bLearnedWrongDone);
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
    setLearnedStatus(null);
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
          const answer = await analyzeIntelligenceStatement(sent, bound);
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
            const answer = await scanGmailForIntelligence(bound);
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

  // «شغّل المراقبة» on M5a: what it reads is said first, and only «كمّل»
  // enrols it (M5A-R4-001); then the last seven days are offered, never
  // assumed (condition 32).
  const monitorWait = emailM5 ? gmailMonitor?.waiting ?? null : null;
  const enableMonitorM5 = async () => {
    setMonitorInfo(false);
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setLearnedStatus(null);
    try {
      // Asked fresh right before enrolling (M5A-R10-001).
      if (await freshCapability('emailSources') !== true) {
        setError(M5A_NOT_NOW());
        return;
      }
      setGmailMonitor(await setGmailIntelligenceMonitor(true, { timezone: deviceTimeZone() }, bound));
      // Not offered while a scan of the last day exists or was accepted (R4.1),
      // and only from a fresh, successful answer (M5A-R7-003): loading or
      // failed is unknown, and unknown offers nothing.
      const fresh = await scanOverview.refetch();
      if (fresh.isSuccess && fresh.data) {
        const within = (at: string | null | undefined) => typeof at === 'string' && Date.now() - Date.parse(at) < DAY_MS;
        const recentScan = within(fresh.data.manual?.startedAt) || within(fresh.data.queuedManual?.acceptedAt);
        if (!recentScan) setBackfillOffer(true);
      }
    } catch (cause) {
      setError(cause);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const answerBackfill = async (yes: boolean) => {
    // One answer per offer (M5A-R6-004): a double press asks for one scan.
    if (backfillAnswering.current) return;
    setBackfillOffer(false);
    if (!yes) return;
    backfillAnswering.current = true;
    try {
      if (await freshCapability('emailSources') !== true) {
        setError(M5A_NOT_NOW());
        return;
      }
      await postEmailScan({ intent: 'new', origin: 'backfill', timezone: deviceTimeZone() }, { asUid: uid });
    } catch (cause) {
      setError(cause);
    } finally {
      backfillAnswering.current = false;
      void scanOverview.refetch();
    }
  };
  // The one-time upgrade for a monitor that was on before M5a (M5A-R35-004):
  // yes enrols it as it is; no is remembered for this account on this phone.
  const answerUpgrade = async (yes: boolean) => {
    if (!yes) {
      setUpgradeDismissed(true);
      if (uid) await saveMonitorUpgradeDismissed(uid, new Date());
      return;
    }
    await run(async () => {
      if (await freshCapability('emailSources') !== true) throw M5A_NOT_NOW();
      return setGmailIntelligenceMonitor(true, { timezone: deviceTimeZone() }, bound);
    });
  };
  // The monitor switch chooses between the M5a enrolment (its information
  // first) and the legacy toggle; the choice is made on a fresh answer
  // (M5A-R10-001), and an unknown answer takes neither.
  const pressMonitor = async () => {
    if (gmailMonitor?.enabled) {
      void run(() => setGmailIntelligenceMonitor(false, undefined, bound));
      return;
    }
    const m5 = await freshCapability('emailSources');
    if (m5 === null) {
      setError(M5A_NOT_NOW());
      return;
    }
    if (m5) setMonitorInfo(true);
    else void run(() => setGmailIntelligenceMonitor(true, undefined, bound));
  };
  // A daily sweep held for want of a time zone: an enabled monitor sends the
  // phone's again, once per visit (M5A-R35-004).
  const timezoneResent = React.useRef(false);
  const heldForZone = emailM5 && gmailMonitor?.enabled === true && scanOverview.data?.daily?.status === 'held';
  React.useEffect(() => {
    if (!heldForZone || timezoneResent.current) return;
    timezoneResent.current = true;
    void setGmailIntelligenceMonitor(true, { timezone: deviceTimeZone() }, bound)
      .then((next) => { setGmailMonitor(next); void scanOverview.refetch(); })
      .catch(() => undefined);
  }, [heldForZone, scanOverview, bound]);

  if (phase === 'off') return whenOff === undefined ? null : <>{whenOff}</>;
  if (whenOff !== undefined && phase !== 'ready') {
    return <QueryBoundary isPending={phase === 'loading'} error={phase === 'failed' ? loadError : null} onRetry={() => { setPhase('loading'); load(() => true); }}>{null}</QueryBoundary>;
  }
  if (phase !== 'ready' || !inbox) return null;
  const evidence = new Map(inbox.observations.map(item => [item.id, item.evidence]));
  // M5b-2b-1 (R13-001): a response whose classification does not allow it
  // now draws no suggestion and no schedule row — and no «no ideas» line
  // either, which would not be true of what is held.
  // A card that cites a memory waits for the memory list fetched since mount
  // (answered or failed), so its basis line arrives with it, not after it.
  const awaitingList = basis?.mode === 'on_basis' && signals.capNow === true && !signals.listSettled
    && inbox.suggestions.some(item => item.status === 'pending' && (item.memoryBasis?.length ?? 0) > 0);
  const suggestionsShown = basisClassVisible(basis, signals.capNow) && !awaitingList;
  const schedule = new Map(suggestionsShown ? inbox.schedule.map(item => [item.suggestionId, item]) : []);
  const pending = suggestionsShown ? inbox.suggestions.filter(item => item.status === 'pending') : [];
  return <><ProductSection title={t.xIntelligenceTitle} why={{ id: 'intelligence-panel', body: t.xIntelligenceBody }} icon="goal">
    {error && announced === null ? <Txt role="supporting" color={p.wm} testID="m5b-suggestion-action-error">{userFacingMessage(error, t)}</Txt> : null}
    {recommendationsEnabled && suggestionsShown && pending.length === 0
      ? <Txt role="supporting">{t.xIntelligenceNoIdeas}</Txt> : null}
    {recommendationsEnabled && pending.map(item => <View key={item.id} testID={`intelligence-suggestion-${item.id}`}>
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
      {item.kind === 'action' && schedule.get(item.id)?.slot ? <Txt role="supporting" testID={`m5b-suggestion-schedule-${item.id}`}>{fill(t.xIntelligenceSlot, {
        date: formatDate(new Date(schedule.get(item.id)!.slot!.startsAt), 'short', { locale: lang, timeZone: zone }),
        time: ltr(formatTime(new Date(schedule.get(item.id)!.slot!.startsAt), { locale: lang, timeZone: zone })),
      })}</Txt> : null}
      {item.kind === 'action' && schedule.get(item.id) && !schedule.get(item.id)?.slot
        ? <Txt role="supporting" testID={`m5b-suggestion-schedule-${item.id}`}>{t.xIntelligenceNoSlot}</Txt> : null}
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
            ? answerIntelligenceQuestion(item.id, (answers[item.id] ?? '').trim(), bound)
            : decideIntelligenceSuggestion(item.id, 'accept', (editedTitles[item.id] ?? '').trim() || undefined,
              item.kind === 'action' ? schedule.get(item.id)?.slot ?? undefined : undefined, bound), item.id)} />
        <Pill label={t.xIntelligenceDismiss} kind="outline" disabled={busy} onPress={() => void run(() => decideIntelligenceSuggestion(item.id, 'dismiss', undefined, undefined, bound), item.id)} />
      </View>
      {item.kind !== 'question' ? <Txt role="supporting" color={p.mu}>{t.suggestionNote}</Txt> : null}
      {/* M5b-2b-1 (R3): which remembered fact shaped it, and the way to
          correct that fact. After the decision row, so the card's own
          actions keep their place. */}
      {m5bOn === true && basis ? <SuggestionBasis
        suggestion={item}
        items={signals.freshItems}
        hidden={memoryId => signals.basisHidden(memoryId, basis.startedAt)}
        onFix={memoryId => actions.openMemoryFocused(memoryId)}
      /> : null}
    </View>)}
    {inbox.observations.filter(item => item.review === 'pending' && !SELF_CONFIRMED_SOURCES.has(item.source)).slice(0, MAX_CONFIRM_CARDS).map(item => <View key={item.id} testID={`intelligence-observation-${item.id}`}>
      <Txt role="supporting">{fill(t[UNDERSTOOD_KEY[item.kind]], { evidence: isolateAuto(item.evidence) })}</Txt>
      <View style={{ flexDirection: rtl ? 'row-reverse' : 'row', gap: 8 }}>
        <Pill label={t.xIntelligenceConfirm} disabled={busy} onPress={() => void run(() => reviewIntelligenceObservation(item.id, 'confirmed', bound))} />
        <Pill label={t.xIntelligenceDismiss} kind="outline" disabled={busy} onPress={() => void run(() => reviewIntelligenceObservation(item.id, 'dismissed', bound))} />
      </View>
    </View>)}
    {m5bOn === true ? <LearnedOutcomes
      observations={inbox.observations}
      open={learnedOpen}
      onToggle={() => setLearnedOpen(value => !value)}
      busy={busy}
      onWrong={(id) => void dismissOutcome(id)}
    /> : null}
    <TextInput
      testID="intelligence-statement"
      accessibilityLabel={t.xIntelligenceTitle}
      value={draft}
      onChangeText={setDraft}
      editable={!busy && !plan.state.busy && confirming === null}
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
        disabled={busy || plan.state.busy || !draft.trim()} onPress={() => openConfirm('analyze')} />
      {planPathOn ? <Pill style={actionStyle} testID="intelligence-plan-flow" label={t.xPlanFromStatement} size={13} pad={10} kind="outline"
        disabled={busy || plan.state.busy || !draft.trim()} onPress={() => {
          Keyboard.dismiss();
          setConfirming(null);
          plan.fromStatement(draft.trim(), lang);
        }} /> : null}
      {emailM5 ? null : <Pill style={actionStyle} testID={ACTION_TEST_ID.scan} label={t.xIntelligenceGmailScan} size={13} pad={10} kind={confirming === 'scan' ? 'accent' : 'outline'} expanded={confirming === 'scan'}
        disabled={busy} onPress={() => openConfirm('scan')} />}
    </View>
    {emailM5 ? <EmailScanEntry /> : null}
    {emailM5 ? <EmailScanStatus overview={scanOverview.data} onReconnect={() => actions.go('googleIntegration')} /> : null}
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
      {/* The monitor's quota wait is said here too, in the panel's one region (R4.1). */}
      {announced || refreshFailed || monitorWait || learnedStatus ? <View style={{ gap: 8 }}>
      {monitorWait ? <WaitLine wait={monitorWait} /> : null}
      {/* M5b-2a: what «مش صحيح» did, said in the panel's one region, which
          outlives the learned card (M5B2A-009). */}
      {learnedStatus ? <Txt role="supporting" testID="m5b-learned-status">{learnedStatus}</Txt> : null}
      {announced ? <Txt role="supporting" testID="intelligence-status-text">{announced}</Txt> : null}
      {refreshFailed ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <Txt role="supporting" color={p.wm} testID="intelligence-refresh-failed">{t.xIntelligenceRefreshFailed}</Txt>
        <Pill testID="intelligence-refresh-retry" label={t.errorsRetry} kind="outline" size={14} pad={12} disabled={busy} onPress={() => void retryRefresh()} />
      </View> : null}
      </View> : null}
    </LiveRegion>
    {plan.state.stage.kind !== 'idle' || plan.state.busy || plan.state.error ? <PlanFlowView flow={plan} onRecover={onPlanRecover} hostRecoveries={PANEL_RECOVERIES} /> : null}
    {gmailScanProgress !== null && gmailScanProgress > 0
      ? <Txt role="supporting" color={p.mu} testID="intelligence-gmail-progress">{tr('xIntelligenceGmailScanProgress', { count: gmailScanProgress })}</Txt> : null}
    <Disclosure id="intelligence-gmail-monitor-info" body={emailM5 ? t.m5MonitorInfo : t.xIntelligenceGmailMonitorInfo} label={gmailMonitor?.enabled ? t.xIntelligenceGmailMonitorOff : t.xIntelligenceGmailMonitorOn}>
      <Pill testID="intelligence-gmail-monitor" label={gmailMonitor?.enabled ? t.xIntelligenceGmailMonitorOff : t.xIntelligenceGmailMonitorOn}
        kind="outline" disabled={busy || gmailMonitor === null}
        onPress={() => void pressMonitor()} />
    </Disclosure>
    {monitorInfo ? <View testID="monitor-info" style={{ gap: 10, backgroundColor: p.sf2, borderRadius: 14, padding: 12 }}>
      <Txt role="supporting">{t.m5MonitorInfo}</Txt>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Pill testID="monitor-info-confirm" label={t.xIntelligenceRun} size={14} pad={12} disabled={busy} onPress={() => void enableMonitorM5()} />
        <Pill testID="monitor-info-cancel" label={t.cancel} kind="outline" size={14} pad={12} onPress={() => setMonitorInfo(false)} />
      </View>
    </View> : null}
    {backfillOffer ? <View testID="backfill-offer" style={{ gap: 10, backgroundColor: p.sf2, borderRadius: 14, padding: 12 }}>
      <Txt role="supporting">{t.m5BackfillAsk}</Txt>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Pill testID="backfill-yes" label={t.m5BackfillYes} size={14} pad={12} onPress={() => void answerBackfill(true)} />
        <Pill testID="backfill-no" label={t.m5BackfillNo} kind="outline" size={14} pad={12} onPress={() => void answerBackfill(false)} />
      </View>
    </View> : null}
    {emailM5 && gmailMonitor?.enabled && gmailMonitor.m5Enrolled === false && upgradeDismissed === false
      ? <View testID="monitor-upgrade-notice" style={{ gap: 10, backgroundColor: p.sf2, borderRadius: 14, padding: 12 }}>
        <Txt role="supporting">{t.m5MonitorUpgrade}</Txt>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Pill testID="monitor-upgrade-yes" label={t.m5MonitorUpgradeYes} size={14} pad={12} disabled={busy} onPress={() => void answerUpgrade(true)} />
          <Pill testID="monitor-upgrade-no" label={t.m5MonitorUpgradeNo} kind="outline" size={14} pad={12} onPress={() => void answerUpgrade(false)} />
        </View>
      </View> : null}
    {gmailMonitor?.error ? <Txt role="supporting" color={p.wm}>{t.xIntelligenceGmailMonitorError}</Txt> : null}
  </ProductSection>
  {/* What was added from the person's own replies sits beside the panel, not inside it (R3.5). */}
  <AddedCard />
  </>;
}

/**
 * What a set of suggestions draws, for comparing a visit's answer with what
 * is held (APP-001): the mode, and each pending suggestion's id, cited
 * memories and schedule slot.
 */
function visitSignature(
  suggestions: readonly IntelligenceSuggestion[],
  schedule: IntelligenceInbox['schedule'],
  mode: BasisClass['mode'],
): string {
  const slots = new Map(schedule.map(row => [row.suggestionId, row.slot ? [row.slot.startsAt, row.slot.endsAt] : 'none']));
  const pending = suggestions
    .filter(item => item.status === 'pending')
    .map(item => [item.id, (item.memoryBasis ?? []).map(entry => entry.memoryId).sort(), slots.get(item.id) ?? null] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));
  return JSON.stringify([mode, pending]);
}

/** At most this many basis lines on a card, as the wire allows. */
const BASIS_LIMIT = 3;

/**
 * «اعتمدنا على: «…»» · «صحّحها» (M5b-2b-1, R3): one line per memory the
 * suggestion cites, quoting that memory's own words from a list fetched since
 * mount. A cited memory missing from that list (deleted, superseded, the
 * module killed), or one being corrected right now, draws no line. The
 * correction is the inline action the learned rows use, a ≥44 target whose
 * accessible name says which memory it corrects (REV-005).
 */
function SuggestionBasis({ suggestion, items, hidden, onFix }: {
  suggestion: IntelligenceSuggestion;
  items: ReadonlyMap<string, MemoryItem> | null;
  hidden: (memoryId: string) => boolean;
  onFix: (memoryId: string) => void;
}) {
  const { t, p } = useApp();
  if (!items || !suggestion.memoryBasis || suggestion.memoryBasis.length === 0) return null;
  const lines = suggestion.memoryBasis.slice(0, BASIS_LIMIT).flatMap(({ memoryId }) => {
    const memory = items.get(memoryId);
    return memory && !hidden(memoryId) ? [{ memoryId, quote: isolateAuto(memory.content) }] : [];
  });
  if (lines.length === 0) return null;
  return <View style={{ gap: 4 }}>
    {lines.map(({ memoryId, quote }) => <View key={memoryId} style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8 }}>
      <Txt role="supporting" color={p.mu} style={{ flexShrink: 1 }} testID={`m5b-suggestion-basis-${suggestion.id}-${memoryId}`}>
        {fill(t.m5bSuggestionBasis, { memory: quote })}
      </Txt>
      <Btn
        testID={`m5b-suggestion-basis-fix-${suggestion.id}-${memoryId}`}
        label={fill(t.m5bSuggestionBasisFixA11y, { memory: quote })}
        onPress={() => onFix(memoryId)}
        scaleTo={0.97}
        hitSlop={8}
        style={{ minHeight: 44, justifyContent: 'center', paddingVertical: 6 }}
      >
        <Txt size={14} color={p.acd}>{t.m5bBasisFix}</Txt>
      </Btn>
    </View>)}
  </View>;
}

/** The newest tapped outcomes the person can still say «مش صحيح» to. */
const LEARNED_LIMIT = 5;
const LEARNED_KEY = { completed: 'm5bLearnedCompleted', postponed: 'm5bLearnedPostponed', dropped: 'm5bLearnedDropped' } as const;

/**
 * «شو تعلّمت من اللي عملته» (M5b-2a R1): collapsed by default — what was
 * learned is one tap away, not a paragraph on the panel — and gone when
 * there is nothing to show, including on a server that sends no outcome.
 */
function LearnedOutcomes({ observations, open, onToggle, busy, onWrong }: {
  observations: readonly IntelligenceObservation[];
  open: boolean;
  onToggle: () => void;
  busy: boolean;
  onWrong: (id: string) => void;
}) {
  const { t, p } = useApp();
  const learned = observations
    .filter(item => item.source === 'behavior' && item.kind === 'outcome' && item.review === 'confirmed' && item.outcome)
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt) || a.id.localeCompare(b.id))
    .slice(0, LEARNED_LIMIT);
  if (learned.length === 0) return null;
  return <View style={{ gap: 8, backgroundColor: p.sf2, borderRadius: 14, padding: 12 }}>
    <Btn
      testID="m5b-learned"
      label={t.m5bLearnedTitle}
      accessibilityState={{ expanded: open }}
      onPress={onToggle}
      scaleTo={0.99}
      style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 44 }}
    >
      <Txt role="action" style={{ flexShrink: 1 }}>{t.m5bLearnedTitle}</Txt>
      <ReferenceIcon name={open ? 'chevron-up' : 'chevron-down'} size={18} color={p.mu} />
    </Btn>
    {open ? learned.map(item => {
      const line = fill(t[LEARNED_KEY[item.outcome!.signal]], { title: isolateAuto(item.outcome!.title) });
      return <View key={item.id} testID={`m5b-learned-row-${item.id}`} style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <Txt role="supporting" style={{ flexShrink: 1 }}>{line}</Txt>
        {/* The inline action the Memory rows use («ليش؟ · عدّل · امسح»), not a
            pill on its own line: five rows stayed shorter than the screen
            (design critique, SIM-M5B2A-01). Still a ≥44 target. */}
        <Btn
          testID={`m5b-learned-wrong-${item.id}`}
          label={fill(t.m5bLearnedWrongA11y, { line })}
          {...(busy ? { disabled: true } : {})}
          onPress={busy ? undefined : () => onWrong(item.id)}
          scaleTo={0.97}
          hitSlop={8}
          style={{ minHeight: 44, justifyContent: 'center', paddingVertical: 6 }}
        >
          <Txt size={14} color={busy ? p.mu : p.acd}>{t.m5bLearnedWrong}</Txt>
        </Btn>
      </View>;
    }) : null}
  </View>;
}

