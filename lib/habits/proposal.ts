/**
 * The one door from "the person said something" to "the product asks for their
 * time" (#520).
 *
 * ── The invariant, and why it is a shape rather than a rule ─────
 *
 * Onboarding says «بدي أتمرّن ٣ مرات بالأسبوع». That is a sentence, and #520's
 * critical invariant is that a sentence never becomes a Habit by itself.
 *
 * The enforcement is not a check somewhere that a future route could skip. A
 * `HabitProposal` has no `habitId`, no `status`, no `createdAt` and no
 * `confirmation`, so it is not assignable to `HabitDefinition` and no spread
 * or cast produces one; and `confirmHabitProposal` — the only function here
 * that yields something a store will accept — takes the cadence and the
 * duration from its *confirmation* argument and never from the proposal. A
 * caller that meant to use the suggestion has to copy it across deliberately,
 * which is the issue's "the user must explicitly confirm its cadence and
 * duration" rendered as something the compiler checks.
 *
 * This is the Seed flow (#519) again, and on purpose. There, too, every arrow
 * to the right is a user action and there is no confidence field for anything
 * to cross a threshold on.
 *
 * ── What is not in this file ────────────────────────────────────
 *
 * No function takes free text. Nothing here imports the memory module, the
 * extractor, or a model client. Whatever produces a proposal does so
 * elsewhere and hands one in already shaped; this module's job is to make sure
 * the only way onward is through a person. `tests/habits/habitBoundaries.
 * test.ts` asserts the import closure, because the natural next commit is a
 * convenience helper that takes a string.
 */

import {
  HABIT_MAX_DURATION_MINUTES,
  HabitValidationError,
  cadenceOccurrencesPerPeriod,
  parseHabitCadence,
  type HabitCadence,
  type HabitConfirmationInput,
  type HabitDefinitionInput,
  type HabitProposal,
  type HabitSource,
  type HabitTimeWindow,
} from '../../src/contracts/v1/habitContracts';

export interface HabitProposalInput {
  readonly proposalId: string;
  readonly scopeId: string;
  readonly title: string;
  readonly suggestedCadence: HabitCadence;
  readonly suggestedDurationMinutes: number;
  readonly suggestedPreferredWindows?: readonly HabitTimeWindow[];
  /** The goal, memory record or onboarding answer this came from. An id. */
  readonly sourceRef: string;
  readonly source: Exclude<HabitSource, 'user_created'>;
}

/**
 * Build a suggestion. It is a screen's worth of pre-filled fields and nothing
 * else: creating one writes nothing, asks for no time, and is invisible to
 * the planner, because a planner cannot see a type it is never handed.
 */
export function buildHabitProposal(input: HabitProposalInput, now: string): HabitProposal {
  if (typeof input.proposalId !== 'string' || input.proposalId === '') {
    throw new HabitValidationError('proposalId must be a non-empty string');
  }
  if (typeof input.sourceRef !== 'string' || input.sourceRef === '') {
    // A proposal with no origin cannot be shown honestly — the screen has to be
    // able to say which goal this came from, and a habit's confirmation record
    // carries the same id onward so the two stay connected afterwards.
    throw new HabitValidationError('sourceRef must name the goal or answer this came from');
  }
  return Object.freeze({
    proposalId: input.proposalId,
    scopeId: input.scopeId,
    title: input.title,
    suggestedCadence: parseHabitCadence(input.suggestedCadence, 'suggestedCadence'),
    suggestedDurationMinutes: requireDuration(input.suggestedDurationMinutes, 'suggestedDurationMinutes'),
    suggestedPreferredWindows: Object.freeze([...(input.suggestedPreferredWindows ?? [])]),
    sourceRef: input.sourceRef,
    source: input.source,
    createdAt: now,
  });
}

/**
 * The confirmation. Produces an *input* — still not a habit: the store mints
 * the id and stamps the timestamps, exactly as it does for one the user typed.
 *
 * `confirmedByUserAt` is the instant of the act, passed in rather than read
 * from a clock here, so the receipt names when the person pressed the button
 * and not when some job got round to processing it.
 */
export function confirmHabitProposal(
  proposal: HabitProposal,
  confirmation: HabitConfirmationInput,
  confirmedByUserAt: string,
): HabitDefinitionInput {
  // Required, not defaulted from the proposal. Deleting these two lines is the
  // way this invariant would actually be lost, so they are asserted directly.
  if (confirmation === null || typeof confirmation !== 'object') {
    throw new HabitValidationError('a habit is created only from an explicit confirmation');
  }
  if (confirmation.cadence === undefined || confirmation.durationMinutes === undefined) {
    throw new HabitValidationError('the confirmation must state a cadence and a duration');
  }
  if (typeof confirmedByUserAt !== 'string' || Number.isNaN(Date.parse(confirmedByUserAt))) {
    throw new HabitValidationError('confirmedByUserAt must be an ISO-8601 instant');
  }

  const cadence = parseHabitCadence(confirmation.cadence);
  const durationMinutes = requireDuration(confirmation.durationMinutes, 'durationMinutes');
  const perPeriod = cadenceOccurrencesPerPeriod(cadence);
  const maximumOccurrences = confirmation.maximumOccurrences ?? perPeriod;
  const minimumOccurrences = confirmation.minimumOccurrences ?? perPeriod;

  return Object.freeze({
    scopeId: proposal.scopeId,
    title: confirmation.title ?? proposal.title,
    cadence,
    durationMinutes,
    preferredWindows: Object.freeze([
      ...(confirmation.preferredWindows ?? proposal.suggestedPreferredWindows),
    ]),
    minimumOccurrences,
    maximumOccurrences,
    // A habit born from a goal is flexible unless the person said otherwise.
    // Defaulting the other way would let a confirmed suggestion out-rank the
    // commitments the user entered by hand.
    flexibility: confirmation.flexibility ?? 'flexible',
    recoveryPolicy: confirmation.recoveryPolicy ?? 'skip',
    source: proposal.source,
    confirmation: Object.freeze({
      confirmedByUserAt,
      sourceRef: proposal.proposalId,
      acceptedSuggestedValues: sameCadence(cadence, proposal.suggestedCadence)
        && durationMinutes === proposal.suggestedDurationMinutes,
    }),
  });
}

function requireDuration(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)
    || value < 1 || value > HABIT_MAX_DURATION_MINUTES) {
    throw new HabitValidationError(
      `${label} must be a whole number of minutes between 1 and ${HABIT_MAX_DURATION_MINUTES}`,
    );
  }
  return value;
}

function sameCadence(left: HabitCadence, right: HabitCadence): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'weekly_count') return left.count === (right as typeof left).count;
  const theirs = (right as typeof left).weekdays;
  return left.weekdays.length === theirs.length
    && left.weekdays.every((weekday, index) => weekday === theirs[index]);
}
