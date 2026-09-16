import type { DailyPlan } from '../../api/schemas/plan';
import { PlanEditRefusedError } from '../../api/errors';

/**
 * What somebody did with the plan they were shown (UC-3.10b, #195 step 7).
 *
 * ── Shapes, never contents ───────────────────────────────────────
 *
 * Counts, a generation number, and two small enumerations. Not the titles, not
 * the explanation, and — unlike most events in this app — not the item ids
 * either: a plan's `itemId` *is* a commitment id, so a list of them is a list
 * of what somebody committed to this morning. `EVENT_PROPERTIES` on the server
 * would refuse a title outright, but being refused is not the same as not
 * sending it, and there is no allowlist entry to refuse an id that was allowed
 * elsewhere. So the ids never leave.
 *
 * ── Consent is asked first, and a "maybe" is a no ────────────────
 *
 * The same two-gate shape as `reportCaptureUndone` (#172). The server drops
 * events for a user who declined, so this is the second gate, not the only
 * one — but the server cannot drop a request it was never sent, and a read
 * that throws is treated as a decline rather than as permission.
 *
 * ── Nothing here can reach the person using the app ──────────────
 *
 * Every call is wrapped: a metrics ping that fell over must not turn into a
 * failed accept. The mutation itself is fire-and-forget and is never awaited
 * into anything somebody is waiting on.
 */

/** Consent, read from the server's record, plus somewhere to send the event. */
export interface PlanReporter {
  /** Analytics consent. Fails closed: unknown is not granted. */
  analyticsConsent(): Promise<boolean>;
  /** Fire-and-forget. */
  report(event: PlanEvent): void;
}

export type PlanEvent =
  | { eventName: 'plan_opened'; properties: { generation: number; scheduledCount: number; unscheduledCount: number; explanationSource: string; status: string } }
  | { eventName: 'plan_accepted'; properties: { generation: number; scheduledCount: number; unscheduledCount: number } }
  | { eventName: 'plan_edited'; properties: { movedCount: number; removedCount: number; outcome: 'applied' | 'refused'; reason: string } }
  | { eventName: 'plan_regenerated'; properties: { generation: number } }
  | { eventName: 'plan_dismissed'; properties: { generation: number } };

async function send(reporter: PlanReporter, event: PlanEvent): Promise<void> {
  let granted = false;
  try {
    granted = await reporter.analyticsConsent();
  } catch {
    return;
  }
  if (!granted) return;
  try {
    reporter.report(event);
  } catch {
    // Never the user's problem.
  }
}

/** The plan was put on screen. */
export function reportPlanOpened(plan: DailyPlan, reporter: PlanReporter): Promise<void> {
  return send(reporter, {
    eventName: 'plan_opened',
    properties: {
      generation: plan.generation,
      scheduledCount: plan.scheduled.length,
      unscheduledCount: plan.unscheduled.length,
      explanationSource: plan.explanation.source,
      status: plan.status,
    },
  });
}

/** "Looks good" or "Not today", named by what the person chose. */
export function reportPlanDecision(
  action: 'accept' | 'dismiss',
  plan: DailyPlan,
  reporter: PlanReporter,
): Promise<void> {
  return send(reporter, action === 'accept'
    ? {
      eventName: 'plan_accepted',
      properties: {
        generation: plan.generation,
        scheduledCount: plan.scheduled.length,
        unscheduledCount: plan.unscheduled.length,
      },
    }
    : { eventName: 'plan_dismissed', properties: { generation: plan.generation } });
}

/**
 * A move or a removal, and whether the plan allowed it.
 *
 * A refused edit is reported as well as an accepted one, with the server's own
 * reason code. "How often does the planner refuse what people try to do, and
 * why" is the question this screen exists to answer over time, and counting
 * only the successes would answer it wrong. Anything that is not a refusal —
 * no signal, a 5xx — is not reported at all: it says nothing about the plan.
 */
export function reportPlanEdited(
  edit: { moves?: readonly unknown[]; removals?: readonly unknown[] },
  error: unknown,
  reporter: PlanReporter,
): Promise<void> {
  if (error !== null && error !== undefined && !(error instanceof PlanEditRefusedError)) {
    return Promise.resolve();
  }
  const refusal = error instanceof PlanEditRefusedError ? error : null;
  return send(reporter, {
    eventName: 'plan_edited',
    properties: {
      movedCount: edit.moves?.length ?? 0,
      removedCount: edit.removals?.length ?? 0,
      outcome: refusal ? 'refused' : 'applied',
      reason: refusal ? refusal.reason : 'none',
    },
  });
}

/** A new plan was built, reported with the generation that came back. */
export function reportPlanRegenerated(plan: DailyPlan, reporter: PlanReporter): Promise<void> {
  return send(reporter, { eventName: 'plan_regenerated', properties: { generation: plan.generation } });
}
