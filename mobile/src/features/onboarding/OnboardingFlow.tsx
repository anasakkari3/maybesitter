import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { useAuth } from '../../auth/AuthProvider';
import { useTimeZone } from '../../i18n/timezone';
import { apiLocale } from '../../i18n/locale';
import {
  useConsents,
  usePutRoutine,
  useRecordAnalytics,
  useSetAiConsent,
  useSetRecommendationConsent,
  useTrustAction,
} from '../../api/queries';
import { toRoutinePayload, type RoutineAnswers } from '../routine/routineProfile';
import { EMPTY_CACHE, loadRoutineCache, saveRoutineCache } from '../../lib/deviceSettings/routineCache';
import {
  SETUP_CACHE_VERSION,
  clearSetupChatCache,
  loadSetupChatCache,
  saveSetupChatCache,
} from '../../lib/deviceSettings/setupChatCache';
import { WelcomeStep } from './WelcomeStep';
import { ConsentStep, type ConsentChoices } from './ConsentStep';
import { RoutineStep } from './RoutineStep';
import { NotificationsStep } from './NotificationsStep';
import { AboutYouStep } from './AboutYouStep';
import { AboutYouReviewStep } from './AboutYouReviewStep';
import { SetupChatStep } from './SetupChatStep';
import { AiImportFlowStep } from './AiImportFlowStep';
import { remainingQuestions } from './setupGaps';
import { SETUP_QUESTIONS } from './setupChat';
import { EMPTY_SETUP_ANSWERS, answeredCount, composeDescription, type SetupAnswers } from './setupChat';
import type { ProfileSuggestion, SuggestionCategory } from '../../api/schemas/profile';
import { NotFoundError } from '../../api/errors';
import { useConfirmProfileSuggestions, useDescribeProfile } from '../../api/queries';
import type { AcceptedSuggestion } from './aboutYou';
import { recordConsents } from './recordConsents';
import type { ConsentLocale, ConsentPlatformName } from './consentTypes';
import {
  loadOnboardingProgress,
  nextStep,
  previousStep,
  saveOnboardingProgress,
  type OnboardingProgress,
  type OnboardingStep,
} from '../../lib/deviceSettings/onboardingProgress';
import { EMPTY_ANSWERS } from '../routine/routineProfile';

/**
 * Onboarding, from sign-in to Today (UC-2.R1, #171).
 *
 * ── Where the answers actually go ────────────────────────────────
 *
 * Three writes on Continue, and the screen advances only when **all three**
 * return. A partial success is the failure worth being careful about: a user
 * who allowed AI and declined analytics, and whose analytics write failed,
 * must not be told their answers were recorded. On any failure nothing
 * advances, the footer says nothing changed, and the button becomes Retry —
 * re-sending all three, which is safe because each is a whole-value `PUT`.
 *
 * ── Progress is stored per step ──────────────────────────────────
 *
 * Killing the app mid-survey resumes at the survey. `saveOnboardingProgress`
 * runs *before* the state moves, so a crash between the two resumes on the
 * step just finished rather than skipping one.
 *
 * ── The analytics event obeys the answer it just recorded ────────
 *
 * `onboarding_completed` fires only when analytics consent was granted. It is
 * read from the choice the user made on this screen, not from a refetch that
 * might not have landed yet.
 */
export function OnboardingFlow({ onFinished }: { onFinished: () => void }) {
  // The survey answers are the account's, not the device's (#148): every read
  // and write of the local copy names whose it is.
  const accountId = useAuth().user?.uid ?? null;
  const { p, t } = useApp();
  const timezone = useTimeZone();
  const consents = useConsents();
  const setAi = useSetAiConsent();
  const setRecommendations = useSetRecommendationConsent();
  const trustAction = useTrustAction();
  const putRoutine = usePutRoutine();
  const recordAnalytics = useRecordAnalytics();

  const [step, setStep] = useState<OnboardingProgress | null>(null);
  // `recommendations` starts at `null`, not `false`, so "nobody has answered"
  // and "answered no" stay distinguishable through a refetch. See the seeding
  // block below, and `ConsentChoices`.
  const [choices, setChoices] = useState<ConsentChoices>({ ai: null, recommendations: null, analytics: false });
  const [answers, setAnswers] = useState<RoutineAnswers>(EMPTY_ANSWERS);
  const [consentFailed, setConsentFailed] = useState(false);
  const [routineSaveFailed, setRoutineSaveFailed] = useState(false);

  // The self-description (UC-2.7b, #168). `proposal === null` means the step
  // has not produced suggestions yet, so the write screen shows; once it has,
  // the review list replaces it without changing the stored step — a reload
  // mid-review comes back to a blank description rather than to a stale
  // proposal, because the proposal expires in thirty minutes anyway and
  // resuming into an empty checklist would be worse than asking again.
  const [proposal, setProposal] = useState<{ id: string; suggestions: ProfileSuggestion[] } | null>(null);
  /** The import detour, and what it turned out to have covered. */
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<readonly SuggestionCategory[] | null>(null);
  const [describeFailed, setDescribeFailed] = useState(false);
  const [confirmFailure, setConfirmFailure] = useState<unknown>(undefined);
  const describe = useDescribeProfile();
  const confirmSuggestions = useConfirmProfileSuggestions();

  // The guided setup's draft (UC-3.17, #469): five answers and the question
  // the user is on. A draft and nothing more — it reaches the account only
  // through the review step, and is cleared when the step ends either way.
  const [setup, setSetup] = useState<{ answers: SetupAnswers; index: number }>({
    answers: EMPTY_SETUP_ANSWERS,
    index: 0,
  });
  // Flipped once the stored draft has been read, so the write-through below
  // cannot overwrite a real draft with the empty one it starts from.
  const setupLoaded = useRef(false);

  // Resume where the last run stopped, and re-open the survey and the setup
  // draft on whatever this device already has cached.
  useEffect(() => {
    let live = true;
    void (async () => {
      const [progress, cache, setupCache] = await Promise.all([
        loadOnboardingProgress(),
        accountId ? loadRoutineCache(accountId) : Promise.resolve(null),
        accountId ? loadSetupChatCache(accountId) : Promise.resolve(null),
      ]);
      if (!live) return;
      setStep(progress);
      if (cache) setAnswers(cache.answers);
      setupLoaded.current = true;
      if (setupCache) setSetup({ answers: setupCache.answers, index: setupCache.index });
    })();
    return () => { live = false; };
  }, [accountId]);

  // Every change to the draft is written through, fire-and-forget:
  // backgrounding the app mid-chat must not start it over, and a write that
  // did not land costs a draft, not the screen.
  useEffect(() => {
    if (!accountId || !setupLoaded.current) return;
    void saveSetupChatCache(accountId, {
      version: SETUP_CACHE_VERSION,
      answers: setup.answers,
      index: setup.index,
      updatedAt: new Date().toISOString(),
    });
  }, [accountId, setup]);

  // A second device runs onboarding again, but must not re-ask a question this
  // account has already answered. The server's copy seeds the controls.
  //
  // Adjusted during render rather than in an effect — React's own advice for
  // state derived from a change in another value, and the pattern `AuthGate`
  // already uses. An effect would cost a second pass on every consent refetch,
  // and the lint rightly refuses a synchronous `setState` inside one.
  const [seededFrom, setSeededFrom] = useState<typeof consents.data>(undefined);
  if (consents.data && consents.data !== seededFrom) {
    const server = consents.data;
    setSeededFrom(server);
    setChoices(current => ({
      // A choice already made on this screen wins: the refetch must not undo
      // what the user just tapped.
      //
      // `??` on both, and both are three-valued for that reason. `||` here read
      // an explicit decline as an absence — they are the same `false` — so a
      // refetch landing after the user turned this off put the account's older
      // grant back and `submitConsents` then recorded a consent the user had
      // just withdrawn. A question the account has never been asked seeds
      // nothing: the server's default `declined` is not an answer either.
      ai: current.ai ?? (server.aiProcessing.asked ? server.aiProcessing.state : null),
      recommendations: current.recommendations
        ?? (server.recommendations.asked ? server.recommendations.state === 'granted' : null),
      analytics: current.analytics,
    }));
  }

  const advance = useCallback(async (from: OnboardingStep) => {
    const next = nextStep(from);
    await saveOnboardingProgress(next);
    setStep(next);
    if (next === 'done') onFinished();
  }, [onFinished]);

  const goBack = useCallback((from: OnboardingStep) => {
    const back = previousStep(from);
    if (!back) return;
    void saveOnboardingProgress(back);
    setStep(back);
  }, []);

  const submitConsents = useCallback(async () => {
    if (choices.ai === null) return;
    setConsentFailed(false);
    const result = await recordConsents(
      // `recommendations` may still be `null` — untouched — and `recordConsents`
      // is where that becomes the declined it has always meant, once.
      { ai: choices.ai, recommendations: choices.recommendations, analytics: choices.analytics },
      consents.data?.currentVersions,
      {
        locale: apiLocale() as ConsentLocale,
        platform: Platform.OS === 'ios' ? 'ios' as ConsentPlatformName : 'android' as ConsentPlatformName,
      },
      {
        setAiConsent: input => setAi.mutateAsync(input),
        setRecommendationConsent: input => setRecommendations.mutateAsync(input),
        setAnalyticsConsent: granted => trustAction.mutateAsync({ type: 'set_analytics_consent', granted }),
        reportCompleted: () => recordAnalytics.mutate({ eventName: 'onboarding_completed' }),
      },
    );
    if (!result.ok) {
      setConsentFailed(true);
      return;
    }
    await advance('consent');
  }, [advance, choices, consents.data, recordAnalytics, setAi, setRecommendations, trustAction]);

  const saveRoutine = useCallback(async (skipped: boolean) => {
    const payload = toRoutinePayload(answers, timezone, { skipped });
    // The local copy is written first and unconditionally. The survey has to
    // survive a plane, and the account copy is what syncs later.
    let pendingSync = true;
    try {
      await putRoutine.mutateAsync(payload);
      pendingSync = false;
      setRoutineSaveFailed(false);
    } catch {
      // Not an error the user has to act on: the answers are on the phone and
      // will reach the account on reconnect. The footer says so.
      setRoutineSaveFailed(true);
    }
    if (accountId) {
      await saveRoutineCache(accountId, {
        ...EMPTY_CACHE,
        answers,
        skipped,
        timezone,
        updatedAt: new Date().toISOString(),
        pendingSync,
      });
    }
    await advance('routine');
  }, [accountId, advance, answers, putRoutine, timezone]);

  const readDescription = useCallback(async (text: string) => {
    setDescribeFailed(false);
    try {
      const result = await describe.mutateAsync(text);
      setProposal({ id: result.proposalId, suggestions: result.suggestions });
    } catch {
      // Includes a revoked consent and a model that is simply off. Either way
      // there is nothing to show, and nothing was written.
      setDescribeFailed(true);
    }
  }, [describe]);

  /**
   * The about step is over — saved, saved nothing, skipped, or the manual
   * card's Continue. The draft goes, and the one event this step reports is
   * a count, sent only when this run granted analytics. The manual path
   * reports zero whatever a restored draft holds: the questions were never
   * asked on this run.
   */
  const finishSetup = useCallback(async (reason: 'manual' | 'skipped' | 'saved') => {
    if (accountId) await clearSetupChatCache(accountId);
    if (choices.analytics) {
      recordAnalytics.mutate({
        eventName: 'onboarding_setup_answered',
        properties: { answeredCount: reason === 'manual' ? 0 : answeredCount(setup.answers) },
      });
    }
    await advance('about');
  }, [accountId, advance, choices.analytics, recordAnalytics, setup.answers]);

  const saveSuggestions = useCallback(async (proposalId: string, accepted: AcceptedSuggestion[]) => {
    // An empty list is a real answer — "none of these are right" — and is sent
    // rather than skipped, so the proposal is cleaned up server-side too.
    setConfirmFailure(undefined);
    try {
      await confirmSuggestions.mutateAsync({ proposalId, accepted });
    } catch (error) {
      // Only one failure means "there is nothing left to save": the route
      // answers 404 `proposal_not_found` once the thirty minutes are up or the
      // proposal has already been consumed. Nothing can bring it back, so
      // moving on beats trapping somebody on a checklist that cannot commit.
      //
      // Every other failure — no signal, a timeout, a 5xx, a refused body —
      // means the ticks did not land and nobody has been told. Advancing there
      // is the same false save this app has already shipped once: the screen
      // stays, says what happened in `userFacingMessage`'s words, and the
      // primary button re-sends the very same ticks.
      if (!(error instanceof NotFoundError)) {
        setConfirmFailure(error);
        return;
      }
    }
    setProposal(null);
    await finishSetup('saved');
  }, [confirmSuggestions, finishSetup]);

  // What is still worth asking. `remainingQuestions([])` is the full five and
  // the identical array, so an account that skipped the import is byte-for-byte
  // where it was before this feature existed.
  const questions = remainingQuestions(imported ?? []);

  if (step === null || step === 'done') {
    // Held on the plain background while the stored step is read, for the same
    // reason AuthGate does: flashing the welcome screen at somebody who is
    // three steps in is the defect this state prevents.
    return <View testID="onboarding-loading" style={{ flex: 1, backgroundColor: p.bg }} />;
  }

  if (step === 'welcome') {
    return <WelcomeStep onContinue={() => void advance('welcome')} />;
  }

  if (step === 'consent') {
    return (
      <ConsentStep
        choices={choices}
        onChange={setChoices}
        onContinue={() => void submitConsents()}
        onBack={() => goBack('consent')}
        onRetry={() => void consents.refetch()}
        ready={consents.data !== undefined}
        unreachable={consents.data === undefined ? consents.error : undefined}
        saving={setAi.isPending || setRecommendations.isPending || trustAction.isPending}
        failed={consentFailed}
      />
    );
  }

  if (step === 'routine') {
    return (
      <RoutineStep
        answers={answers}
        onChange={setAnswers}
        onContinue={() => void saveRoutine(false)}
        onSkip={() => void saveRoutine(true)}
        saveFailed={routineSaveFailed}
      />
    );
  }

  if (step === 'about') {
    // A fourth sub-state of `about`, keyed on local state exactly as the other
    // three are. Deliberately not a sixth ONBOARDING_STEP: the stored progress
    // is per device and a user who reloads mid-import should come back to the
    // setup chat, not to a step that only exists when they took a detour. The
    // proposal expires in thirty minutes anyway.
    if (importing) {
      return (
        <AiImportFlowStep
          onDone={(categories) => { setImported(categories); setImporting(false); }}
          onCancel={() => setImporting(false)}
        />
      );
    }
    if (proposal) {
      return (
        <AboutYouReviewStep
          suggestions={proposal.suggestions}
          saving={confirmSuggestions.isPending}
          failure={confirmFailure}
          onBack={() => { setProposal(null); setDescribeFailed(false); setConfirmFailure(undefined); }}
          onSave={(accepted) => void saveSuggestions(proposal.id, accepted)}
        />
      );
    }
    if (choices.ai !== 'granted') {
      // With AI off there is nothing to read, so the step just ends. Anything
      // the user wants remembered goes in by hand from the memory screen,
      // which stores it without a model.
      return (
        <AboutYouStep
          onManual={() => void finishSetup('manual')}
          onBack={() => goBack('about')}
        />
      );
    }
    return (
      <SetupChatStep
        answers={setup.answers}
        index={setup.index}
        questions={questions}
        gapCount={SETUP_QUESTIONS.length - questions.length}
        {...(imported === null ? { onImport: () => setImporting(true) } : {})}
        onChange={(update) => setSetup(previous => ({ ...previous, answers: update(previous.answers) }))}
        onIndexChange={(index) => setSetup(previous => ({ ...previous, index }))}
        onRead={() => void readDescription(composeDescription(setup.answers, t))}
        onSkip={() => void finishSetup('skipped')}
        onBack={() => goBack('about')}
        reading={describe.isPending}
        failed={describeFailed}
      />
    );
  }

  return (
    <NotificationsStep
      onDone={() => void advance('notifications')}
      onBack={() => goBack('notifications')}
    />
  );
}
