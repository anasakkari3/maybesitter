import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../lib/services/mobile/response';
import {
  HardReceiptValidationError,
  parseHardReceiptUpload,
  recordHardReceipts,
} from '../../../../../../lib/services/reminders/hardReceipts';

export const dynamic = 'force-dynamic';

/**
 * "These Must reminders will ring on this phone" (UC-3.12b, #198).
 *
 * The app drains its receipt queue here after every reminder sync and when it
 * comes back to the foreground. A receipt is what stands the server's backup
 * push down, so it is accepted only for the reminder it names — the index row
 * at exactly that instant, still pending — and ignored otherwise.
 *
 * Answers 200 with a count either way. An ignored receipt is not an error the
 * phone can do anything about: the reminder it described has moved or has
 * already been dealt with, and the next sync reports the current one. Only a
 * body the server could not read is a 400, because that is a bug rather than a
 * race, and the phone must not retry it for ever.
 */
export async function POST(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return mobileError('Invalid JSON request body');
  }

  try {
    const upload = parseHardReceiptUpload(body);
    const result = await recordHardReceipts(user.uid, upload, new Date());
    return Response.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof HardReceiptValidationError) {
      return Response.json({ success: false, error: error.message, reason: error.reason }, { status: 400 });
    }
    return mobileError(error instanceof Error ? error.message : 'could not record the receipts', 500);
  }
}
