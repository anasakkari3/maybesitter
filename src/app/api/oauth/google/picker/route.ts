import { pickerExpiredPage, pickerPage } from '../../../../../../lib/integrations/google/googleBrowserPages';
import { redeemDrivePickTicket } from '../../../../../../lib/integrations/google/googleDrive';
import { googleRuntime } from '../../../../../../lib/integrations/google/googleRuntime';

export const dynamic = 'force-dynamic';

/**
 * The page that hosts Google Picker (CL6a).
 *
 * Opened in the system browser with a one-time ticket that an authenticated
 * route minted two minutes ago at most. A ticket that is unknown, expired or
 * already spent sends the browser straight back to the app; it never renders
 * a page, and it never says which of the three it was.
 */
export async function GET(request: Request) {
  const ticket = new URL(request.url).searchParams.get('ticket');
  const runtime = googleRuntime();
  const config = await redeemDrivePickTicket(ticket, runtime).catch(() => null);
  if (!config) return pickerExpiredPage();
  return pickerPage(config, runtime.random);
}
