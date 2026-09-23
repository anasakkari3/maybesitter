import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../lib/services/mobile/response';
import { storageFailureCause } from '../../../../../../lib/storage/storageAdapter';
import {
  connectFinancialSandbox,
  disconnectFinancialSandbox,
  financialConnectionId,
} from '../../../../../../lib/services/financial/financialStateService';
import { StoredIntegrationConnectionStore } from '../../../../../../lib/integrations/providers/production/storedConnectionStore';
import { getStorage } from '../../../../../../lib/storage';

export const dynamic = 'force-dynamic';

/** Whether this account has a financial source connected, and which one. */
export async function GET(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  try {
    const store = new StoredIntegrationConnectionStore(user.uid, getStorage());
    const connection = await store.get(financialConnectionId());
    return Response.json({
      success: true,
      connected: connection?.state === 'connected',
      // Named for what it is. A sandbox that presented itself as a bank would
      // be lying in the one screen a person opens to find out what is
      // connected to their money.
      source: connection === null ? null : 'sandbox',
      connectedAt: connection?.connectedAt ?? null,
      capabilities: connection?.capabilities ?? [],
    });
  } catch (error) {
    console.error('[financial] reading the financial connection failed', storageFailureCause(error));
    return mobileError('could not read your financial connection', 500);
  }
}

/**
 * Connect the sandbox source.
 *
 * No OAuth, no token, no vault entry — there is no bank at the other end of
 * this and the record says so. The connection exists so that connecting and
 * disconnecting are real, revocable acts before a real transport arrives, and
 * so the read path has something to refuse when nothing is connected.
 */
export async function POST(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  try {
    const connection = await connectFinancialSandbox(user.uid, new Date().toISOString());
    return Response.json({ success: true, connected: true, source: 'sandbox', connectedAt: connection.connectedAt }, { status: 201 });
  } catch (error) {
    console.error('[financial] connecting the financial sandbox failed', storageFailureCause(error));
    return mobileError('could not connect the financial source', 500);
  }
}

/** Disconnect. What the user typed themselves stays; it was never the bank's. */
export async function DELETE(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  try {
    const removed = await disconnectFinancialSandbox(user.uid);
    return Response.json({ success: true, removed });
  } catch (error) {
    console.error('[financial] disconnecting the financial source failed', storageFailureCause(error));
    return mobileError('could not disconnect the financial source', 500);
  }
}
