/**
 * Where a transaction history stops being a transaction history.
 *
 * Raw payloads come in from a `FinancialDataPort` and what leaves is totals,
 * dates, counts and closed-union categories. No merchant name, description,
 * provider id or masked account number is copied into the result, and none is
 * kept anywhere else either — the rows exist for the duration of this
 * function and are then garbage.
 *
 * ── Why the text is read at all ──────────────────────────────────
 *
 * Descriptions are run through `untrustedExternalContentBoundary` before being
 * dropped. A statement line is attacker-controlled text: anyone who can send
 * this person money can write into their transaction feed. Nothing downstream
 * ever sees the string, so this cannot be a prompt injection today; recording
 * the signal is how the account that is being probed becomes visible before
 * some later feature makes it matter.
 *
 * ── Why a category and not a name ────────────────────────────────
 *
 * "Rent, 3,500, due the 1st" is the whole of what a person needs to see a
 * tight month coming. The landlord's registered company name adds nothing to
 * that and is exactly the kind of detail that should not accumulate in a
 * planning app, so obligations from a provider are anonymous by construction
 * and only text the user typed themselves is ever shown as a label.
 */
import { createHash } from 'node:crypto';
import type { FinancialObligationCategory, FinancialObservationEntry } from '../../../src/contracts/v1/financialContracts';
import {
  detectExternalInstructionSignals,
  type ExternalInstructionSignal,
} from '../providers/untrustedExternalContent';
import type {
  FinancialDataPort,
  FinancialRecurringStreamPayload,
  FinancialStreamFrequency,
  FinancialTransactionPayload,
} from './port';

/** Confidence the provider's own detection earns, by how sure the provider says it is. */
const STREAM_CONFIDENCE: Readonly<Record<'mature' | 'early_detection', number>> = Object.freeze({
  mature: 0.9,
  early_detection: 0.5,
});

/**
 * A cadence inferred from a handful of rows is a weaker claim than a cadence
 * the provider's own detector stands behind, and the number says so.
 */
const INFERRED_INCOME_CONFIDENCE = 0.45;

const BALANCE_CONFIDENCE = 0.95;

/** How many times a stale prediction may be rolled forward before giving up. */
const MAX_INCOME_ROLL_FORWARD = 24;

/**
 * Monthly equivalent of one period, as an exact integer ratio.
 *
 * `unknown` is absent on purpose: a stream whose cadence the provider could
 * not work out has no monthly equivalent, and picking one — monthly, say —
 * would quietly invent an obligation the person does not have.
 */
const MONTHLY_RATIO: Readonly<Partial<Record<FinancialStreamFrequency, readonly [number, number]>>> =
  Object.freeze({
    weekly: [52, 12],
    biweekly: [26, 12],
    monthly: [1, 1],
    annually: [1, 12],
  });

const CATEGORY_BY_PREFIX: readonly (readonly [string, FinancialObligationCategory])[] = Object.freeze([
  ['RENT_AND_UTILITIES_RENT', 'rent'],
  ['RENT_AND_UTILITIES', 'utility'],
  ['LOAN_PAYMENTS_CREDIT_CARD', 'card'],
  ['LOAN_PAYMENTS_STUDENT', 'tuition'],
  ['LOAN_PAYMENTS', 'loan'],
  ['EDUCATION', 'tuition'],
  ['ENTERTAINMENT_SUBSCRIPTION', 'subscription'],
  ['GENERAL_SERVICES_SUBSCRIPTION', 'subscription'],
] as const);

export interface ObservedObligation {
  /** Derived from the provider key, never the key itself. */
  readonly obligationId: string;
  readonly category: FinancialObligationCategory;
  readonly dueAt: string;
  readonly amountMinorUnits: number;
  readonly currency: string;
  readonly recurring: boolean;
}

export interface NormalizedFinancialObservations {
  readonly connectionId: string;
  readonly observedAt: string;
  readonly currency: FinancialObservationEntry<string> | null;
  readonly cashAvailable: FinancialObservationEntry<number> | null;
  readonly nextIncomeAt: FinancialObservationEntry<string> | null;
  readonly nextIncomeAmount: FinancialObservationEntry<number> | null;
  readonly fixedMonthlyObligations: FinancialObservationEntry<number> | null;
  readonly recurringCount: FinancialObservationEntry<number> | null;
  readonly obligations: readonly ObservedObligation[];
  readonly injectionSignals: readonly ExternalInstructionSignal[];
  readonly trust: 'untrusted_external_content';
  readonly privilegedActionAllowed: false;
}

export interface NormalizeFinancialInput {
  readonly connectionId: string;
  /** The instant this reading is of. No clock is read in here. */
  readonly asOf: string;
  /** How far back transactions are requested. Only used for the income fallback. */
  readonly lookbackDays?: number;
}

export function financialObligationCategory(categoryCode: string): FinancialObligationCategory {
  const code = categoryCode.toUpperCase();
  const match = CATEGORY_BY_PREFIX.find(([prefix]) => code.startsWith(prefix));
  return match ? match[1] : 'other';
}

export async function normalizeFinancialObservations(
  port: FinancialDataPort,
  input: NormalizeFinancialInput,
): Promise<NormalizedFinancialObservations> {
  const since = new Date(Date.parse(input.asOf) - (input.lookbackDays ?? 120) * 86_400_000).toISOString();
  const request = { connectionId: input.connectionId, since, until: input.asOf };

  const [accounts, balances, transactions, recurring] = await Promise.all([
    port.listAccounts(request),
    port.listBalances(request),
    port.listTransactions(request),
    port.listRecurring(request),
  ]);

  const entry = <T extends number | string>(value: T, confidence: number): FinancialObservationEntry<T> => ({
    value,
    observedAt: input.asOf,
    confidence,
    connectionId: input.connectionId,
  });

  /* Cash is what sits in accounts that hold money. A credit line's "available"
     figure is headroom to borrow, which is the opposite of what this number is
     for, so only depository accounts are counted. */
  const spendable = new Set(accounts.filter((account) => account.type === 'depository').map((a) => a.accountId));
  const cashRows = balances.filter((row) => spendable.has(row.accountId));
  const currencies = new Set(cashRows.map((row) => row.currency.toUpperCase()));

  /* Two currencies cannot be added. Reporting their sum as one number would be
     a figure that is wrong in every currency, so the answer is "not known". */
  const currency = currencies.size === 1 ? Array.from(currencies)[0]! : null;
  const cashAvailable = currency === null || cashRows.length === 0
    ? null
    : cashRows.reduce((total, row) => total + (row.availableMinorUnits ?? row.currentMinorUnits), 0);

  const live = recurring.filter((stream) => stream.status !== 'tombstoned');
  const outflows = live.filter((stream) => stream.direction === 'outflow');
  const inflows = live.filter((stream) => stream.direction === 'inflow');

  const monthly = outflows.reduce((total, stream) => {
    const ratio = MONTHLY_RATIO[stream.frequency];
    return ratio ? total + Math.round((stream.averageAmountMinorUnits * ratio[0]) / ratio[1]) : total;
  }, 0);
  const hasMonthlyBasis = outflows.some((stream) => MONTHLY_RATIO[stream.frequency] !== undefined);

  const income = nextIncomeFromStreams(inflows, input.asOf) ?? nextIncomeFromTransactions(transactions, input.asOf);

  const obligations = outflows
    .filter((stream) => stream.predictedNextDate !== null)
    .map((stream) => ({
      obligationId: obligationIdFor(input.connectionId, stream.streamId),
      category: financialObligationCategory(stream.categoryCode),
      dueAt: stream.predictedNextDate!,
      amountMinorUnits: stream.averageAmountMinorUnits,
      currency: stream.currency.toUpperCase(),
      recurring: true,
    }))
    .sort((a, b) => (a.dueAt === b.dueAt ? a.obligationId.localeCompare(b.obligationId) : a.dueAt.localeCompare(b.dueAt)));

  return {
    connectionId: input.connectionId,
    observedAt: input.asOf,
    currency: currency === null ? null : entry(currency, BALANCE_CONFIDENCE),
    cashAvailable: cashAvailable === null ? null : entry(cashAvailable, BALANCE_CONFIDENCE),
    nextIncomeAt: income === null ? null : entry(income.at, income.confidence),
    nextIncomeAmount: income === null ? null : entry(income.amountMinorUnits, income.confidence),
    fixedMonthlyObligations: hasMonthlyBasis ? entry(monthly, STREAM_CONFIDENCE.mature) : null,
    recurringCount: recurring.length === 0 ? null : entry(outflows.length, STREAM_CONFIDENCE.mature),
    obligations,
    injectionSignals: signalsIn(transactions, recurring),
    trust: 'untrusted_external_content',
    privilegedActionAllowed: false,
  };
}

/**
 * The derived key for one obligation.
 *
 * Scoped by connection as well as by stream so the same provider key seen on
 * two different connections cannot collide, and hashed so the provider's own
 * id — which may itself encode an account number — is not what the UI renders
 * or what a log line prints.
 */
function obligationIdFor(connectionId: string, streamId: string): string {
  return createHash('sha256').update(`financial\0${connectionId}\0${streamId}`).digest('hex').slice(0, 32);
}

function nextIncomeFromStreams(
  inflows: readonly FinancialRecurringStreamPayload[],
  asOf: string,
): { at: string; amountMinorUnits: number; confidence: number } | null {
  const upcoming = inflows
    .filter((stream) => stream.predictedNextDate !== null && stream.predictedNextDate > asOf)
    .sort((a, b) => a.predictedNextDate!.localeCompare(b.predictedNextDate!));
  const soonest = upcoming[0];
  if (!soonest) return null;
  return {
    at: soonest.predictedNextDate!,
    amountMinorUnits: soonest.averageAmountMinorUnits,
    confidence: STREAM_CONFIDENCE[soonest.status === 'mature' ? 'mature' : 'early_detection'],
  };
}

/**
 * The fallback, for the very common case of a provider that returns
 * transactions but has not detected a salary stream.
 *
 * Two income rows are the minimum: one row is an event, two are the first
 * evidence of a rhythm. The gap used is the median rather than the mean, so a
 * single advance or delayed payment does not drag the prediction with it.
 */
function nextIncomeFromTransactions(
  transactions: readonly FinancialTransactionPayload[],
  asOf: string,
): { at: string; amountMinorUnits: number; confidence: number } | null {
  const income = transactions
    .filter((row) => row.amountMinorUnits > 0 && row.categoryCode.toUpperCase().startsWith('INCOME'))
    .sort((a, b) => a.postedAt.localeCompare(b.postedAt));
  if (income.length < 2) return null;

  const gaps: number[] = [];
  for (let i = 1; i < income.length; i += 1) {
    gaps.push(Date.parse(income[i]!.postedAt) - Date.parse(income[i - 1]!.postedAt));
  }
  gaps.sort((a, b) => a - b);
  const gap = gaps[Math.floor(gaps.length / 2)]!;
  if (gap <= 0) return null;

  const last = income[income.length - 1]!;
  let next = Date.parse(last.postedAt) + gap;
  const asOfMs = Date.parse(asOf);
  for (let i = 0; next <= asOfMs && i < MAX_INCOME_ROLL_FORWARD; i += 1) next += gap;
  if (next <= asOfMs) return null;

  return {
    at: new Date(next).toISOString(),
    amountMinorUnits: last.amountMinorUnits,
    confidence: INFERRED_INCOME_CONFIDENCE,
  };
}

/**
 * Signals only. The text that produced them is not returned and not stored —
 * what survives is the fact that someone wrote an instruction into this
 * account's feed.
 */
function signalsIn(
  transactions: readonly FinancialTransactionPayload[],
  recurring: readonly FinancialRecurringStreamPayload[],
): readonly ExternalInstructionSignal[] {
  const found = new Set<ExternalInstructionSignal>();
  const texts = [
    ...transactions.flatMap((row) => [row.description, row.merchantName ?? '']),
    ...recurring.map((stream) => stream.merchantName ?? ''),
  ];
  for (const text of texts) {
    for (const signal of detectExternalInstructionSignals(text)) found.add(signal);
  }
  return Object.freeze(Array.from(found).sort());
}
