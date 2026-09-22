/**
 * "I did it" and "not today", as one decision made in one place (#520).
 *
 * The two routes — `/habits/{id}/occurrences/{occurrenceId}/complete` and
 * `.../skip` — differ in exactly one word, so they share everything below
 * except the guard. The guard stays in each route file deliberately:
 * `tests/auth/routeGuardCoverage.test.ts` counts one `requireMobileUser` per
 * exported handler *in the route file*, and a shared helper that authenticated
 * on their behalf would satisfy the routes while emptying the census that
 * catches the route nobody remembered to guard.
 *
 * ── Why a repeat is not a conflict, and a reversal is ────────────
 *
 * Completing something already completed answers 200 with the occurrence
 * unchanged. A phone that retried a request whose answer it never saw must get
 * the answer rather than a refusal — this repo has a test suite named after
 * that exact rule for commitment actions.
 *
 * Skipping something already completed answers 409. That is not a retry, it is
 * a second, different decision about a day that is closed, and the two are
 * distinguishable here precisely because the first case is handled above it.
 * Collapsing them into "any terminal state is fine" would let a stale phone
 * overwrite a completion with a skip, which the user would see as their streak
 * silently breaking.
 */
import { mobileError } from '../services/mobile/response';
import {
  HabitValidationError,
  habitValidationResponse,
  parseHabitId,
  parseOccurrenceId,
  presentOccurrence,
} from './habitApi';
import { getHabitStore, habitsEnabled } from './habitStore';
import type { HabitOccurrenceOutcome } from './habitTypes';

export interface OccurrenceParams {
  readonly id: string;
  readonly occurrenceId: string;
}

/**
 * Applies one outcome to one occurrence, already authenticated.
 *
 * `uid` is the verified token's, never a path segment: the two ids in the URL
 * name a habit and an occurrence *inside that account*, and the store joins
 * them on the pair so that an occurrence cannot be decided through a habit it
 * does not belong to.
 */
export async function applyOccurrenceOutcome(
  uid: string,
  params: OccurrenceParams,
  outcome: HabitOccurrenceOutcome,
): Promise<Response> {
  if (!habitsEnabled()) return mobileError('habits are not enabled in this build', 503);

  try {
    const habitId = parseHabitId(params.id);
    const occurrenceId = parseOccurrenceId(params.occurrenceId);
    const result = await getHabitStore().transitionOccurrence(uid, habitId, occurrenceId, outcome);

    switch (result.kind) {
      case 'not_found':
        return mobileError('no such occurrence', 404);
      case 'conflict':
        return Response.json({
          success: false,
          error: `this occurrence is already ${result.occurrence.state}`,
          occurrence: presentOccurrence(result.occurrence),
        }, { status: 409 });
      case 'unchanged':
      case 'applied':
        return Response.json({
          success: true,
          occurrence: presentOccurrence(result.occurrence),
          // So a client can tell a retry from a first press without comparing
          // the state it sent to the state it got back.
          changed: result.kind === 'applied',
        });
    }
  } catch (error) {
    if (error instanceof HabitValidationError) return habitValidationResponse(error);
    console.error(`[habits] marking an occurrence ${outcome} failed`, error);
    return mobileError(`could not mark the occurrence ${outcome}`, 500);
  }
}
