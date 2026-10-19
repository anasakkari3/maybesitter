import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { listAutoAdds } from '../../../../../../lib/intelligence/autoAdds';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  let user;
  try { user = await requireMobileUser(request); }
  catch (error) { return mobileAuthErrorResponse(error); }
  const url = new URL(request.url);
  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit === null ? 20 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
    return Response.json({ success: false, error: 'invalid_request' }, { status: 400 });
  }
  const result = await listAutoAdds(user.uid, { cursor: url.searchParams.get('cursor'), limit });
  return Response.json({ success: true, ...result });
}
