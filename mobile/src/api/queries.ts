import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { useTimeZone } from '../i18n/timezone';
import { apiLocale } from '../i18n/locale';
import { useAuth } from '../auth/AuthProvider';
import { confirmCapture, proposeCapture } from './endpoints/capture';
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
import { getNextStep, recordNextStepDecision } from './endpoints/nextStep';
import { getTrust, updateTrust } from './endpoints/trust';
import { flagAlphaFeedback, getFeedbackHistory, revokeFeedback } from './endpoints/feedback';
import { recordAnalyticsEvent } from './endpoints/analytics';
import type { NextStepDecisionKind, NextStepRecommendation } from './schemas/nextStep';
import type { TrustAction } from './schemas/trust';
import type { AlphaFeedbackCategory } from './schemas/feedback';
import type { AnalyticsProperties, ClientReportableEvent } from './schemas/analytics';

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
  today: (uid: string, timezone: string) => ['user', uid, 'commitments', 'today', timezone] as const,
  upcoming: (uid: string, timezone: string) => ['user', uid, 'commitments', 'upcoming', timezone] as const,
  commitment: (uid: string, id: string) => ['user', uid, 'commitment', id] as const,
  nextStep: (uid: string, locale: string) => ['user', uid, 'nextStep', locale] as const,
  trust: (uid: string) => ['user', uid, 'trust'] as const,
  feedbackHistory: (uid: string) => ['user', uid, 'feedbackHistory'] as const,
};

/** The signed-in uid, or the one value that can never collide with one. */
function useUid(): string {
  return useAuth().user?.uid ?? 'signed-out';
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
    queryFn: () => getCommitment(id as string),
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
export function useConfirmCapture() {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    mutationFn: (input: { proposalId: string; itemIds: string[] }) =>
      confirmCapture({ ...input, idempotencyKey: Crypto.randomUUID() }),
    onSuccess: () => invalidateCommitments(client, uid),
  });
}

export function usePatchCommitment() {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    // `patch` is spread from `buildTimePatch`, so a plain move carries only
    // `dueDate` and the server keeps the reminder lead the user set.
    mutationFn: (input: { id: string; patch: CommitmentPatch }) => patchCommitment(input.id, input.patch),
    onSuccess: (_result, input) => invalidateCommitments(client, uid, input.id),
  });
}

export function useCommitmentAction() {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    mutationFn: (input: { id: string; action: CommitmentAction; postponedUntil?: string }) =>
      actOnCommitment(input.id, input.action, input.postponedUntil),
    onSuccess: (_result, input) => invalidateCommitments(client, uid, input.id),
  });
}

export function useDeleteCommitment() {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    mutationFn: (id: string) => deleteCommitment(id),
    onSuccess: (_result, id) => invalidateCommitments(client, uid, id),
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
    }) =>
      recordNextStepDecision({
        locale,
        decision: input.decision,
        proposal: input.proposal,
        idempotencyKey: Crypto.randomUUID(),
        ...(input.editedTitle ? { editedTitle: input.editedTitle } : {}),
      }),
    onSettled: () => {
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
