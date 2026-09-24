import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../lib/services/mobile/response';
import { PlanSettingsValidationError, type PlanSettings } from '../../../../../../lib/services/dailyPlan/planSettings';
import { readPlanSettings, savePlanSettings } from '../../../../../../lib/services/dailyPlan/dailyPlanService';

export const dynamic = 'force-dynamic';

/** What this account has chosen: whether a plan is built, and when (UC-3.10a, #194). */
export async function GET(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }
  const settings = await readPlanSettings(user.uid);
  return Response.json({ success: true, planSettings: settingsDto(settings) });
}

/**
 * Turns the morning plan on or off, and sets the hour.
 *
 * The response carries `nextRunAt` so the client can show "your next plan
 * arrives …" from the server's own arithmetic instead of recomputing a DST
 * boundary on the phone.
 */
export async function PUT(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  let body: { enabled?: unknown; deliveryLocalTime?: unknown; continuousReplanEnabled?: unknown };
  try {
    body = await request.json();
  } catch {
    return mobileError('Invalid JSON request body');
  }

  // `enabled` may be left out only by a write that is about the replanning
  // switch (#523) — which then leaves the morning delivery untouched. Every
  // other PUT still has to say whether the morning plan is on.
  const replanOnly = body.enabled === undefined && body.continuousReplanEnabled !== undefined;
  if (!replanOnly && typeof body.enabled !== 'boolean') return mobileError('enabled must be a boolean');
  if (body.deliveryLocalTime !== undefined && typeof body.deliveryLocalTime !== 'string') {
    return mobileError('deliveryLocalTime must be a string');
  }
  // #523, AC 9. An API field, not a screen: the switch the client renders is
  // the mobile lane's, and this is the contract it saves through.
  if (body.continuousReplanEnabled !== undefined && typeof body.continuousReplanEnabled !== 'boolean') {
    return mobileError('continuousReplanEnabled must be a boolean');
  }

  try {
    const settings = await savePlanSettings(
      user.uid,
      {
        ...(replanOnly ? {} : { enabled: body.enabled as boolean }),
        ...(body.deliveryLocalTime === undefined ? {} : { deliveryLocalTime: body.deliveryLocalTime }),
        ...(body.continuousReplanEnabled === undefined
          ? {}
          : { continuousReplanEnabled: body.continuousReplanEnabled }),
      },
      new Date(),
    );
    return Response.json({ success: true, planSettings: settingsDto(settings) });
  } catch (error) {
    if (error instanceof PlanSettingsValidationError) {
      return Response.json({ success: false, error: error.message, reason: error.reason }, { status: 400 });
    }
    return mobileError(error instanceof Error ? error.message : 'could not save the plan settings', 500);
  }
}

/** `nextRunAt` is optional on the record and always present on the wire, as null. */
function settingsDto(settings: PlanSettings) {
  return {
    enabled: settings.enabled,
    deliveryLocalTime: settings.deliveryLocalTime,
    timezone: settings.timezone,
    nextRunAt: settings.nextRunAt ?? null,
    /**
     * `!== false`, not `=== true`, and not `?? DEFAULT_…` either.
     *
     * `planSettingsOf` is the one place the default is applied, so no second
     * fallback belongs here — but the narrowing this needs is not free of a
     * choice: `=== true` is itself a default, of *false*, and it is the
     * opposite of the one the gate makes. `processStateChangesForUser` treats
     * anything that is not literally `false` as enabled, so an `undefined`
     * that somehow reached either side would have shown the user a switch in
     * the OFF position while the backend went on replanning — the worst
     * possible reading of a control. `!== false` is the same test the gate
     * makes, written the same way round.
     */
    continuousReplanEnabled: settings.continuousReplanEnabled !== false,
  };
}
