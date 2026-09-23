/**
 * The one interface a financial data source has to implement.
 *
 * ── Why this file has four verbs and will never have a fifth ─────
 *
 * Reading someone's balances and writing a payment out of them are the same
 * API to an aggregator and two completely different products to a regulator, a
 * user and an on-call engineer. The separation is enforced here, at the type
 * level: there is no `initiatePayment`, no `transfer`, no `createRecipient`,
 * and no generic `call(endpoint)` escape hatch. A transport cannot move money
 * through an interface with no verb for it, so "read-only" is not a policy
 * somebody has to remember to check — it is the shape of the seam.
 *
 * ── Why the payloads are raw ─────────────────────────────────────
 *
 * These types carry merchant names, descriptions, masked account numbers and
 * provider transaction ids: the real, sensitive shape a bank aggregator
 * returns. That is deliberate. This is the last layer that sees them. The
 * adapter next door turns them into totals and dates and lets the rest go, and
 * `tests/financial/financialSerializationLeak.test.ts` proves nothing on this
 * page reaches a response body or a log line.
 */

export type FinancialAccountType = 'depository' | 'credit' | 'loan' | 'investment' | 'other';

export interface FinancialAccountPayload {
  /** The provider's own account id. Never used as a document id or returned to a client. */
  readonly accountId: string;
  readonly name: string;
  readonly accountNumberMasked: string | null;
  readonly type: FinancialAccountType;
  readonly currency: string;
}

export interface FinancialBalancePayload {
  readonly accountId: string;
  /** What the account holder can actually spend, when the provider distinguishes it. */
  readonly availableMinorUnits: number | null;
  readonly currentMinorUnits: number;
  readonly currency: string;
  readonly observedAt: string;
}

export interface FinancialTransactionPayload {
  readonly transactionId: string;
  readonly accountId: string;
  readonly postedAt: string;
  /** Signed: positive is money arriving, negative is money leaving. */
  readonly amountMinorUnits: number;
  readonly currency: string;
  readonly merchantName: string | null;
  readonly description: string;
  /** The provider's own category enum, e.g. `INCOME_WAGES`. Not free text. */
  readonly categoryCode: string;
}

export type FinancialStreamFrequency =
  | 'weekly'
  | 'biweekly'
  | 'monthly'
  | 'annually'
  | 'unknown';

export type FinancialStreamStatus = 'mature' | 'early_detection' | 'tombstoned';

export interface FinancialRecurringStreamPayload {
  readonly streamId: string;
  readonly accountId: string;
  readonly direction: 'inflow' | 'outflow';
  /** Magnitude, always positive; `direction` carries the sign. */
  readonly averageAmountMinorUnits: number;
  readonly currency: string;
  readonly frequency: FinancialStreamFrequency;
  readonly lastDate: string;
  readonly predictedNextDate: string | null;
  readonly merchantName: string | null;
  readonly categoryCode: string;
  readonly status: FinancialStreamStatus;
}

export interface FinancialReadRequest {
  readonly connectionId: string;
  /** Inclusive lower bound for time-ranged reads. */
  readonly since: string | null;
  /** Exclusive upper bound for time-ranged reads. */
  readonly until: string | null;
}

export interface FinancialDataPort {
  listAccounts(request: FinancialReadRequest): Promise<readonly FinancialAccountPayload[]>;
  listBalances(request: FinancialReadRequest): Promise<readonly FinancialBalancePayload[]>;
  listTransactions(request: FinancialReadRequest): Promise<readonly FinancialTransactionPayload[]>;
  listRecurring(request: FinancialReadRequest): Promise<readonly FinancialRecurringStreamPayload[]>;
}

/**
 * Restated as data so a test can assert it rather than a reviewer having to
 * notice it.
 */
export const FINANCIAL_PORT_POLICY = Object.freeze({
  readOnly: true,
  paymentVerbs: 0,
  genericPassthroughVerb: false,
  touchesCredentialVault: false,
});
