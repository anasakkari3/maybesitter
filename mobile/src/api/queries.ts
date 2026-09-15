import { useCallback } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { useTimeZone } from '../i18n/timezone';
import { apiLocale } from '../i18n/locale';
import { useAuth } from '../auth/AuthProvider';
import { clarifyCapture, confirmCapture, proposeCapture } from './endpoints/capture';
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
import { getNextStep, recordNextStepDecision } from './endpoints/nextStep';
import { getTrust, updateTrust } from './endpoints/trust';
import { flagAlphaFeedback, getFeedbackHistory, revokeFeedback } from './endpoints/feedback';
import { recordAnalyticsEvent } from './endpoints/analytics';
import { getConsents, putAiConsent, putRecommendationConsent, type ConsentAnswer } from './endpoints/consents';
import {
  confirmProfileSuggestions,
  describeProfile,
  createMemory,
  deleteAllMemory,
  deleteMemory,
  getProfile,
  listMemory,
  patchMemory,
  putRoutine,
} from './endpoints/profile';
import type { RoutineProfilePayload } from '../features/routine/routineProfile';
import type { NextStepDecisionKind, NextStepRecommendation } from './schemas/nextStep';
import type { TrustAction } from './schemas/trust';
import type { AlphaFeedbackCategory } from './schemas/feedback';
import type { AnalyticsProperties, ClientReportableEvent } from './schemas/analytics';
import { ForbiddenError, InvalidTransitionError, StaleCommitmentError } from './errors';
import { safeCommitmentPatchEnabled } from '../config/env';

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
