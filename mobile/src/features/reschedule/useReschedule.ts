import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { decideReschedule, getReschedule } from '../../api/endpoints/reschedule';
import { useUid } from '../../api/queries';

/**
 * Under `commitments`, so everything that moves a commitment (done, «لسّا», a
 * plan change) refreshes the card with it.
 */
export const rescheduleKey = (uid: string) => ['user', uid, 'commitments', 'reschedule'] as const;

/** Missed work's new plan (lane E4). Off on the server (404) or failing, it is simply absent. */
export function useReschedule() {
  const uid = useUid();
  return useQuery({
    queryKey: rescheduleKey(uid),
    queryFn: () => getReschedule({ asUid: uid }),
    enabled: uid !== 'signed-out',
    retry: false,
  });
}

/**
 * «اقبل» / «مش هلّق» / «رجّعها». One key per tap: a repeat of the same request
 * is answered as a replay by the server, never applied twice; never retried
 * on its own. Whatever the answer, the card and the lists are read again — a
 * stale proposal (409) comes back as the fresh one on the next read.
 */
export function useDecideReschedule() {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    mutationFn: (input: { commitmentId: string; action: 'accept' | 'dismiss' | 'undo'; proposalId?: string }) =>
      decideReschedule(input.commitmentId, {
        action: input.action,
        clientActionId: Crypto.randomUUID(),
        ...(input.proposalId ? { proposalId: input.proposalId } : {}),
      }, { asUid: uid }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['user', uid, 'commitments'] });
      void client.invalidateQueries({ queryKey: ['user', uid, 'nextStep'] });
      void client.invalidateQueries({ queryKey: ['user', uid, 'plan'] });
    },
  });
}
