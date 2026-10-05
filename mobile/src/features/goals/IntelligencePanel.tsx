import React from 'react';
import { TextInput, View } from 'react-native';
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
import { ProductSection } from '../../ui/product';
import { QueryBoundary } from '../../api/ui/QueryBoundary';
import { isolateAuto } from '../../i18n/bidi';
import { useOptionalAuth } from '../../auth/AuthProvider';
import type { Strings } from '../../i18n/strings';
import { claimVisit, recordVisitAnswer, recordVisitFailure } from '../../lib/deviceSettings/visitThrottle';
import { useConsents } from '../../api/queries';

/** The person's own records are facts already; only what was read from their words is asked about. */
const SELF_CONFIRMED_SOURCES: ReadonlySet<string> = new Set(['memory', 'commitment', 'behavior']);
/** At most this many "is this right?" cards at once, below the suggestions. */
export const MAX_CONFIRM_CARDS = 4;

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
export function IntelligencePanel({ onChanged, autoGenerate = false, whenOff }: {
  onChanged: () => void;
  autoGenerate?: boolean;
  /** Embedded mode: shown when the loop is off, and a failed read offers Retry. */
  whenOff?: React.ReactNode;
}) {
  const { t, p, rtl, lang } = useApp();
  const uid = useOptionalAuth()?.user?.uid ?? '';
  const consents = useConsents();
  const recommendationsEnabled = consents.data?.recommendations.state === 'granted';
  const zone = useTimeZone();
  const [phase, setPhase] = React.useState<'loading' | 'ready' | 'off' | 'failed'>('loading');
  const [loadError, setLoadError] = React.useState<unknown>(null);
  const [inbox, setInbox] = React.useState<IntelligenceInbox | null>(null);
  const [draft, setDraft] = React.useState('');
  const [answers, setAnswers] = React.useState<Record<string, string>>({});
  const [editedTitles, setEditedTitles] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
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
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
      onChanged();
    } catch (cause) {
      setError(cause);
      try { await refresh(); } catch { /* Keep the original action error visible. */ }
    }
    finally { setBusy(false); }
  };
  if (phase === 'off') return whenOff === undefined ? null : <>{whenOff}</>;
  if (whenOff !== undefined && phase !== 'ready') {
    return <QueryBoundary isPending={phase === 'loading'} error={phase === 'failed' ? loadError : null} onRetry={() => { setPhase('loading'); load(() => true); }}>{null}</QueryBoundary>;
  }
  if (phase !== 'ready' || !inbox) return null;
  const evidence = new Map(inbox.observations.map(item => [item.id, item.evidence]));
  const schedule = new Map(inbox.schedule.map(item => [item.suggestionId, item]));
  return <ProductSection title={t.xIntelligenceTitle} body={t.xIntelligenceBody} icon="goal">
    {error ? <Txt role="supporting" color={p.wm}>{userFacingMessage(error, t)}</Txt> : null}
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
      placeholder={t.xIntelligencePlaceholder}
      placeholderTextColor={p.mu}
      maxLength={2000}
      multiline
      style={{ color: p.tx, backgroundColor: p.bg, padding: 14, minHeight: 60, borderRadius: 14, fontSize: 17, textAlign: rtl ? 'right' : 'left' }}
    />
    <Pill testID="intelligence-analyze" label={t.xIntelligenceAnalyze} disabled={busy || !draft.trim()} onPress={() => void run(async () => {
      await analyzeIntelligenceStatement(draft.trim());
      setDraft('');
    })} />
    {recommendationsEnabled ? <Pill testID="intelligence-generate" label={t.xIntelligenceGenerate} disabled={busy || inbox.observations.length === 0} onPress={() => void run(() => generateIntelligenceSuggestions())} /> : null}
    <Pill testID="intelligence-gmail-scan" label={t.xIntelligenceGmailScan} kind="outline" disabled={busy} onPress={() => void run(scanGmailForIntelligence)} />
    <Txt role="supporting">{t.xIntelligenceGmailMonitorInfo}</Txt>
    <Pill testID="intelligence-gmail-monitor" label={gmailMonitor?.enabled ? t.xIntelligenceGmailMonitorOff : t.xIntelligenceGmailMonitorOn}
      kind="outline" disabled={busy || gmailMonitor === null} onPress={() => void run(() => setGmailIntelligenceMonitor(!gmailMonitor?.enabled))} />
    {gmailMonitor?.error ? <Txt role="supporting" color={p.wm}>{t.xIntelligenceGmailMonitorError}</Txt> : null}
  </ProductSection>;
}
