import type { PlanningConstraints } from '../../../src/contracts/v1/planningContracts';

export interface TravelEstimate {
  readonly targetEventId: string;
  readonly targetStartsAt: string;
  readonly travelMinutes: number;
  readonly preparationMinutes: number;
  readonly estimatedAt: string;
  readonly originRef: string | null;
  readonly destinationRef: string | null;
}

export interface TravelConstraintApplication {
  readonly targetEventId: string;
  readonly state: 'applied' | 'skipped';
  readonly reason: 'fresh_estimate' | 'missing_location' | 'stale_estimate' | 'target_event_missing';
  readonly departureAt: string | null;
  readonly reservedMinutes: number;
}

export interface TravelProjectionResult {
  readonly constraints: PlanningConstraints;
  readonly applications: readonly TravelConstraintApplication[];
}

const DEFAULT_FRESH_FOR_MS = 6 * 60 * 60 * 1000;

export function projectTravelIntoPlanningConstraints(
  constraints: PlanningConstraints,
  estimates: readonly TravelEstimate[],
  now: string,
  freshForMs = DEFAULT_FRESH_FOR_MS,
): TravelProjectionResult {
  const nowMs = requireInstant(now, 'now');
  const fixedEvents = [...constraints.fixedEvents];
  const applications: TravelConstraintApplication[] = [];
  let changed = false;

  for (const estimate of estimates) {
    validateMinutes(estimate.travelMinutes, 'travelMinutes');
    validateMinutes(estimate.preparationMinutes, 'preparationMinutes');
    const targetStartsMs = requireInstant(estimate.targetStartsAt, 'targetStartsAt');
    const estimatedMs = requireInstant(estimate.estimatedAt, 'estimatedAt');
    const reservedMinutes = estimate.travelMinutes + estimate.preparationMinutes;
    const target = constraints.fixedEvents.find((event) => (
      event.eventId === estimate.targetEventId
      && event.interval.startsAt === estimate.targetStartsAt
    ));

    if (!target) {
      applications.push(skipped(estimate.targetEventId, 'target_event_missing', reservedMinutes));
      continue;
    }
    if (!estimate.originRef || !estimate.destinationRef) {
      applications.push(skipped(estimate.targetEventId, 'missing_location', reservedMinutes));
      continue;
    }
    if (nowMs - estimatedMs > freshForMs) {
      applications.push(skipped(estimate.targetEventId, 'stale_estimate', reservedMinutes));
      continue;
    }
    const departureMs = targetStartsMs - reservedMinutes * 60_000;
    const eventId = `travel:${estimate.targetEventId}`;
    const travelEvent = {
      eventId,
      interval: {
        startsAt: new Date(departureMs).toISOString(),
        endsAt: estimate.targetStartsAt,
      },
      sourceCommitmentId: target.sourceCommitmentId,
      blocking: true,
    } as const;
    const existingIndex = fixedEvents.findIndex((event) => event.eventId === eventId);
    if (existingIndex >= 0) fixedEvents[existingIndex] = travelEvent;
    else fixedEvents.push(travelEvent);
    changed = true;
    applications.push({
      targetEventId: estimate.targetEventId,
      state: 'applied',
      reason: 'fresh_estimate',
      departureAt: travelEvent.interval.startsAt,
      reservedMinutes,
    });
  }

  fixedEvents.sort((left, right) => (
    left.interval.startsAt.localeCompare(right.interval.startsAt)
    || left.eventId.localeCompare(right.eventId)
  ));
  return {
    constraints: changed ? { ...constraints, fixedEvents } : constraints,
    applications,
  };
}

export const TRAVEL_PLANNING_POLICY = Object.freeze({
  staleOrMissingLocationCreatesAssumption: false,
  usesCanonicalPlanningConstraints: true,
  createsSecondScheduler: false,
});

function skipped(
  targetEventId: string,
  reason: Exclude<TravelConstraintApplication['reason'], 'fresh_estimate'>,
  reservedMinutes: number,
): TravelConstraintApplication {
  return { targetEventId, state: 'skipped', reason, departureAt: null, reservedMinutes };
}

function requireInstant(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${field} must be an instant`);
  return parsed;
}

function validateMinutes(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${field} must be non-negative`);
}
