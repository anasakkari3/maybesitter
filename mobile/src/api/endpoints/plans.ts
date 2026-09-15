import { apiRequest } from '../client';
import { NotFoundError, ValidationError } from '../errors';
import {
  planResponseSchema,
  planSettingsResponseSchema,
  type DailyPlan,
  type PlanSettings,
} from '../schemas/plan';

/**
 * The daily plan routes (UC-3.10a #194, rendered by UC-3.10b #195).
 *
 * ── 404 is an answer, not a failure ──────────────────────────────
 *
 * `GET` answers 404 when no plan was built for that date, and the route says
 * why in its own comment: "no plan was built for you today" and "a plan was
 * built and it is empty" are different things to tell somebody. So `getPlan`
 * resolves `null` rather than throwing, and the screen shows "no plan for
 * today" instead of an error with a Retry that cannot help. Every other
 * failure — no signal, a 5xx, a contract drift — still throws, because those
 * are not "there is no plan".
 *
 * ── The date is validated before it reaches a URL ────────────────
 *
 * A plan date arrives from a deep link, which is a string a stranger chose
 * (`src/links.ts`). The server validates it too; this refuses to *build* the
 * request at all, so an unexpected shape never becomes a path segment.
 */

const PLAN_DATE = /^\d{4}-\d{2}-\d{2}$/;

function planPath(date: string, suffix = ''): string {
  if (!PLAN_DATE.test(date)) throw new ValidationError('a plan date must be YYYY-MM-DD');
  return `/api/mobile/plans/${date}${suffix}`;
}

/** One move. `endsAt` is always sent, so the length is never the server's guess. */
export interface PlanMove {
  itemId: string;
  startsAt: string;
  endsAt: string;
}

export interface PlanEdit {
  moves?: readonly PlanMove[];
  removals?: readonly string[];
}

export type PlanActionBody =
  | { action: 'accept' }
  | { action: 'dismiss' }
  | ({ action: 'edit' } & PlanEdit);

/** That date's plan, or null when none was built. */
export async function getPlan(date: string): Promise<DailyPlan | null> {
  try {
    const response = await apiRequest('GET', planPath(date), { schema: planResponseSchema });
    return response.plan;
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}

/**
 * Accept, dismiss, or edit.
 *
 * All three answer the whole plan rather than an acknowledgement, so nothing
 * here re-reads to find out what its own call did. A refused edit is a 422 and
 * arrives as `PlanEditRefusedError`, carrying the reason and the item.
 */
export async function actOnPlan(date: string, body: PlanActionBody): Promise<DailyPlan> {
  const response = await apiRequest('POST', planPath(date, '/actions'), {
    body,
    schema: planResponseSchema,
  });
  return response.plan;
}

/**
 * Rebuilds the plan from what the commitments say now.
 *
 * The cap is the server's (`MAX_PLAN_GENERATIONS_PER_DAY`), and it answers 429
 * once it is reached — which `apiRequest` turns into a `QuotaExceededError`.
 * The screen stops offering the button before that, from the generation it can
 * already see; the 429 is the second line, for a rebuild another device spent.
 */
export async function regeneratePlan(date: string): Promise<DailyPlan> {
  const response = await apiRequest('POST', planPath(date, '/regenerate'), {
    body: {},
    schema: planResponseSchema,
  });
  return response.plan;
}

export async function getPlanSettings(): Promise<PlanSettings> {
  const response = await apiRequest('GET', '/api/mobile/settings/plan', {
    schema: planSettingsResponseSchema,
  });
  return response.planSettings;
}

/**
 * Turns the morning plan on or off, and sets the hour.
 *
 * `deliveryLocalTime` is omitted rather than sent as undefined when the caller
 * is only flipping the switch: the route reads `body.deliveryLocalTime !==
 * undefined` and would otherwise be asked to re-validate a time nobody changed.
 */
export async function putPlanSettings(input: {
  enabled: boolean;
  deliveryLocalTime?: string;
}): Promise<PlanSettings> {
  const response = await apiRequest('PUT', '/api/mobile/settings/plan', {
    body: {
      enabled: input.enabled,
      ...(input.deliveryLocalTime === undefined ? {} : { deliveryLocalTime: input.deliveryLocalTime }),
    },
    schema: planSettingsResponseSchema,
  });
  return response.planSettings;
}
