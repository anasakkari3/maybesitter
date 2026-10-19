import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { AutoAddEditedError, removeAutoAdd } from '../../../../../../../lib/intelligence/autoAdds';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(request: Request, context: { params: Promise<{ autoAddId: string }> }) {
  let user;
  try { user = await requireMobileUser(request); }
  catch (error) { return mobileAuthErrorResponse(error); }
  const { autoAddId } = await context.params;
  if (!/^[a-f0-9]{64}$/.test(autoAddId)) {
    return Response.json({ success: false, error: 'not_found' }, { status: 404 });
  }
  try {
    const result = await removeAutoAdd(user.uid, autoAddId, new Date().toISOString());
    return result === 'missing'
      ? Response.json({ success: false, error: 'not_found' }, { status: 404 })
      : Response.json({ success: true });
  } catch (error) {
    if (error instanceof AutoAddEditedError) {
      return Response.json({ success: false, error: 'edited' }, { status: 409 });
    }
    throw error;
  }
}
