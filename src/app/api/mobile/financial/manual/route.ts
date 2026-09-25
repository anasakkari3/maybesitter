import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../lib/services/mobile/response';
import { storageFailureCause } from '../../../../../../lib/storage/storageAdapter';
import {
  FinancialValidationError,
  financialValidationResponse,
  parseManualFieldRow,
  parseManualObligationRow,
  requireFinancialFieldId,
} from '../../../../../../lib/services/financial/financialApi';
import { StoredManualFinancialStore } from '../../../../../../lib/services/financial/manualFinancialStore';
import { knownFinancialCurrency } from '../../../../../../lib/services/financial/financialStateService';
import { FINANCIAL_FIELD_AUTHORITY } from '../../../../../../src/contracts/v1/financialContracts';
import { getStorage } from '../../../../../../lib/storage';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../../lib/net/requestBody';

export const dynamic = 'force-dynamic';

function storeFor(uid: string): StoredManualFinancialStore {
  return new StoredManualFinancialStore(uid, getStorage());
}

/**
 * The fields whose value is money, derived from the authority table rather
 * than listed again here, so adding a field cannot leave this set behind.
 * `currency` itself and the instant fields are not amounts.
 */
const NOT_AMOUNTS = new Set(['currency', 'next_income_at', 'recurring_count']);
const AMOUNT_FIELDS = new Set(
  Object.keys(FINANCIAL_FIELD_AUTHORITY).filter((field) => !NOT_AMOUNTS.has(field)),
);

async function hasCurrency(uid: string, now: string): Promise<boolean> {
  return (await knownFinancialCurrency(uid, now)) !== null;
}

/**
 * The refusal that replaces a disappearance.
 *
 * Saving the number and then not showing it is the one outcome worth going out
 * of the way to avoid: the person has no way to tell whether it was rejected,
 * lost, or overruled by something they cannot see.
 */
function currencyFirst(): Response {
  return Response.json(
    { success: false, error: 'set your currency before entering an amount', code: 'currency_required' },
    { status: 409 },
  );
}

/** Everything this account has stated or corrected for themselves. */
export async function GET(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  try {
    return Response.json({ success: true, manual: await storeFor(user.uid).read() });
  } catch (error) {
    console.error('[financial] reading manual financial inputs failed', storageFailureCause(error));
    return mobileError('could not read what you told us', 500);
  }
}

/**
 * State a value, correct one, or add a bill the bank cannot see.
 *
 * One route rather than two because the two bodies are distinguished by what
 * they contain and both replace a single row. `observedAt` is stamped server
 * side — see the note in `financialApi`.
 */
export async function PUT(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return requestBodyTooLargeResponse(error);
    return mobileError('Invalid JSON request body');
  }

  const now = new Date().toISOString();
  try {
    const store = storeFor(user.uid);
    const isObligation = typeof body === 'object' && body !== null && 'amountMinorUnits' in body;
    if (isObligation) {
      // No currency precondition here: an obligation states its own currency,
      // and the builder takes the account's currency from it when nothing else
      // has said. Asking again would be friction with nothing behind it.
      const row = parseManualObligationRow(body, now);
      await store.putObligation(row);
      return Response.json({ success: true, obligation: row });
    }
    const row = parseManualFieldRow(body, now);
    if (AMOUNT_FIELDS.has(row.field) && !(await hasCurrency(user.uid, now))) return currencyFirst();
    await store.putField(row);
    return Response.json({ success: true, field: row });
  } catch (error) {
    if (error instanceof FinancialValidationError) return financialValidationResponse(error);
    console.error('[financial] saving a manual financial input failed', storageFailureCause(error));
    return mobileError('could not save what you told us', 500);
  }
}

/**
 * Take it back.
 *
 * Deleting a field row is the documented way to hand a field back to the
 * provider: the correction stops existing, so the next read resolves the field
 * from whatever the bank says. Deleting an obligation removes a bill the user
 * added. Neither touches anything a provider owns.
 */
export async function DELETE(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const url = new URL(request.url);
  const field = url.searchParams.get('field');
  const obligationId = url.searchParams.get('obligationId');

  try {
    const store = storeFor(user.uid);
    if (field !== null) {
      await store.deleteField(requireFinancialFieldId(field));
    } else if (obligationId !== null) {
      await store.deleteObligation(obligationId);
    } else {
      return mobileError('name a field or an obligationId to remove');
    }
    return Response.json({ success: true });
  } catch (error) {
    if (error instanceof FinancialValidationError) return financialValidationResponse(error);
    console.error('[financial] removing a manual financial input failed', storageFailureCause(error));
    return mobileError('could not remove it', 500);
  }
}
