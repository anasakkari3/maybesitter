import { useCallback } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { useTimeZone } from '../i18n/timezone';
import { apiLocale } from '../i18n/locale';
import { useAuth } from '../auth/AuthProvider';
import { clarifyCapture, confirmCapture, proposeCapture } from './endpoints/capture';
import { proposeFromShare } from './endpoints/share';
import type { UploadFile } from './client';
import {
  actOnCommitment,
  deleteCommitment,
  getCommitment,
  listToday,
  listUpcoming,
  patchCommitment,
  type CommitmentAction,
  type CommitmentPatch,
} from './endpoints/commitments';
import { getWeeklySummary, listActivity } from './endpoints/activity';
import { getCategoryPreferences, putCategoryPreferences } from './endpoints/categories';
import type { CategoryPreferences } from './schemas/categories';
import {
  actOnPlan,
  buildPlan,
  getPlan,
  getPlanSettings,
  putPlanSettings,
  regeneratePlan,
  type PlanEdit,
} from './endpoints/plans';
import { getNextStep, recordNextStepDecision } from './endpoints/nextStep';
import { getTrust, reportPilotIncident, updateTrust } from './endpoints/trust';
import { flagAlphaFeedback, getFeedbackHistory, revokeFeedback } from './endpoints/feedback';
import { recordAnalyticsEvent } from './endpoints/analytics';
import { putCalendarWriteTarget } from './endpoints/calendar';
import type { CalendarWriteTarget } from './schemas/calendar';
import { dismissFixture, getFootballSettings, putFollowedClubs } from './endpoints/football';
import type { FootballSettingsResponse } from './schemas/football';
import {
  getConsents,
  putAiConsent,
  putPersonalizationConsent,
  putRecommendationConsent,
  type ConsentAnswer,
} from './endpoints/consents';
import { getReminderSettings, putReminderSettings, type ReminderSettingsPatch } from './endpoints/reminders';
import {
  deleteSeed,
  keepProposedSeed,
  listSeeds,
  patchSeed,
  promoteSeed,
} from './endpoints/seeds';
import type { SeedStatus } from './schemas/seeds';
import { getReadiness, putSubjectiveEnergy } from './endpoints/readiness';
import {
  connectFinancialSource,
  deleteFinancialField,
  deleteFinancialObligation,
  disconnectFinancialSource,
  getFinancialConnection,
  getFinancialContext,
  getFinancialManual,
  putFinancialField,
  putFinancialObligation,
} from './endpoints/financial';
import {
  confirmProfileSuggestions,
  describeProfile,
  createMemory,
  deleteAllMemory,
  deleteMemory,
  dismissMemorySuggestion,
  keepMemorySuggestion,
  getProfile,
  listMemory,
  patchMemory,
  putRoutine,
  importAiContext,
  confirmAiContextImport,
} from './endpoints/profile';
import type { ImportAssistant } from './schemas/aiContextImport';
import type { RoutineProfilePayload } from '../features/routine/routineProfile';
import { applyEditLocally } from '../features/plan/optimisticEdit';
import type { DailyPlan } from './schemas/plan';
import type { NextStepDecisionKind, NextStepRecommendation } from './schemas/nextStep';
import type { PilotIncidentInput, TrustAction } from './schemas/trust';
import type { MemorySuggestion } from './schemas/profile';
import type { AlphaFeedbackCategory } from './schemas/feedback';
import type { AnalyticsProperties, ClientReportableEvent } from './schemas/analytics';
import { ForbiddenError, InvalidTransitionError, StaleCommitmentError } from './errors';
import { icsFeedsEnabled, safeCommitmentPatchEnabled } from '../config/env';
import {
  createIcsFeed,
  decideIcsDeadline,
  deleteIcsFeed,
  listIcsFeeds,
  refreshIcsFeed,
  updateIcsFeed,
} from './endpoints/icsFeeds';
import type { IcsDeadlineAction } from './schemas/icsFeeds';
import {
  confirmGoalCommitments,
  confirmGoalSelections,
  generateGoalExecution,
  getGoalExecution,
  regenerateGoalExecution,
  unlinkGoalNode,
} from './endpoints/goals';
import type { GoalConfirmationSelection } from './endpoints/goals';
import { createHabit, deleteHabit, listHabits, setHabitStatus } from './endpoints/habits';
import type { Habit, NewHabitInput } from './schemas/habits';

/**
 * The hooks screens use, and the invalidation rules that keep them honest.
 *
 * Every key is scoped by uid. That is not tidiness: it is what makes it
 * impossible for account B to be shown a list cached for account A, even for
 * one frame, however the two sessions overlapped (#148). The cache is also
 * cleared outright on a uid change — see `useClearCacheOnUserChange` — so the
 * scoping is a second line rather than the only one.
 */

export const queryKeys = {
  consents: (uid: string) => ['user', uid, 'consents'] as const,
  today: (uid: string, timezone: string) => ['user', uid, 'commitments', 'today', timezone] as const,
  upcoming: (uid: string, timezone: string) => ['user', uid, 'commitments', 'upcoming', timezone] as const,
  commitment: (uid: string, id: string) => ['user', uid, 'commitment', id] as const,
  nextStep: (uid: string, locale: string) => ['user', uid, 'nextStep', locale] as const,
  trust: (uid: string) => ['user', uid, 'trust'] as const,
  feedbackHistory: (uid: string) => ['user', uid, 'feedbackHistory'] as const,
  profile: (uid: string) => ['user', uid, 'profile'] as const,
  memory: (uid: string) => ['user', uid, 'memory'] as const,
  activity: (uid: string) => ['user', uid, 'activity'] as const,
  activitySummary: (uid: string, weekStart: string) => ['user', uid, 'activitySummary', weekStart] as const,
  football: (uid: string) => ['user', uid, 'football'] as const,
  /**
   * One day's plan (UC-3.10b, #195).
   *
   * Keyed by date as well as uid, so tomorrow's plan never renders under
   * today's heading and a push for one date cannot show another's.
   */
  plan: (uid: string, date: string) => ['user', uid, 'plan', date] as const,
  planSettings: (uid: string) => ['user', uid, 'planSettings'] as const,
  reminderSettings: (uid: string) => ['user', uid, 'reminderSettings'] as const,
  readiness: (uid: string) => ['user', uid, 'readiness'] as const,
  financialContext: (uid: string) => ['user', uid, 'financialContext'] as const,
  financialManual: (uid: string) => ['user', uid, 'financialManual'] as const,
  financialConnection: (uid: string) => ['user', uid, 'financialConnection'] as const,
  categoryPreferences: (uid: string) => ['user', uid, 'categoryPreferences'] as const,
  /** Subscribed calendar feeds and the deadlines they propose (UC-3.4, #188). Never a URL. */
  icsFeeds: (uid: string) => ['user', uid, 'icsFeeds'] as const,
  /** Things the person is considering or waiting on (#519). */
  seeds: (uid: string) => ['user', uid, 'seeds'] as const,
  goalExecution: (uid: string, goalId: string, generation: number) => ['user', uid, 'goalExecution', goalId, generation] as const,
  habits: (uid: string) => ['user', uid, 'habits'] as const,
};

/** The signed-in uid, or the one value that can never collide with one. */
export function useUid(): string {
  return useAuth().user?.uid ?? 'signed-out';
}

/**
 * The validators the screens are holding, keyed by commitment id (#148).
 *
 * In memory, not in the query cache: an `ETag` is a fact about the request
 * that produced it, not user data, and it must not outlive the process. A
 * mutation reads the validator for the commitment it is changing and sends it
 * as `If-Match`, so an edit from a screen that has gone stale is refused
 * rather than silently overwriting a newer change from another device.
 *
 * Cleared on a uid change along with everything else — see `ApiProvider`.
 */
const validators = new Map<string, string>();

export function rememberValidator(id: string, etag: string | null): void {
  if (etag) validators.set(id, etag);
}

export function validatorFor(id: string): string | undefined {
  return validators.get(id);
}

export function forgetValidators(): void {
  validators.clear();
}

/**
 * Everything a commitment change can affect. Both lists, the item itself, and
 * the next step — which is derived from the commitments and is wrong the
 * moment one of them moves.
 */
function invalidateCommitments(client: QueryClient, uid: string, id?: string): void {
  void client.invalidateQueries({ queryKey: ['user', uid, 'commitments'] });
  void client.invalidateQueries({ queryKey: ['user', uid, 'nextStep'] });
  // The day's plan places these same commitments (Round 2, Phase C). A thing
  // finished on Today was still a scheduled plan item until the plan happened
  // to refetch, and Today's plan row counted it. One truth: a commitment that
  // moves moves the plan too.
  void client.invalidateQueries({ queryKey: ['user', uid, 'plan'] });
  if (id) void client.invalidateQueries({ queryKey: queryKeys.commitment(uid, id) });
  // Anything that moves a commitment is, by definition, something that just
  // happened — so the history and the week's counts are both out of date
  // (UC-3.15, #201). Both keys are invalidated rather than refetched: Activity
  // is usually not mounted, and refetching a screen nobody is looking at is a
  // request for nothing.
  void client.invalidateQueries({ queryKey: queryKeys.activity(uid) });
  void client.invalidateQueries({ queryKey: ['user', uid, 'activitySummary'] });
}

export function useToday() {
  const uid = useUid();
  const timezone = useTimeZone();
  return useQuery({
    queryKey: queryKeys.today(uid, timezone),
    queryFn: () => listToday({ timezone }),
    enabled: uid !== 'signed-out',
  });
}

/**
 * Which categories this account uses, and whether its lists are split (#415).
 *
 * No `retry` override and no error surface: a screen calls this to decide
 * whether to draw a filter bar, and a preference that will not load means the
 * ordinary one-list app rather than an error the user has to dismiss. The
 * caller reads `data?.categoryPreferences` and falls back to "off", so a
 * failure and a user who never turned it on look the same — which is correct,
 * because they *are* the same to the person holding the phone.
 */
export function useCategoryPreferences() {
  const uid = useUid();
  return useQuery({
    queryKey: queryKeys.categoryPreferences(uid),
    queryFn: () => getCategoryPreferences(),
    enabled: uid !== 'signed-out',
  });
}

export function useUpcoming() {
  const uid = useUid();
  const timezone = useTimeZone();
  return useQuery({
    queryKey: queryKeys.upcoming(uid, timezone),
    queryFn: () => listUpcoming({ timezone }),
    enabled: uid !== 'signed-out',
  });
}

export function useCommitment(id: string | null) {
  const uid = useUid();
  return useQuery({
    queryKey: queryKeys.commitment(uid, id ?? ''),
    queryFn: async () => {
      const result = await getCommitment(id as string);
      // Kept so an edit from this screen can be conditional.
      rememberValidator(result.data.id, result.etag);
      return result.data;
    },
    enabled: uid !== 'signed-out' && id !== null,
  });
}

export function useNextStep() {
  const uid = useUid();
  const locale = apiLocale();
  return useQuery({
    queryKey: queryKeys.nextStep(uid, locale),
    queryFn: () => getNextStep(locale),
    enabled: uid !== 'signed-out',
  });
}

export function useGoalExecution(goalId: string, generation = 1) {
  const uid = useUid();
  return useQuery({
    queryKey: queryKeys.goalExecution(uid, goalId, generation),
    queryFn: () => getGoalExecution(goalId, generation),
    enabled: uid !== 'signed-out' && goalId !== '',
  });
}

function useGoalMutation<TInput>(goalId: string, mutationFn: (input: TInput) => Promise<unknown>) {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['user', uid, 'goalExecution', goalId] });
      invalidateCommitments(client, uid);
    },
  });
}

export function useGenerateGoalExecution(goalId: string) {
  return useGoalMutation(goalId, () => generateGoalExecution(goalId));
}

export function useRegenerateGoalExecution(goalId: string) {
  return useGoalMutation(goalId, (generation: number) => regenerateGoalExecution(goalId, generation));
}

export function useConfirmGoalCommitments(goalId: string) {
  return useGoalMutation(goalId, (input: { generation: number; nodeIds: readonly string[] }) =>
    confirmGoalCommitments(goalId, input.generation, input.nodeIds));
}

export function useConfirmGoalSelections(goalId: string) {
  return useGoalMutation(goalId, (input: { generation: number; selections: readonly GoalConfirmationSelection[] }) =>
    confirmGoalSelections(goalId, input.generation, input.selections));
}

export function useUnlinkGoalNode(goalId: string) {
  return useGoalMutation(goalId, (nodeId: string) => unlinkGoalNode(goalId, nodeId));
}

export function useHabits() {
  const uid = useUid();
  return useQuery({ queryKey: queryKeys.habits(uid), queryFn: listHabits, enabled: uid !== 'signed-out' });
}

function useHabitMutation<TInput>(mutationFn: (input: TInput) => Promise<unknown>) {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.habits(uid) });
      void client.invalidateQueries({ queryKey: ['user', uid, 'plan'] });
      void client.invalidateQueries({ queryKey: ['user', uid, 'goalExecution'] });
    },
  });
}

export function useSetHabitStatus() {
  const timezone = useTimeZone();
  return useHabitMutation((input: { id: string; status: Habit['status'] }) => setHabitStatus(input.id, input.status, timezone));
}

export function useCreateHabit() {
  const timezone = useTimeZone();
  return useHabitMutation((input: NewHabitInput) => createHabit(input, timezone));
}

export function useDeleteHabit() {
  return useHabitMutation((id: string) => deleteHabit(id));
}

export function useTrust() {
  const uid = useUid();
  return useQuery({
    queryKey: queryKeys.trust(uid),
    queryFn: getTrust,
    enabled: uid !== 'signed-out',
  });
}

export function useFeedbackHistory() {
  const uid = useUid();
  return useQuery({
    queryKey: queryKeys.feedbackHistory(uid),
    queryFn: () => getFeedbackHistory(),
    enabled: uid !== 'signed-out',
  });
}

/**
 * This account's history, a page at a time (UC-3.15, #201).
 *
 * The cursor is the server's own and is only ever echoed. `initialPageParam`
 * is null — "start at the beginning" — and a page whose `nextCursor` is null
 * ends the list, which is what stops the infinite scroll rather than a count
 * the client keeps.
 */
export function useActivity() {
  const uid = useUid();
  return useInfiniteQuery({
    queryKey: queryKeys.activity(uid),
    queryFn: ({ pageParam }) => listActivity({ cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor,
    enabled: uid !== 'signed-out',
  });
}

/**
 * The week's summary. `weekStart` omitted means "the week the server says it
 * is", which is the only answer two devices in two timezones can agree on.
 */
export function useWeeklySummary(weekStart?: string) {
  const uid = useUid();
  return useQuery({
    queryKey: queryKeys.activitySummary(uid, weekStart ?? 'current'),
    queryFn: () => getWeeklySummary(weekStart),
    enabled: uid !== 'signed-out',
  });
}

/**
 * What this account has agreed to.
 *
 * The composer reads this to decide whether to show the "AI: off" chip. It is a
 * query rather than context so that a revocation made elsewhere arrives on the
 * next refetch; `staleTime` is the layer's default, and the answer is cheap.
 */
export function useConsents() {
  const uid = useUid();
  return useQuery({
    queryKey: queryKeys.consents(uid),
    queryFn: () => getConsents(),
    enabled: uid !== 'signed-out',
    // Never from a cache. Somebody who revoked on another device has to see it
    // revoked here on the next look, and a toggle rendered from a stale answer
    // is a toggle that lies about what the server will actually do — which is
    // also why UC-2.R1 (#171)'s consent screen renders straight off this.
    staleTime: 0,
  });
}

/**
 * Whether a model may be asked about this account's captures.
 *
 * `false` while the answer is loading and while it is declined: the chip errs
 * towards telling the user the model is off, because claiming it is on when it
 * is not is the direction that misleads. The server decides regardless — it
 * computes `requestedEngine` from its own consent record and ignores anything
 * the client sends (#161) — so this only ever affects what is displayed.
 */
export function useAiConsentGranted(): { granted: boolean; asked: boolean; loading: boolean } {
  const { data, isLoading } = useConsents();
  return {
    granted: data?.aiProcessing.state === 'granted',
    asked: data?.aiProcessing.asked ?? false,
    loading: isLoading,
  };
}

export function useCapture() {
  const timezone = useTimeZone();
  return useMutation({
    mutationFn: (text: string) => proposeCapture({ text, timezone }),
  });
}

/**
 * Analyze what another app handed us (UC-3.0, #183).
 *
 * The one mutation in this file that uploads. It is the same shape as
 * `useCapture` on purpose: what comes back is the ordinary capture proposal
 * plus an envelope of counts, so the review, clarify, edit and confirm hooks
 * below read it unchanged and share needed none of its own.
 *
 * `retry: false` is spelled out rather than inherited. An upload that may or
 * may not have arrived is the request #157 forbids replaying, and here a replay
 * also costs the user a second slice of their thirty-a-day and a second upload
 * on their data plan. `apiUpload` still refreshes once on a 401, which is a
 * request the server explicitly told us it did not process.
 */
export function useProposeFromShare() {
  const timezone = useTimeZone();
  return useMutation({
    retry: false,
    mutationFn: (input: {
      text?: string | undefined;
      files?: readonly UploadFile[];
      sourceHint?: 'whatsapp' | 'email' | 'unknown';
      signal?: AbortSignal;
    }) => proposeFromShare({ ...input, timezone }),
  });
}

/**
 * The confirm.
 *
 * The idempotency key is minted here, once per call, from `expo-crypto`. It is
 * not retried and not queued: see `queryClient.ts` for why.
 */
/**
 * Answers one clarification (UC-2.5, #165).
 *
 * Not retried, like the confirm: an answer is a decision about a commitment,
 * and replaying one the user is no longer looking at is the failure #157 names.
 */
export function useClarifyCapture() {
  const timezone = useTimeZone();
  return useMutation({
    mutationFn: (input: { proposalId: string; itemId: string; questionId: string; optionId?: string; freeText?: string }) =>
      clarifyCapture({ ...input, timezone }),
  });
}

export function useConfirmCapture() {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    mutationFn: (input: {
      proposalId: string;
      itemIds: string[];
      edits?: { itemId: string; title?: string; resolvedTime?: string | null; priority?: 'high' | 'normal' | 'low' }[];
    }) => confirmCapture({ ...input, idempotencyKey: Crypto.randomUUID() }),
    onSuccess: () => invalidateCommitments(client, uid),
  });
}

/**
 * Edits one commitment, when this build is allowed to (UC-2.R3, #173).
 *
 * The flag is consulted **here**, inside the mutation, rather than on the
 * screen. `DetailsScreen` also hides the Edit control when it is off, but a
 * hidden button is a fact about one screen; this is the single place every
 * PATCH this app can make is built, so "no PATCH is ever sent" is a claim the
 * code can actually keep however the mutation is reached.
 *
 * It fails as a `feature_disabled` 403 would. That is a state `QueryBoundary`
 * and `userFacingMessage` already have words and a screen for, and inventing a
 * second vocabulary for the same situation is how two disabled features start
 * telling the user two different stories.
 */
export function usePatchCommitment() {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    // `patch` is spread from `buildTimePatch`, so a plain move carries only
    // `dueDate` and the server keeps the reminder lead the user set. The
    // validator makes the write conditional (#148).
    mutationFn: async (input: { id: string; patch: CommitmentPatch }) => {
      // Before the request is built, not after: nothing leaves the device.
      if (!safeCommitmentPatchEnabled()) {
        throw new ForbiddenError('commitment editing is off in this build', 'feature_disabled');
      }
      const result = await patchCommitment(input.id, input.patch, validatorFor(input.id));
      rememberValidator(input.id, result.etag);
      return result.data;
    },
    onSuccess: (_result, input) => invalidateCommitments(client, uid, input.id),
    onError: (error, input) => adoptNewerCommitment(client, uid, input.id, error),
  });
}

/**
 * What to do when the server says another device moved first (#148).
 *
 * On `stale_commitment` the newer commitment arrives in the error, so it is
 * written straight into the cache: the user sees the current version
 * immediately rather than a spinner followed by a surprise. On
 * `invalid_transition` there is no payload, so the item is refetched.
 *
 * Nothing is resubmitted either way. Replaying an edit against a state the
 * user has not seen is how one device silently undoes another.
 */
function adoptNewerCommitment(client: QueryClient, uid: string, id: string, error: unknown): void {
  if (error instanceof StaleCommitmentError) {
    client.setQueryData(queryKeys.commitment(uid, id), error.current);
    // The validator is gone: the next attempt must read a fresh one rather
    // than retry with the one the server just rejected.
    validators.delete(id);
  }
  if (error instanceof StaleCommitmentError || error instanceof InvalidTransitionError) {
    invalidateCommitments(client, uid, id);
  }
}

export function useCommitmentAction() {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    mutationFn: async (input: { id: string; action: CommitmentAction; postponedUntil?: string }) => {
      const result = await actOnCommitment(input.id, input.action, {
        ...(input.postponedUntil ? { postponedUntil: input.postponedUntil } : {}),
        ...(validatorFor(input.id) ? { ifMatch: validatorFor(input.id) as string } : {}),
      });
      rememberValidator(input.id, result.etag);
      return result.data;
    },
    onSuccess: (_result, input) => invalidateCommitments(client, uid, input.id),
    onError: (error, input) => adoptNewerCommitment(client, uid, input.id, error),
  });
}

export function useDeleteCommitment() {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    mutationFn: (id: string) => deleteCommitment(id, validatorFor(id)),
    onSuccess: (_result, id) => invalidateCommitments(client, uid, id),
    onError: (error, id) => adoptNewerCommitment(client, uid, id, error),
  });
}

/**
 * Records a decision on the next step.
 *
 * A 409 means the proposal went stale — the commitments moved under it — and
 * the only correct response is to show the user the current one rather than
 * silently apply their tap to something else. The refetch happens on error as
 * well as success for exactly that reason.
 */
export function useNextStepDecision() {
  const client = useQueryClient();
  const uid = useUid();
  const locale = apiLocale();
  return useMutation({
    mutationFn: (input: {
      decision: NextStepDecisionKind;
      proposal: NextStepRecommendation;
      editedTitle?: string;
      deferUntil?: string;
    }) =>
      recordNextStepDecision({
        locale,
        decision: input.decision,
        proposal: input.proposal,
        idempotencyKey: Crypto.randomUUID(),
        ...(input.editedTitle ? { editedTitle: input.editedTitle } : {}),
        ...(input.deferUntil ? { deferUntil: input.deferUntil } : {}),
      }),
    /**
     * `done` and `edit` change the commitment itself (UC-2.9, #170), so the
     * lists showing it are stale too. Before those decisions had effects only
     * the proposal needed refreshing; now a completed item would keep sitting
     * on Today until something else happened to invalidate it.
     */
    onSettled: (_result, _error, input) => {
      if (input.decision === 'done' || input.decision === 'edit') {
        invalidateCommitments(client, uid, input.proposal.primaryStep?.commitmentId);
      } else {
        void client.invalidateQueries({ queryKey: ['user', uid, 'nextStep'] });
      }
    },
  });
}

/**
 * Today's plan (UC-3.10b, #195).
 *
 * `null` is data, not an absence: the route answers 404 when no plan was built
 * for that date, `getPlan` turns that into null, and the screen says "no plan
 * for today" instead of an error. So a `data === null` is a settled query, and
 * `data === undefined` is one that has not answered — which is what tells the
 * offline states apart.
 *
 * Nothing about it is persisted. `queryClient.ts` installs no persister and
 * `privacy.test.ts` asserts no module under `src/api` can import device
 * storage, so a plan lives exactly as long as the process does.
 */
export function usePlan(date: string) {
  const uid = useUid();
  return useQuery({
    queryKey: queryKeys.plan(uid, date),
    queryFn: () => getPlan(date),
    enabled: uid !== 'signed-out' && date !== '',
  });
}

/**
 * Everything a plan action changes.
 *
 * The answer *is* the new plan, so it is written straight into the cache rather
 * than invalidated: a refetch would put a spinner over a screen that already
 * knows the answer. The commitment lists are invalidated because an accepted or
 * regenerated plan is a thing that just happened to this account.
 */
function adoptPlan(client: QueryClient, uid: string, date: string, plan: DailyPlan): void {
  client.setQueryData(queryKeys.plan(uid, date), plan);
  void client.invalidateQueries({ queryKey: ['user', uid, 'commitments'] });
  // The next step is derived from the same commitments the plan just moved
  // (Round 2, Phase C): accepting or editing a plan could leave the card
  // suggesting a thing the plan had just placed elsewhere.
  void client.invalidateQueries({ queryKey: ['user', uid, 'nextStep'] });
  void client.invalidateQueries({ queryKey: queryKeys.activity(uid) });
  // An accepted plan is a day with a plan, and the first one a Moment
  // (#201) — both live in the week's summary, which is its own key.
  void client.invalidateQueries({ queryKey: ['user', uid, 'activitySummary'] });
}

/**
 * "Looks good" and "Not today".
 *
 * No optimistic update: both write a *status*, the screen renders that status,
 * and there is nothing under the user's finger that would snap back. The caller
 * guards against a second send — see `PlanScreen`, and `PlanScreen.test.tsx`,
 * which asserts two taps produce one request.
 */
export function usePlanAction(date: string) {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    mutationFn: (action: 'accept' | 'dismiss' | 'accept_proposal' | 'reject_proposal') => actOnPlan(date, { action }),
    onSuccess: plan => adoptPlan(client, uid, date, plan),
  });
}

/**
 * Moving or removing one item, optimistically, with a real rollback.
 *
 * The plan the user was looking at is captured in `onMutate` and restored in
 * `onError`. That is the whole of the acceptance criterion "the item returns to
 * its old time": the 422 does not merely fail, it puts the screen back to the
 * state it was in before the drag.
 *
 * `cancelQueries` first, so a refetch already in flight cannot land on top of
 * the rollback with a copy of the plan from before either.
 */
export function usePlanEdit(date: string) {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    mutationFn: (edit: PlanEdit) => actOnPlan(date, { action: 'edit', ...edit }),
    onMutate: async (edit: PlanEdit) => {
      const key = queryKeys.plan(uid, date);
      await client.cancelQueries({ queryKey: key });
      const previous = client.getQueryData<DailyPlan | null>(key) ?? null;
      if (previous) client.setQueryData(key, applyEditLocally(previous, edit));
      return { previous };
    },
    onError: (_error, _edit, context) => {
      // `context` is undefined only if `onMutate` itself threw, in which case
      // nothing was written and there is nothing to put back.
      if (context) client.setQueryData(queryKeys.plan(uid, date), context.previous);
    },
    onSuccess: plan => adoptPlan(client, uid, date, plan),
  });
}

/**
 * "Build today's plan" (#477).
 *
 * The answer is written into the plan query, so the empty state is replaced by
 * the plan in place. Not optimistic, and not retried, for the reasons "New
 * plan" gives below; the server is idempotent, so a manual retry is safe.
 */
export function useBuildPlan(date: string) {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    mutationFn: (_: void) => buildPlan(date),
    onSuccess: plan => adoptPlan(client, uid, date, plan),
  });
}

/**
 * "New plan".
 *
 * Not retried — mutations never are here — and deliberately not optimistic:
 * nobody can guess what the planner will produce, and showing the old plan
 * until the new one lands is the honest intermediate state.
 */
export function useRegeneratePlan(date: string) {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    mutationFn: (_: void) => regeneratePlan(date),
    onSuccess: plan => adoptPlan(client, uid, date, plan),
  });
}

/**
 * Whether a plan is built each morning, and when.
 *
 * `staleTime: 0` for the same reason `useConsents` has it: this is a switch
 * somebody may have changed on another device, and a control rendered from a
 * stale answer is a control that lies about what the server will do.
 */
export function usePlanSettings() {
  const uid = useUid();
  return useQuery({
    queryKey: queryKeys.planSettings(uid),
    queryFn: getPlanSettings,
    enabled: uid !== 'signed-out',
    staleTime: 0,
  });
}

/**
 * Saves the morning-plan switch and hour.
 *
 * The response is the server's own record, including the `nextRunAt` it
 * computed, so it is adopted rather than assumed — the switch shows what was
 * stored, never what was tapped. `onSettled` invalidates as well, so a failed
 * write snaps the control back to the truth.
 */
export function useSavePlanSettings() {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    mutationFn: (input: { enabled: boolean; deliveryLocalTime?: string }) => putPlanSettings(input),
    onSuccess: settings => client.setQueryData(queryKeys.planSettings(uid), settings),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: queryKeys.planSettings(uid) });
    },
  });
}

/**
 * The financial context (#financial-v1).
 *
 * `staleTime: 0` for the same reason readiness has it: the answer is about a
 * moment — what is due before the next income, and how much is left after it —
 * and a cached copy from this morning is a different claim than the one it
 * looks like.
 */
export function useFinancialContext() {
  const uid = useUid();
  return useQuery({
    queryKey: queryKeys.financialContext(uid),
    queryFn: getFinancialContext,
    enabled: uid !== 'signed-out',
    staleTime: 0,
  });
}

export function useFinancialManual() {
  const uid = useUid();
  return useQuery({
    queryKey: queryKeys.financialManual(uid),
    queryFn: getFinancialManual,
    enabled: uid !== 'signed-out',
  });
}

export function useFinancialConnection() {
  const uid = useUid();
  return useQuery({
    queryKey: queryKeys.financialConnection(uid),
    queryFn: getFinancialConnection,
    enabled: uid !== 'signed-out',
  });
}

/**
 * Every financial write invalidates the context as well as its own list.
 *
 * A correction that did not refresh the context would leave the previous
 * number on screen beside a confirmation that it had been saved, which is the
 * one outcome the whole conflict design is trying to avoid.
 */
function useFinancialMutation<TInput, TResult>(fn: (input: TInput) => Promise<TResult>) {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    mutationFn: fn,
    onSettled: () => {
      void client.invalidateQueries({ queryKey: queryKeys.financialContext(uid) });
      void client.invalidateQueries({ queryKey: queryKeys.financialManual(uid) });
      void client.invalidateQueries({ queryKey: queryKeys.financialConnection(uid) });
    },
  });
}

export function useSaveFinancialField() {
  return useFinancialMutation(putFinancialField);
}

export function useSaveFinancialObligation() {
  return useFinancialMutation(putFinancialObligation);
}

export function useClearFinancialField() {
  return useFinancialMutation(deleteFinancialField);
}

export function useRemoveFinancialObligation() {
  return useFinancialMutation(deleteFinancialObligation);
}

export function useConnectFinancialSource() {
  return useFinancialMutation(() => connectFinancialSource());
}

export function useDisconnectFinancialSource() {
  return useFinancialMutation(() => disconnectFinancialSource());
}

export function useReadiness() {
  const uid = useUid();
  return useQuery({
    queryKey: queryKeys.readiness(uid),
    queryFn: getReadiness,
    enabled: uid !== 'signed-out',
    staleTime: 0,
  });
}

export function useSaveSubjectiveEnergy() {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    mutationFn: (input: { energy: 1 | 2 | 3 | 4 | 5; observedAt: string }) => putSubjectiveEnergy(input),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: queryKeys.readiness(uid) });
      void client.invalidateQueries({ queryKey: ['user', uid, 'plan'] });
      void client.invalidateQueries({ queryKey: ['user', uid, 'nextStep'] });
    },
  });
}

export function useTrustAction() {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    mutationFn: (action: TrustAction) => updateTrust(action),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.trust(uid) });
      void client.invalidateQueries({ queryKey: ['user', uid, 'nextStep'] });
    },
  });
}

export function useReportPilotIncident() {
  return useMutation({ mutationFn: (input: PilotIncidentInput) => reportPilotIncident(input) });
}

export function useRevokeFeedback() {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    mutationFn: (eventId: string) => revokeFeedback(eventId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.feedbackHistory(uid) });
    },
  });
}

export function useAlphaFlag() {
  return useMutation({
    mutationFn: (input: { proposalId: string; category: AlphaFeedbackCategory; note?: string }) =>
      flagAlphaFeedback(input),
  });
}

export function useRecordAnalytics() {
  return useMutation({
    mutationFn: (input: { eventName: ClientReportableEvent; properties?: AnalyticsProperties }) =>
      recordAnalyticsEvent(input.eventName, input.properties ?? {}),
  });
}

/**
 * Reads analytics consent, and only when something is about to be reported.
 *
 * Deliberately not `useTrust()`. This is called from the capture flow, which is
 * mounted for the whole session: a subscription there would fetch the trust
 * record on every app start for the sake of an event most sessions never send.
 * `fetchQuery` answers from the same cache `useTrust` fills, and goes to the
 * network only when nothing fresh is there.
 *
 * It fails closed. A signed-out user, or a read that did not land, is not a
 * user who consented, and the caller reports nothing — an event sent on a
 * guess about somebody's privacy setting is the wrong way round.
 */
export function useAnalyticsConsent(): () => Promise<boolean> {
  const client = useQueryClient();
  const uid = useUid();
  return useCallback(async () => {
    if (uid === 'signed-out') return false;
    const response = await client.fetchQuery({ queryKey: queryKeys.trust(uid), queryFn: getTrust });
    return response.trust.analyticsConsent === true;
  }, [client, uid]);
}

/**
 * Records one consent answer.
 *
 * There is no optimistic update, deliberately. The switch moves when the
 * server says it moved — the alternative shows somebody "AI: on" for the
 * moment before a failed write, which is the one place in this app where a
 * hopeful UI would be a lie about their privacy. `onSettled` refetches so a
 * failure snaps the control back to the truth.
 */
export function useSetAiConsent() {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    mutationFn: (answer: ConsentAnswer) => putAiConsent(answer),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: queryKeys.consents(uid) });
    },
  });
}

/**
 * Answers "notice patterns in when you finish things" (UC-3.16, #202).
 *
 * The memory list is invalidated too: granting it makes suggestions appear on
 * that screen and withdrawing it empties them, so a stale cache would show
 * the opposite of what the toggle just recorded.
 */
export function useSetPersonalizationConsent() {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    mutationFn: (answer: ConsentAnswer) => putPersonalizationConsent(answer),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: queryKeys.consents(uid) });
      void client.invalidateQueries({ queryKey: queryKeys.memory(uid) });
    },
  });
}

export function useSetRecommendationConsent() {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    mutationFn: (answer: ConsentAnswer) => putRecommendationConsent(answer),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: queryKeys.consents(uid) });
      // The next step is gated on this answer, so it is wrong the moment it
      // changes.
      void client.invalidateQueries({ queryKey: ['user', uid, 'nextStep'] });
    },
  });
}

/**
 * Sets where this account writes its commitments (UC-3.1, #185).
 *
 * No optimistic update, for the same reason the consent switches have none: the
 * toggle moves when the server says it moved. Showing "on" for the moment
 * before a failed write would be the app promising to put things in somebody's
 * calendar and then not doing it, and they would find out by looking at an
 * empty calendar rather than at a control that snapped back.
 *
 * Both keys are invalidated. The commitments carry `deviceCalendarLink`, and
 * what the reconcile pass does with those links is decided by the value this
 * mutation just changed.
 */
export function useSetCalendarWriteTarget() {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    mutationFn: (writeTarget: CalendarWriteTarget) => putCalendarWriteTarget(writeTarget),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['user', uid, 'calendarSettings'] });
      void client.invalidateQueries({ queryKey: ['user', uid, 'commitments'] });
    },
  });
}

/**
 * The curated club list, this account's follows, and its currently-active
 * fixture commitments -- one read, one route (football fixtures MVP, Task 11).
 */
export function useFootballSettings() {
  const uid = useUid();
  return useQuery({
    queryKey: queryKeys.football(uid),
    queryFn: getFootballSettings,
    enabled: uid !== 'signed-out',
  });
}

/**
 * Follows or unfollows one club, saving the whole resulting list, which the
 * server projects immediately (see `putFollowedClubs`'s own header). No
 * optimistic update, for the same reason `useSetCalendarWriteTarget` has none:
 * an unknown club id is refused with a 400, and showing a club as followed for
 * the moment before that refusal arrives would be worse than the round-trip.
 *
 * ── One save at a time, each from the latest server answer ───────────────
 * The next list used to be built by the screen from the data it was showing,
 * so a second tap before the first save came back sent a list without the
 * first club and the server replaced one follow with the other. Saves now
 * share a mutation `scope`, which TanStack runs strictly one after another,
 * and each builds its list inside `mutationFn` from the cache as the previous
 * save left it -- `onSuccess` writes the server's answer straight into the
 * cache rather than invalidating it, so there is no refetch for a second save
 * to race. A failed save refetches, so the screen shows what is really saved.
 *
 * The two commitment lists are invalidated too: a save that just projected a
 * season opener is a save that just changed what Today and Upcoming show.
 */
export function useSetFollowedClubs() {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    scope: { id: `football-follows:${uid}` },
    mutationFn: ({ clubId, locale }: { clubId: string; locale: 'ar' | 'he' | 'en' }) => {
      const current = client.getQueryData<FootballSettingsResponse>(queryKeys.football(uid))?.followedClubIds ?? [];
      const next = current.includes(clubId) ? current.filter((id) => id !== clubId) : [...current, clubId];
      return putFollowedClubs(next, locale);
    },
    onSuccess: (data) => {
      client.setQueryData(queryKeys.football(uid), data);
    },
    onError: () => {
      void client.invalidateQueries({ queryKey: queryKeys.football(uid) });
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['user', uid, 'commitments'] });
    },
  });
}

/**
 * "Not this one." Removes a single fixture commitment without touching the
 * follow that produced it -- see `dismissFixture`'s own header for what a
 * 404 here means.
 */
export function useDismissFixture() {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    mutationFn: (commitmentId: string) => dismissFixture(commitmentId),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: queryKeys.football(uid) });
      void client.invalidateQueries({ queryKey: ['user', uid, 'commitments'] });
    },
  });
}

/**
 * Saving the category preference (#415).
 *
 * The lists are invalidated as well as the preference, because turning the
 * split on changes what Today draws and turning a category off changes which
 * chips it can draw. Invalidating only the preference would leave a filter bar
 * offering a category the next capture will no longer produce.
 */
export function useSetCategoryPreferences() {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    mutationFn: (preferences: CategoryPreferences) => putCategoryPreferences(preferences),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: queryKeys.categoryPreferences(uid) });
      void client.invalidateQueries({ queryKey: ['user', uid, 'commitments'] });
    },
  });
}

/** The account's routine profile. `routine: null` means never answered. */
export function useProfile() {
  const uid = useUid();
  return useQuery({
    queryKey: queryKeys.profile(uid),
    queryFn: getProfile,
  });
}

export function usePutRoutine() {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    mutationFn: (profile: RoutineProfilePayload) => putRoutine(profile),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.profile(uid) });
      // Saving the survey supersedes the facts derived from it.
      void client.invalidateQueries({ queryKey: queryKeys.memory(uid) });
      void client.invalidateQueries({ queryKey: ['user', uid, 'nextStep'] });
    },
  });
}

export function useMemory() {
  const uid = useUid();
  return useQuery({
    queryKey: queryKeys.memory(uid),
    queryFn: listMemory,
  });
}

function useMemoryMutation<TInput>(mutationFn: (input: TInput) => Promise<unknown>) {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.memory(uid) });
      // A routine fact edited by hand changes the profile the screen shows.
      void client.invalidateQueries({ queryKey: queryKeys.profile(uid) });
      // And the trust screen, whose "what it knows" counts include memory —
      // the same reason Keep/Dismiss invalidate it (UC-3.16, #202).
      void client.invalidateQueries({ queryKey: queryKeys.trust(uid) });
    },
  });
}

export function useCreateMemory() {
  return useMemoryMutation((input: { kind: 'fact' | 'preference' | 'goal'; content: string; language: 'ar' | 'he' | 'en' | 'mixed' }) =>
    createMemory(input));
}

export function usePatchMemory() {
  return useMemoryMutation((input: { id: string; content: string }) => patchMemory(input.id, input.content));
}

export function useDeleteMemory() {
  return useMemoryMutation((id: string) => deleteMemory(id));
}

export function useDeleteAllMemory() {
  return useMemoryMutation((_: void) => deleteAllMemory());
}

/**
 * Keep or dismiss a suggestion (UC-3.16, #202). Both refresh the list — a kept
 * one moves into it, a dismissed one leaves the suggestions — and the trust
 * screen, whose "what it knows" counts include memory.
 */
export function useMemorySuggestion() {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    mutationFn: (input: { suggestion: MemorySuggestion; decision: 'keep' | 'dismiss'; language: 'ar' | 'he' | 'en' }) =>
      (input.decision === 'keep'
        ? keepMemorySuggestion(input.suggestion, input.language)
        : dismissMemorySuggestion(input.suggestion)),
    onSettled: () => {
      // Settled, not success: a 409 means the suggestion is gone on the
      // server, and the list has to be re-read to stop offering it.
      void client.invalidateQueries({ queryKey: queryKeys.memory(uid) });
      void client.invalidateQueries({ queryKey: queryKeys.trust(uid) });
    },
  });
}

/**
 * Reads a self-description (UC-2.7b, #168).
 *
 * A mutation rather than a query: it costs a model call and must happen once,
 * when the user presses the button, never on a refetch or a remount.
 */
export function useDescribeProfile() {
  return useMutation({
    mutationFn: (text: string) => describeProfile(text),
  });
}

/**
 * Reads an imported profile. No retry: a second attempt is a second model call
 * against a daily cap of three, and the user can press the button again.
 */
export function useImportAiContext() {
  return useMutation({
    mutationFn: (input: { text: string; assistant: ImportAssistant }) =>
      importAiContext(input.text, input.assistant),
    retry: false,
  });
}

export function useConfirmAiContextImport() {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    mutationFn: (input: {
      proposalId: string;
      accepted: Array<{ index: number; content?: string; resolve?: 'replace' | 'keep_both' }>;
    }) => confirmAiContextImport(input.proposalId, input.accepted),
    onSuccess: () => {
      // Two things went stale: the kept rows are memory now, and the Settings
      // row that says when context was last brought over lives on the profile.
      void client.invalidateQueries({ queryKey: queryKeys.memory(uid) });
      void client.invalidateQueries({ queryKey: queryKeys.profile(uid) });
    },
  });
}

export function useConfirmProfileSuggestions() {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    mutationFn: (input: { proposalId: string; accepted: Array<{ index: number; content?: string }> }) =>
      confirmProfileSuggestions(input.proposalId, input.accepted),
    onSuccess: () => {
      // The confirmed facts are memory now, so the "what it knows" screen is
      // out of date the moment this returns.
      void client.invalidateQueries({ queryKey: queryKeys.memory(uid) });
    },
  });
}

/**
 * Gentle reminders: the switch, the lead time and the quiet hours (UC-3.11, #196).
 *
 * `staleTime: 0`, like the consents query and for a related reason: these
 * settings decide whether the phone schedules anything at all, and a stale
 * "on" would have the engine keep scheduling for somebody who turned it off on
 * another device. The answer is one small document.
 */
export function useReminderSettings() {
  const uid = useUid();
  return useQuery({
    queryKey: queryKeys.reminderSettings(uid),
    queryFn: getReminderSettings,
    enabled: uid !== 'signed-out',
    staleTime: 0,
  });
}

/**
 * Saves the three controls.
 *
 * No optimistic update: the switch moves when the server says it moved, for
 * the same reason the consent toggles do not move early. A control that
 * claimed reminders were on before the save landed would be a promise about
 * somebody's evening that the app had not yet made.
 *
 * Quiet hours saved here are stored on the routine profile, so the profile and
 * the memory it derives are both out of date the moment this returns.
 */
export function useSaveReminderSettings() {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    mutationFn: (patch: ReminderSettingsPatch) => putReminderSettings(patch),
    onSettled: (_result, _error, patch) => {
      void client.invalidateQueries({ queryKey: queryKeys.reminderSettings(uid) });
      if (patch.quietHours !== undefined) {
        void client.invalidateQueries({ queryKey: queryKeys.profile(uid) });
        void client.invalidateQueries({ queryKey: queryKeys.memory(uid) });
        // The next step is gated on the same window.
        void client.invalidateQueries({ queryKey: ['user', uid, 'nextStep'] });
      }
    },
  });
}

/* ── Subscribed calendar feeds (UC-3.4, #188) ───────────────────────── */

/**
 * The feeds and the deadlines waiting on the user. Disabled outright when the
 * build's flag is off, so a build without the feature never calls the routes.
 */
export function useIcsFeeds() {
  const uid = useUid();
  return useQuery({
    queryKey: queryKeys.icsFeeds(uid),
    queryFn: listIcsFeeds,
    enabled: uid !== 'signed-out' && icsFeedsEnabled(),
  });
}

/**
 * Subscribing. The URL goes into the request and nowhere else: this mutation
 * has no `onMutate`, no optimistic entry and no `meta`, and TanStack keeps
 * `variables` only on the mutation object the screen holds — which the screen
 * resets the moment the call settles (see `CalendarFeedsScreen`).
 */
export function useCreateIcsFeed() {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    mutationFn: (input: { url: string; label: string | null; autoAcceptDeadlines: boolean }) => createIcsFeed(input),
    // Kept out of the mutation cache's history once it settles, so no copy of
    // the variables outlives the call.
    gcTime: 0,
    onSettled: () => {
      void client.invalidateQueries({ queryKey: queryKeys.icsFeeds(uid) });
    },
  });
}

export function useUpdateIcsFeed() {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    mutationFn: (input: { feedId: string; autoAcceptDeadlines?: boolean; label?: string | null }) => {
      const { feedId, ...changes } = input;
      return updateIcsFeed(feedId, changes);
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: queryKeys.icsFeeds(uid) });
    },
  });
}

export function useRefreshIcsFeed() {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    mutationFn: (feedId: string) => refreshIcsFeed(feedId),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: queryKeys.icsFeeds(uid) });
      // Lectures are busy time, and busy time shapes the plan and the lists.
      void client.invalidateQueries({ queryKey: ['user', uid, 'commitments'] });
    },
  });
}

export function useDeleteIcsFeed() {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    mutationFn: (feedId: string) => deleteIcsFeed(feedId),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: queryKeys.icsFeeds(uid) });
      void client.invalidateQueries({ queryKey: ['user', uid, 'commitments'] });
    },
  });
}

export function useDecideIcsDeadline() {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    mutationFn: (input: { feedId: string; itemKey: string; action: IcsDeadlineAction }) =>
      decideIcsDeadline(input.feedId, input.itemKey, input.action),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: queryKeys.icsFeeds(uid) });
      // Accept, undo and apply-move change commitments.
      void client.invalidateQueries({ queryKey: ['user', uid, 'commitments'] });
      void client.invalidateQueries({ queryKey: queryKeys.activity(uid) });
    },
  });
}


/**
 * The "Considering / Waiting" list (#519).
 *
 * Not keyed by timezone, unlike Today and Upcoming: a seed names no time, so
 * there is no local day for it to be grouped into. That is not an oversight —
 * it is the same fact as "a seed does not enter the Daily Plan", showing up in
 * the cache key.
 */
export function useSeeds() {
  const uid = useUid();
  return useQuery({
    queryKey: queryKeys.seeds(uid),
    queryFn: listSeeds,
    enabled: uid !== 'signed-out',
  });
}

/**
 * Every seed mutation invalidates the same three things, and the third is the
 * one that is easy to forget: promoting a seed writes a commitment or a goal,
 * so Today, Upcoming and the memory list are all now out of date. A screen
 * that showed the seed as promoted while Today still had nothing on it would
 * be the app disagreeing with itself about what just happened.
 */
function useSeedMutation<TInput, TResult>(mutationFn: (input: TInput) => Promise<TResult>) {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.seeds(uid) });
      void client.invalidateQueries({ queryKey: ['user', uid, 'commitments'] });
      void client.invalidateQueries({ queryKey: queryKeys.memory(uid) });
    },
  });
}

/**
 * Keeps a seed the person picked in Review.
 *
 * Unlike the capture confirm, this one *is* safe to retry: the server derives
 * the document id from the request, so a second POST replays the first seed
 * rather than writing a twin. #157's "confirm is never retried" rule is about
 * writing somebody's commitments without them present, which this is not.
 */
export function useKeepSeed() {
  return useSeedMutation((input: { proposalId: string; seedItemId: string }) => keepProposedSeed(input));
}

export function usePatchSeed() {
  return useSeedMutation((input: { id: string; status?: SeedStatus; revisitAt?: string | null; summary?: string }) => {
    const { id, ...patch } = input;
    return patchSeed(id, patch);
  });
}

export function usePromoteSeed() {
  return useSeedMutation((input: { id: string; target: 'commitment' | 'goal' }) =>
    promoteSeed(input.id, input.target));
}

export function useDeleteSeed() {
  return useSeedMutation((id: string) => deleteSeed(id));
}
