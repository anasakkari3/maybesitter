import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { resolveSmartPostpone } from '../../../../../../../lib/release/m4bCapabilities';
import { postponeSlots } from '../../../../../../../lib/planning/postponeSlots';

export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireMobileUser(request); } catch (error) { return mobileAuthErrorResponse(error); }
  if (!resolveSmartPostpone()) return Response.json({ success: false, error: 'feature_unavailable' }, { status: 404 });
  try {
    const result = await postponeSlots(user.uid, (await params).id);
    if (!result) return Response.json({ success: false, error: 'not_found' }, { status: 404 });
    return Response.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof Error && error.message === 'not_postponable') return Response.json({ success: false, error: 'not_postponable' }, { status: 409 });
    throw error;
  }
}
