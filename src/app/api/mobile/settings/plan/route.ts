import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../lib/services/mobile/response';
import { PlanSettingsValidationError } from '../../../../../../lib/services/dailyPlan/planSettings';
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

  let body: { enabled?: unknown; deliveryLocalTime?: unknown };
  try {
    body = await request.json();
  } catch {
    return mobileError('Invalid JSON request body');
  }

  if (typeof body.enabled !== 'boolean') return mobileError('enabled must be a boolean');
  if (body.deliveryLocalTime !== undefined && typeof body.deliveryLocalTime !== 'string') {
    return mobileError('deliveryLocalTime must be a string');
  }

  try {
    const settings = await savePlanSettings(
      user.uid,
      {
        enabled: body.enabled,
        ...(body.deliveryLocalTime === undefined ? {} : { deliveryLocalTime: body.deliveryLocalTime }),
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
function settingsDto(settings: { enabled: boolean; deliveryLocalTime: string; timezone: string; nextRunAt?: string }) {
  return {
    enabled: settings.enabled,
    deliveryLocalTime: settings.deliveryLocalTime,
    timezone: settings.timezone,
    nextRunAt: settings.nextRunAt ?? null,
  };
}
