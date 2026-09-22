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
 * the answer rather than a refusal.
 *
 * Skipping something already completed answers 409. That is not a retry, it is
 * a second, different decision about a day that is closed. Collapsing the two
 * into "any terminal state is fine" would let a stale phone overwrite a
 * completion with a skip, which the user would see as their record silently
 * changing under them.
 *
 * ── Recovery is reported, never decided here ────────────────────
 *
 * A skip may earn a replacement date, and whether it does is
 * `recoverSkippedOccurrence`'s answer — the policy, the week's remaining
 * capacity, whether a date is left at all. This module adds the replacement to
 * the response when there is one and says why when there is not, and decides
 * neither. The one thing it does add is that a *retried* skip produces no
 * second replacement, which `applyOccurrenceOutcome` gets from the transition
 * being `unchanged` rather than `applied`.
 */
import { mobileError } from '../mobile/response';
import {
  HabitValidationError,
  habitValidationResponse,
  parseHabitId,
  parseOccurrenceId,
  presentOccurrence,
} from './habitApi';
import {
  applyOccurrenceOutcome as applyOutcome,
  createHabitServices,
  todayLocalDateFor,
  type HabitServices,
} from './habitService';
import type { HabitOccurrenceOutcome } from './habitOccurrenceStore';

export interface OccurrenceParams {
  readonly id: string;
  readonly occurrenceId: string;
}

export interface OccurrenceOutcomeOptions {
  /** Injected by tests; production builds one over the ambient storage. */
  readonly services?: HabitServices;
  /** The user's zone, for deciding what "today" a replacement may not precede. */
  readonly timezone?: string;
  readonly now?: Date;
}

/**
 * Applies one outcome to one occurrence, already authenticated.
 *
 * `uid` is the verified token's, never a path segment: the two ids in the URL
 * name a habit and an occurrence *inside that account*, and the store joins
 * them on the pair so that an occurrence cannot be decided through a habit it
 * does not belong to.
 */
export async function respondToOccurrenceOutcome(
  uid: string,
  params: OccurrenceParams,
  outcome: HabitOccurrenceOutcome,
  options: OccurrenceOutcomeOptions = {},
): Promise<Response> {
  try {
    const habitId = parseHabitId(params.id);
    const occurrenceId = parseOccurrenceId(params.occurrenceId);
    const services = options.services ?? createHabitServices();
    const today = todayLocalDateFor(options.now ?? new Date(), options.timezone);

    const { transition, recovery } = await applyOutcome(
      services,
      uid,
      habitId,
      occurrenceId,
      outcome,
      today,
    );

    if (transition.kind === 'not_found') return mobileError('no such occurrence', 404);
    if (transition.kind === 'conflict') {
      return Response.json({
        success: false,
        error: `this occurrence is already ${transition.occurrence.state}`,
        occurrence: presentOccurrence(transition.occurrence),
      }, { status: 409 });
    }

    return Response.json({
      success: true,
      occurrence: presentOccurrence(transition.occurrence),
      // So a client can tell a retry from a first press without comparing the
      // state it sent to the state it got back.
      changed: transition.kind === 'applied',
      // Present only when recovery was actually consulted. Absent, a null
      // replacement and a declined one are three different facts: nothing was
      // asked, a replacement exists, and one was refused with a reason.
      ...(recovery === null ? {} : {
        recovery: recovery.kind === 'recovered'
          ? { recovered: true, replacement: presentOccurrence(recovery.replacement) }
          : { recovered: false, reason: recovery.reason },
      }),
    });
  } catch (error) {
    if (error instanceof HabitValidationError) return habitValidationResponse(error);
    console.error(`[habits] marking an occurrence ${outcome} failed`, error);
    return mobileError(`could not mark the occurrence ${outcome}`, 500);
  }
}
