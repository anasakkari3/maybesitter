import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../lib/services/mobile/response';
import {
  composeCurrentUserState,
  saveNormalizedReadinessSnapshot,
  saveSubjectiveEnergyCheckIn,
} from '../../../../../lib/userState/userStateService';
import type { ReadinessSnapshot } from '../../../../../src/contracts/v1/readinessContracts';

export const dynamic = 'force-dynamic';

async function mobileUser(
  request: Request,
): Promise<{ readonly user: Awaited<ReturnType<typeof requireMobileUser>> } | { readonly response: Response }> {
  try {
    return { user: await requireMobileUser(request) } as const;
  } catch (error) {
    return { response: mobileAuthErrorResponse(error) } as const;
  }
}

async function bodyOf(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export async function GET(request: Request): Promise<Response> {
  const auth = await mobileUser(request);
  if ('response' in auth) return auth.response;
  try {
    const current = await composeCurrentUserState({
      uid: auth.user.uid,
      now: new Date().toISOString(),
    });
    return Response.json({
      readiness: current.projection.readiness,
      selectedSource: current.readiness.selectedSource,
      freshness: current.readiness.freshness,
    });
  } catch (error) {
    return mobileError(error instanceof Error ? error.message : 'could not read readiness', 500);
  }
}

/** Saves an explicit energy check-in. The authenticated account is the only scope. */
export async function PUT(request: Request): Promise<Response> {
  const auth = await mobileUser(request);
  if ('response' in auth) return auth.response;
  const body = record(await bodyOf(request));
  if (!body) return mobileError('Invalid JSON request body');
  try {
    const result = await saveSubjectiveEnergyCheckIn(auth.user.uid, {
      energy: body.energy as 1 | 2 | 3 | 4 | 5,
      observedAt: body.observedAt as string,
    });
    return Response.json({ success: true, result });
  } catch (error) {
    if (error instanceof TypeError) {
      return Response.json({ success: false, error: error.message, reason: 'invalid_check_in' }, { status: 400 });
    }
    return mobileError(error instanceof Error ? error.message : 'could not save energy', 500);
  }
}

/** Saves a privacy-minimized native health summary, never a raw provider payload. */
export async function POST(request: Request): Promise<Response> {
  const auth = await mobileUser(request);
  if ('response' in auth) return auth.response;
  const body = record(await bodyOf(request));
  const snapshot = record(body?.snapshot);
  if (!snapshot) return mobileError('Invalid JSON request body');
  const kinds = Array.isArray(snapshot.sourceKinds) ? snapshot.sourceKinds : [];
  if (kinds.length === 0 || kinds.some((kind) => kind !== 'healthkit' && kind !== 'health_connect')) {
    return Response.json(
      { success: false, error: 'mobile readiness accepts native health sources only', reason: 'invalid_source' },
      { status: 400 },
    );
  }
  try {
    const result = await saveNormalizedReadinessSnapshot(auth.user.uid, {
      ...snapshot,
      scopeId: auth.user.uid,
    } as unknown as ReadinessSnapshot);
    return Response.json({ success: true, result });
  } catch (error) {
    if (error instanceof TypeError) {
      return Response.json({ success: false, error: error.message, reason: 'invalid_snapshot' }, { status: 400 });
    }
    return mobileError(error instanceof Error ? error.message : 'could not save readiness', 500);
  }
}
