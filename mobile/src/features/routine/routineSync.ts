/**
 * Deciding what to do with two copies of the survey (UC-2.7a, #167).
 *
 * Pure, so the rule can be read and tested without a device, a clock or a
 * network. `useRoutineSync` is the thin React wrapper around it.
 *
 * ── There is no queue, and that is the point ─────────────────────
 *
 * UC-1.R4 (#157) forbids replaying stored mutations, and a survey is the
 * clearest case for why: a queue of three saves would re-apply two answers the
 * user has already changed their mind about. What the phone holds is a *state*,
 * not a log of intents, and re-sending the current state is idempotent because
 * the route takes the whole profile.
 *
 * So the decision below has exactly three outcomes, and "send the older of two
 * versions" is not one of them.
 */
import type { RoutineCache } from '../../lib/deviceSettings/routineCache';
import { serverCopyWins } from '../../lib/deviceSettings/routineCache';
import { fromRoutinePayload, type RoutineAnswers } from './routineProfile';
import type { RoutineProfile } from '../../api/schemas/profile';

export type RoutineSyncAction =
  /** Nothing to do: the two copies already agree, or neither exists. */
  | { kind: 'idle' }
  /** The device holds something the server has never seen. Send it, once. */
  | { kind: 'push'; cache: RoutineCache }
  /** The server's copy is newer. Adopt it and clear the pending flag. */
  | { kind: 'adopt'; answers: RoutineAnswers; updatedAt: string };

export interface RoutineSyncInput {
  local: RoutineCache | null;
  server: RoutineProfile | null;
  online: boolean;
}

/**
 * What to do, given both copies.
 *
 * ── Offline never means "adopt" ──────────────────────────────────
 *
 * With no network there is no server copy worth trusting — the query returns
 * whatever it last cached — so an offline decision is always `idle`. Adopting a
 * cached server profile over a pending local one is the exact way an answer
 * given on a plane would disappear.
 */
export function decideRoutineSync({ local, server, online }: RoutineSyncInput): RoutineSyncAction {
  if (!online) return { kind: 'idle' };

  if (local?.pendingSync) {
    // The device is ahead by definition: `pendingSync` is only set when a save
    // did not reach the account. Push, and do not look at the server's copy —
    // it is the older one.
    return { kind: 'push', cache: local };
  }

  if (!server) return { kind: 'idle' };

  if (serverCopyWins(local, server.updatedAt)) {
    // Includes the first sign-in on a second device, where there is no local
    // copy at all, and the ordinary case of an edit made elsewhere.
    return { kind: 'adopt', answers: fromRoutinePayload(server), updatedAt: server.updatedAt };
  }

  return { kind: 'idle' };
}

/**
 * True when adopting would actually change what the user sees.
 *
 * The server echoes the same profile back after every save, so without this
 * every successful sync would rewrite the cache with identical answers and
 * re-render the settings screen for nothing.
 */
export function answersDiffer(a: RoutineAnswers, b: RoutineAnswers): boolean {
  return (Object.keys(a) as (keyof RoutineAnswers)[]).some(key => a[key] !== b[key]);
}
