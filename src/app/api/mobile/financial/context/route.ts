import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../lib/services/mobile/response';
import { storageFailureCause } from '../../../../../../lib/storage/storageAdapter';
import { readFinancialState } from '../../../../../../lib/services/financial/financialStateService';

export const dynamic = 'force-dynamic';

/**
 * This account's financial context, as of now (#financial-v1).
 *
 * The state is built for the request and not stored. `asOf` is stamped here,
 * by the server, and travels in the response, so a client rendering it can
 * always say when it was true rather than implying it is true now.
 *
 * What comes back has no transaction in it, by construction rather than by
 * filtering: `FinancialState` has no field one could occupy.
 */
export async function GET(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  try {
    const state = await readFinancialState({ uid: user.uid, asOf: new Date().toISOString() });
    return Response.json({ success: true, state });
  } catch (error) {
    /*
     * A short cause, never the error object.
     *
     * The repo already logs full errors for most routes and strips them only
     * on the way to a client, which is the right trade when the worst thing in
     * the message is a document path. It is the wrong trade here: an upstream
     * failure can quote the payload it choked on, and that payload is somebody's
     * statement lines. `storageFailureCause` is a name and a shape, nothing
     * more, and it is all that reaches the log.
     */
    console.error('[financial] building the financial context failed', storageFailureCause(error));
    return mobileError('could not read your financial context', 500);
  }
}
