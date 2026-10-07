import {
  ApiError,
  FeatureUnavailableError,
  GoalPlanRefusedError,
  NetworkError,
  PlanBuildRefusedError,
  QuotaExceededError,
  ServiceUnavailableError,
  TimeoutError,
} from '../../api/errors';
import { userFacingMessage } from '../../api/ui/userFacingMessage';
import type { Strings } from '../../i18n/strings';

/**
 * What the plan path says when it cannot go on (M3a acceptance 6, image 19).
 *
 * Every known case has its own sentence and one way forward; none of them is
 * «في إشي عنا ما ردّ», the line image 2 showed for a reason the server knew.
 * Only an error nobody named falls through to `userFacingMessage`.
 */
export type PlanRecovery =
  | 'retry' | 'template' | 'rephrase' | 'show_latest' | 'new_times' | 'when_online' | 'answer'
  | 'capture' | 'thoughts' | 'new_plan' | 'pick_another' | 'back_to_goals' | 'see_saved' | 'open_new_goal';

export interface PlanFailure {
  readonly reason: string;
  readonly message: string;
  /** The server's one question, said on its own line (`goal_too_vague`). */
  readonly question?: string;
  /** The first is the button; a second, if any, sits beside it. None: there is nothing to do today. */
  readonly recoveries: readonly PlanRecovery[];
}

export function recoveryLabel(recovery: PlanRecovery, t: Strings): string {
  switch (recovery) {
    case 'retry': return t.xPlanActionRetry;
    case 'template': return t.xPlanActionTemplate;
    case 'rephrase': return t.xPlanActionRephrase;
    case 'show_latest': return t.xPlanActionShowLatest;
    case 'new_times': return t.xPlanActionNewTimes;
    case 'when_online': return t.xPlanActionWhenOnline;
    case 'answer': return t.xPlanActionAnswer;
    case 'capture': return t.xPlanActionToCapture;
    case 'thoughts': return t.xPlanActionToThoughts;
    case 'new_plan': return t.xPlanActionNewPlan;
    case 'pick_another': return t.xPlanActionPickAnother;
    case 'back_to_goals': return t.xPlanActionBackToGoals;
    case 'see_saved': return t.xPlanActionSeeSaved;
    case 'open_new_goal': return t.xPlanActionOpenNewGoal;
  }
}

export function planFailureOf(error: unknown, t: Strings): PlanFailure | null {
  if (error === null || error === undefined) return null;
  // A switched-off module is not a failure to explain: the entries hide.
  if (error instanceof FeatureUnavailableError) return null;
  if (error instanceof GoalPlanRefusedError) return refusal(error, t);
  if (error instanceof NetworkError || error instanceof TimeoutError) {
    return { reason: 'offline', message: t.xPlanFailOffline, recoveries: ['when_online'] };
  }
  if (error instanceof QuotaExceededError) return { reason: 'daily_cap_reached', message: t.xPlanFailDailyCap, recoveries: [] };
  if (error instanceof ServiceUnavailableError) {
    return { reason: 'model_unavailable', message: t.xPlanFailModelUnavailable, recoveries: ['retry', 'template'] };
  }
  return { reason: 'unknown', message: userFacingMessage(error, t), recoveries: ['retry'] };
}

function refusal(error: GoalPlanRefusedError, t: Strings): PlanFailure {
  const { reason, detail } = error;
  switch (reason) {
    case 'model_unavailable':
      return { reason, message: t.xPlanFailModelUnavailable, recoveries: detail.recovery === 'retry' ? ['retry', 'template'] : ['template', 'retry'] };
    case 'daily_cap_reached': return { reason, message: t.xPlanFailDailyCap, recoveries: [] };
    case 'no_steps': return { reason, message: t.xPlanFailNoSteps, recoveries: ['rephrase'] };
    case 'stale': return { reason, message: t.xPlanFailStale, recoveries: ['show_latest'] };
    case 'schedule_changed': return { reason, message: t.xPlanFailScheduleChanged, recoveries: ['new_times'] };
    case 'slot_in_past': return { reason, message: t.xPlanFailSlotInPast, recoveries: ['new_times'] };
    case 'not_free': return { reason, message: t.xPlanFailNotFree, recoveries: ['pick_another'] };
    case 'offline': return { reason, message: t.xPlanFailOffline, recoveries: ['when_online'] };
    case 'goal_too_vague':
      return { reason, message: t.xPlanFailVague, ...(detail.question ? { question: detail.question } : {}), recoveries: ['answer'] };
    case 'not_a_goal':
      return detail.classification === 'thought'
        ? { reason, message: t.xPlanFailThought, recoveries: ['thoughts'] }
        : { reason, message: detail.classification === 'task' ? t.xPlanFailTask : t.xPlanFailEvent, recoveries: ['capture'] };
    case 'too_many_edits': return { reason, message: t.xPlanFailTooManyEdits, recoveries: ['new_plan'] };
    case 'invalid_edit': return { reason, message: t.xPlanFailInvalidEdit, recoveries: ['show_latest'] };
    case 'key_reused': return { reason, message: t.xPlanFailKeyReused, recoveries: ['show_latest'] };
    case 'gone': return { reason, message: t.xPlanFailGone, recoveries: ['back_to_goals'] };
    case 'plan_confirmed': return { reason, message: t.xPlanFailPlanConfirmed, recoveries: ['see_saved'] };
    case 'goal_superseded': return { reason, message: t.xPlanFailGoalSuperseded, recoveries: ['open_new_goal'] };
    // Saved; Today and the Plan are still being updated. The same confirm (same
    // key) finishes it, so «جرّب كمان مرّة» resends exactly that.
    case 'projection_pending': return { reason, message: t.xPlanFailProjectionPending, recoveries: ['retry'] };
  }
}

/**
 * «اعمل خطة اليوم» (image 2): the build's own reason. Read from the typed
 * refusal, or from any error that carries a closed `reason`, so a known case
 * is never said as the generic server line.
 */
export function planBuildFailureOf(error: unknown, t: Strings): string | null {
  if (!error) return null;
  if (error instanceof NetworkError || error instanceof TimeoutError) return t.xPlanBuildOffline;
  if (error instanceof QuotaExceededError) return t.xPlanBuildDailyCap;
  // Any other typed refusal (a date out of range is a 400) keeps the words it
  // already has; only the build's own reason, or an untyped error carrying
  // one, is read here.
  const reason = error instanceof PlanBuildRefusedError ? error.reason
    : error instanceof ApiError ? null
      : typeof (error as { reason?: unknown }).reason === 'string' ? (error as { reason: string }).reason : null;
  switch (reason) {
    case 'nothing_to_plan': return t.xPlanBuildNothing;
    case 'model_unavailable': return t.xPlanBuildModelUnavailable;
    case 'daily_cap_reached': return t.xPlanBuildDailyCap;
    case 'offline': return t.xPlanBuildOffline;
    case null: return userFacingMessage(error, t);
    default: return t.xPlanBuildUnavailable;
  }
}
