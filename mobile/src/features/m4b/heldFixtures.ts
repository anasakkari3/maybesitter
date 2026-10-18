import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { decideHeldFixture, getHeldItems } from '../../api/endpoints/m4b';
import { HeldChangedError } from '../../api/errors';
import { queryKeys, useUid } from '../../api/queries';
import type { FootballSettingsResponse } from '../../api/schemas/football';
import { useM4bCapability } from './capabilities';

export const heldItemsKey = (uid: string) => ['user', uid, 'heldItems'] as const;

/**
 * «ضيفه» / «مش هاد الماتش» on a held match (M4b R1.3, R1.5).
 *
 * The hold the person saw travels with the answer (`heldVersion`). A hold that
 * changed comes back as `HeldChangedError` carrying the current one, which
 * replaces the row in place — nothing is resubmitted. A fresh key per tap:
 * the server replays a repeated one, so a retry of the same tap is safe.
 */
export function useDecideHeldFixture() {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    mutationFn: (input: { fixtureId: string; action: 'add' | 'dismiss'; heldVersion: string }) =>
      decideHeldFixture(input.fixtureId, input.action, input.heldVersion, Crypto.randomUUID()),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.football(uid) });
      void client.invalidateQueries({ queryKey: heldItemsKey(uid) });
      void client.invalidateQueries({ queryKey: ['user', uid, 'commitments'] });
    },
    onError: (error, input) => {
      if (!(error instanceof HeldChangedError)) return;
      client.setQueryData<FootballSettingsResponse>(queryKeys.football(uid), (current) => {
        if (!current?.held) return current;
        const held = error.held === null
          ? current.held.filter((entry) => entry.fixtureId !== input.fixtureId)
          : current.held.map((entry) => (entry.fixtureId === input.fixtureId ? error.held! : entry));
        return { ...current, held };
      });
    },
  });
}

/** What «يتابع لك» counts — read only while the capability is on. */
export function useHeldItems() {
  const uid = useUid();
  const on = useM4bCapability('externalClashHold');
  return useQuery({
    queryKey: heldItemsKey(uid),
    queryFn: getHeldItems,
    enabled: uid !== 'signed-out' && on,
    retry: false,
  });
}
