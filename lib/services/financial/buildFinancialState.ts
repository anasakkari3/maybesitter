/**
 * The projection: resolved fields in, one timestamped picture out.
 *
 * ── Why `asOf` is a required argument ────────────────────────────
 *
 * Every question this state answers is a question about a moment. "What is
 * due before your next income" is a different answer at 09:00 on the 23rd and
 * at 09:00 on the 29th, and a builder that read a clock would answer whichever
 * one it happened to be called at while looking, to its caller, like a
 * property of the data. So the instant comes in as an argument, the function
 * is pure, and the same inputs always produce the same bytes.
 *
 * ── Why so much of this returns null ─────────────────────────────
 *
 * A summary that fills its gaps is unusable: the person reading it cannot tell
 * a real zero from a missing input, and the first time they act on a
 * confident-looking wrong number is the last time they trust any of it. So
 * every number here is produced only when every input it needs is present and
 * commensurable, and is null otherwise.
 */
import {
  FINANCIAL_CONTRACT_VERSION,
  FINANCIAL_SCHEMA_VERSION,
  FINANCIAL_SOURCE_KINDS,
  type DerivedAmount,
  type DerivedCount,
  type DerivedInstant,
  type FinancialConflict,
  type FinancialFieldId,
  type FinancialFieldValue,
  type FinancialManualEntry,
  type FinancialObligation,
  type FinancialObservationEntry,
  type FinancialProvenance,
  type FinancialSourceKind,
  type FinancialState,
} from '../../../src/contracts/v1/financialContracts';
import type { NormalizedFinancialObservations } from '../../integrations/financial/adapter';
import { resolveFinancialField, type ResolvedFinancialField } from './fieldPrecedence';
import type { ManualFinancialInputs } from './manualFinancialInputs';

export interface BuildFinancialStateInput {
  readonly scopeId: string;
  /** The instant this picture is of. Required; no clock is read in here. */
  readonly asOf: string;
  readonly observations: readonly NormalizedFinancialObservations[];
  readonly manual: ManualFinancialInputs;
}

/** The provider-side entry each field reads, named once so the wiring is visible. */
const PROVIDER_FIELD_READERS: Readonly<
  Record<FinancialFieldId, (o: NormalizedFinancialObservations) => FinancialObservationEntry<FinancialFieldValue> | null>
> = Object.freeze({
  currency: (o) => o.currency,
  cash_available: (o) => o.cashAvailable,
  next_income_at: (o) => o.nextIncomeAt,
  next_income_amount: (o) => o.nextIncomeAmount,
  fixed_monthly_obligations: (o) => o.fixedMonthlyObligations,
  recurring_count: (o) => o.recurringCount,
  // No aggregator reports what somebody is saving towards.
  savings_goal: () => null,
});

export function buildFinancialState(input: BuildFinancialStateInput): FinancialState {
  const conflicts: FinancialConflict[] = [];
  const used = new Set<FinancialSourceKind>();

  const resolve = (field: FinancialFieldId): ResolvedFinancialField<FinancialFieldValue> => {
    const provider = input.observations
      .map((observation) => PROVIDER_FIELD_READERS[field](observation))
      .filter((entry): entry is FinancialObservationEntry<FinancialFieldValue> => entry !== null);
    const manual = input.manual.fields
      .filter((row) => row.field === field)
      .map((row): FinancialManualEntry<FinancialFieldValue> => ({
        value: row.value,
        observedAt: row.observedAt,
        confidence: 1,
        connectionId: null,
        kind: row.kind,
      }));
    const resolved = resolveFinancialField({ field, provider, manual });
    if (resolved.conflict) conflicts.push(resolved.conflict);
    if (resolved.provenance?.origin === 'provider' || resolved.provenance?.origin === 'manual') {
      used.add(resolved.provenance.origin);
    }
    return resolved;
  };

  const currencyField = resolve('currency');
  const cash = resolve('cash_available');
  const incomeAt = resolve('next_income_at');
  const incomeAmount = resolve('next_income_amount');
  const fixedMonthly = resolve('fixed_monthly_obligations');
  const recurring = resolve('recurring_count');
  const savings = resolve('savings_goal');

  /* Falling back to the currency on the user's own bills, when nothing else
     has said. Somebody who typed "tuition, 2,000, ILS" has stated a currency
     as surely as if they had filled in a currency box, and making them fill in
     the box as well would be asking for something they already gave. Only when
     their bills agree: two currencies is the same unanswerable question it is
     for two accounts. */
  const currency = typeof currencyField.value === 'string'
    ? currencyField.value
    : soleCurrencyOf(input.manual.obligations);

  /* An amount is a number plus a unit. Without a resolved currency the number
     alone is not an amount, and rendering it beside a guessed symbol is how a
     person reads a shekel balance as dollars. */
  const amount = (field: ResolvedFinancialField<FinancialFieldValue>): DerivedAmount | null =>
    currency !== null && typeof field.value === 'number' && field.provenance !== null
      ? { minorUnits: field.value, currency, provenance: field.provenance }
      : null;

  const obligations = upcomingObligations(input);

  /* A "next income" already behind us is not a next income. A stored reading
     or a hand-entered payday goes stale the moment it passes, and carrying it
     forward would produce a window that runs backwards — which sums to a
     confident zero, the one answer that is indistinguishable from "nothing is
     due". Past means unknown. */
  const nextIncomeIsAhead = typeof incomeAt.value === 'string' && incomeAt.value > input.asOf;
  const nextIncomeAt = nextIncomeIsAhead && incomeAt.provenance !== null
    ? ({ at: incomeAt.value as string, provenance: incomeAt.provenance } satisfies DerivedInstant)
    : null;
  if (input.manual.obligations.length > 0) used.add('manual');
  if (input.observations.some((observation) => observation.obligations.length > 0)) used.add('provider');

  const cashAvailable = amount(cash);
  const dueBeforeIncome = obligationsDueBefore(obligations, input.asOf, nextIncomeAt, currency);
  const freeBuffer = subtract(cashAvailable, dueBeforeIncome);

  return {
    version: FINANCIAL_CONTRACT_VERSION,
    schemaVersion: FINANCIAL_SCHEMA_VERSION,
    scopeId: input.scopeId,
    asOf: input.asOf,
    currency,
    cashAvailable,
    nextIncomeAt,
    nextIncomeAmount: nextIncomeAt === null ? null : amount(incomeAmount),
    obligationsBeforeNextIncome: dueBeforeIncome,
    fixedMonthlyObligations: amount(fixedMonthly),
    recurringCount: typeof recurring.value === 'number' && recurring.provenance !== null
      ? ({ value: recurring.value, provenance: recurring.provenance } satisfies DerivedCount)
      : null,
    freeBuffer,
    bufferBand: bandOf(freeBuffer, dueBeforeIncome),
    upcomingObligations: obligations,
    savingsGoal: amount(savings),
    sourceKinds: Object.freeze(Array.from(used).sort()),
    missingSourceKinds: Object.freeze(FINANCIAL_SOURCE_KINDS.filter((kind) => !used.has(kind))),
    conflicts: Object.freeze(conflicts),
  };
}

function soleCurrencyOf(rows: readonly { readonly currency: string }[]): string | null {
  const found = new Set(rows.map((row) => row.currency.toUpperCase()));
  return found.size === 1 ? Array.from(found)[0]! : null;
}

/**
 * Everything still ahead of the person, from both sources, in one list.
 *
 * Provider rows keep their null label — the category is all they ever carry —
 * and the user's rows keep the words the user chose. Sorted by when it is due
 * and then by id, so two reads of the same data cannot come back in different
 * orders.
 */
function upcomingObligations(input: BuildFinancialStateInput): readonly FinancialObligation[] {
  const fromProvider = input.observations.flatMap((observation) =>
    observation.obligations.map((obligation): FinancialObligation => ({
      obligationId: obligation.obligationId,
      label: null,
      category: obligation.category,
      dueAt: obligation.dueAt,
      amount: {
        minorUnits: obligation.amountMinorUnits,
        currency: obligation.currency,
        provenance: {
          origin: 'provider',
          contributingSources: ['provider'],
          observedAt: observation.observedAt,
          confidence: 0.9,
          connectionId: observation.connectionId,
        },
      },
      recurring: obligation.recurring,
    })),
  );

  const fromUser = input.manual.obligations.map((row): FinancialObligation => ({
    obligationId: row.obligationId,
    label: row.label,
    category: row.category,
    dueAt: row.dueAt,
    amount: {
      minorUnits: row.amountMinorUnits,
      currency: row.currency,
      provenance: {
        origin: 'manual',
        contributingSources: ['manual'],
        observedAt: row.observedAt,
        confidence: 1,
        connectionId: null,
      },
    },
    recurring: row.recurring,
  }));

  return Object.freeze(
    [...fromProvider, ...fromUser]
      .filter((obligation) => obligation.dueAt >= input.asOf)
      .sort((a, b) =>
        a.dueAt === b.dueAt ? a.obligationId.localeCompare(b.obligationId) : a.dueAt.localeCompare(b.dueAt),
      ),
  );
}

/**
 * What falls due between now and the next money arriving.
 *
 * Null when there is no known next income, because the question names it — a
 * total "before your next income" computed without knowing when that is would
 * be a total over an arbitrary window wearing a specific label. Null too when
 * the window holds more than one currency: a partial sum reads exactly like a
 * complete one.
 */
function obligationsDueBefore(
  obligations: readonly FinancialObligation[],
  asOf: string,
  nextIncome: DerivedInstant | null,
  currency: string | null,
): DerivedAmount | null {
  if (nextIncome === null || currency === null) return null;
  const inWindow = obligations.filter((o) => o.dueAt > asOf && o.dueAt <= nextIncome.at);
  if (inWindow.some((o) => o.amount.currency !== currency)) return null;

  /* The income date's own provenance is always part of this total, even when
     the window is empty: "nothing due before payday" is a claim about when
     payday is, and is exactly as good as the prediction that placed it. */
  const provenances = [nextIncome.provenance, ...inWindow.map((o) => o.amount.provenance)];
  return {
    minorUnits: inWindow.reduce((total, o) => total + o.amount.minorUnits, 0),
    currency,
    provenance: combine(provenances),
  };
}

function subtract(cash: DerivedAmount | null, due: DerivedAmount | null): DerivedAmount | null {
  if (!cash || !due || cash.currency !== due.currency) return null;
  return {
    minorUnits: cash.minorUnits - due.minorUnits,
    currency: cash.currency,
    provenance: combine([cash.provenance, due.provenance]),
  };
}

/**
 * The provenance of arithmetic.
 *
 * Oldest `observedAt` and lowest confidence of the inputs, because a figure is
 * exactly as trustworthy as its weakest ingredient. Taking the newest instant
 * would let a balance read this morning make a week-old bill prediction look
 * current.
 */
function combine(parts: readonly FinancialProvenance[]): FinancialProvenance {
  const sources = new Set<FinancialSourceKind>();
  for (const part of parts) for (const source of part.contributingSources) sources.add(source);
  return {
    origin: 'computed',
    contributingSources: Object.freeze(Array.from(sources).sort()),
    observedAt: parts.reduce<string | null>((oldest, part) =>
      oldest === null || part.observedAt < oldest ? part.observedAt : oldest, null) ?? '',
    confidence: parts.reduce((lowest, part) => Math.min(lowest, part.confidence), 1),
    connectionId: null,
  };
}

/**
 * The band, in integer arithmetic.
 *
 * `buffer * 2 <= obligations` is `FINANCIAL_BUFFER_BAND_POLICY`'s half without
 * a float ever existing, so the band cannot flip because a division landed a
 * fraction of a unit on the wrong side of a boundary.
 */
function bandOf(buffer: DerivedAmount | null, due: DerivedAmount | null): FinancialState['bufferBand'] {
  if (!buffer || !due) return 'unknown';
  if (buffer.minorUnits < 0) return 'negative';
  if (due.minorUnits <= 0) return 'comfortable';
  return buffer.minorUnits * 2 <= due.minorUnits ? 'tight' : 'comfortable';
}
