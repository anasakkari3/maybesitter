import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import {
  decideHeldFixture,
  HeldActionKeyReusedError,
  HeldChangedError,
  HeldFixtureNotFoundError,
} from '../../../../../../../lib/football/projectFixtures';
import { resolveExternalClashHold } from '../../../../../../../lib/release/m4bCapabilities';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../../../lib/net/requestBody';

export const dynamic = 'force-dynamic';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function POST(request: Request, { params }: { params: Promise<{ fixtureId: string }> }) {
  let user;
  try { user = await requireMobileUser(request); } catch (error) { return mobileAuthErrorResponse(error); }
  if (!resolveExternalClashHold()) return Response.json({ success: false, error: 'feature_unavailable' }, { status: 404 });
  let body: unknown;
  try { body = await readJsonBody(request); } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return requestBodyTooLargeResponse(error);
    return Response.json({ success: false, error: 'invalid_request' }, { status: 400 });
  }
  const value = body as Record<string, unknown> | null;
  if (!value || Array.isArray(value) || !['add', 'dismiss'].includes(String(value.action))
    || typeof value.expectedHeldVersion !== 'string' || typeof value.clientActionId !== 'string'
    || !UUID.test(value.clientActionId) || Object.keys(value).some((key) => !['action', 'expectedHeldVersion', 'clientActionId'].includes(key))) {
    return Response.json({ success: false, error: 'invalid_request' }, { status: 400 });
  }
  try {
    const result = await decideHeldFixture(user.uid, (await params).fixtureId, value as unknown as { action: 'add' | 'dismiss'; expectedHeldVersion: string; clientActionId: string });
    return Response.json({ success: true, ...result, ...(result.replayed ? { replayed: true } : {}) });
  } catch (error) {
    if (error instanceof HeldChangedError) return Response.json({ success: false, error: 'held_changed', held: error.held }, { status: 409 });
    if (error instanceof HeldActionKeyReusedError) return Response.json({ success: false, error: 'key_reused' }, { status: 409 });
    if (error instanceof HeldFixtureNotFoundError) return Response.json({ success: false, error: 'not_found' }, { status: 404 });
    throw error;
  }
}
