/**
 * Normalized financial-context contracts.
 *
 * Financial context is context, not advice, not a budget ledger, and not a
 * planner input. It answers one question — what money constraints are real for
 * this person right now — and it answers it in a common vocabulary, so a
 * consumer never branches on whether the number came from a bank aggregator or
 * from the person typing it in.
 *
 * ── Why there is no transaction array in here ────────────────────
 *
 * A row-level purchase history is the most sensitive thing an aggregator
 * returns and the least useful thing for deciding what matters today. It is
 * read by the normalizer and it dies there: what comes out is cadence, totals
 * and dates. Keeping a `transactions` field off this contract is what makes
 * "the planner cannot see McDonald's 47.30" a property of the type system
 * rather than a promise in a comment — a consumer cannot render, log or
 * serialize a field that does not exist.
 *
 * ── Why money is integers ────────────────────────────────────────
 *
 * Every amount is minor units of a stated currency. A free buffer that reads
 * `449.99999999994` is not a rounding nuisance, it is a number the user cannot
 * reconcile against their own bank app, and floats reach that state by adding
 * three correct values together.
 */

import { MODULE_CONTRACT_VERSION } from './moduleContracts';

export const FINANCIAL_CONTRACT_VERSION = MODULE_CONTRACT_VERSION;
export const FINANCIAL_SCHEMA_VERSION = 'financial-state-v1' as const;

/* ── Sources ──────────────────────────────────────────────────────── */

export const FINANCIAL_SOURCE_KINDS = Object.freeze([
  'provider',
  'manual',
] as const);

export type FinancialSourceKind = (typeof FINANCIAL_SOURCE_KINDS)[number];

/**
 * Where a value in the state came from. `computed` is its own origin because a
 * free buffer is not something either source said — it is arithmetic over both,
 * and labelling it `provider` would overstate how directly the bank vouches
 * for it.
 */
export type FinancialValueOrigin = FinancialSourceKind | 'computed';

export interface FinancialProvenance {
  readonly origin: FinancialValueOrigin;
  /** For `computed`, every source that fed the arithmetic. Otherwise the origin itself. */
  readonly contributingSources: readonly FinancialSourceKind[];
  /**
   * When the underlying fact was observed — for a computed value, the *oldest*
   * of its inputs. A buffer is exactly as fresh as its stalest ingredient, and
   * reporting the newest one would make a week-old balance look like a reading
   * from this morning.
   */
  readonly observedAt: string;
  /** 0..1 inclusive. For a computed value, the minimum across its inputs. */
  readonly confidence: number;
  /** The integration connection a provider value came from; null for manual and computed. */
  readonly connectionId: string | null;
}

/* ── Money ────────────────────────────────────────────────────────── */

export interface DerivedAmount {
  /** Integer minor units. Negative is meaningful: a buffer can be overdrawn. */
  readonly minorUnits: number;
  /** ISO 4217, upper case. */
  readonly currency: string;
  readonly provenance: FinancialProvenance;
}

export interface DerivedCount {
  readonly value: number;
  readonly provenance: FinancialProvenance;
}

export interface DerivedInstant {
  readonly at: string;
  readonly provenance: FinancialProvenance;
}

/* ── Entries, before anything is resolved ─────────────────────────── */

/**
 * The value types a field can hold. Amounts travel as their minor units and
 * carry their currency in the `currency` field, so one comparison rule covers
 * both a balance and a currency code.
 */
export type FinancialFieldValue = number | string;

/** One thing a source said about one field, at one instant. */
export interface FinancialObservationEntry<T extends FinancialFieldValue> {
  readonly value: T;
  readonly observedAt: string;
  /** 0..1 inclusive. */
  readonly confidence: number;
  readonly connectionId: string | null;
}

/* ── Fields and their authority ───────────────────────────────────── */

export const FINANCIAL_FIELD_IDS = Object.freeze([
  'currency',
  'cash_available',
  'next_income_at',
  'next_income_amount',
  'fixed_monthly_obligations',
  'recurring_count',
  'savings_goal',
] as const);

export type FinancialFieldId = (typeof FINANCIAL_FIELD_IDS)[number];

/**
 * Which source is authoritative for each field, by what the field *is*.
 *
 * ── Why this is a table and not a rule about time ────────────────
 *
 * The tempting rule is "whichever source spoke most recently wins". It is
 * wrong, and wrong in a way that only shows up months later: a person who
 * corrects a number is making a statement about what it means to them, not
 * filing a reading that a fresher reading supersedes. Under a recency rule
 * their correction survives exactly until the next nightly sync, and then the
 * product quietly tells them the thing they already said was wrong.
 *
 * So authority is decided by the field's class. Recency only ever breaks ties
 * *within* one source: a newer provider observation supersedes an older
 * provider observation, a newer manual statement supersedes an older manual
 * statement, and neither ever reaches across.
 */
export const FINANCIAL_FIELD_AUTHORITY: Readonly<Record<FinancialFieldId, FinancialSourceKind>> =
  Object.freeze({
    // Observed financial facts: the bank is the one that knows.
    currency: 'provider',
    cash_available: 'provider',
    next_income_at: 'provider',
    next_income_amount: 'provider',
    fixed_monthly_obligations: 'provider',
    recurring_count: 'provider',
    // User intent: no aggregator has an opinion about what someone is saving for.
    savings_goal: 'manual',
  });

/**
 * What kind of thing the user said.
 *
 * A `statement` is the user supplying a value — authoritative for the fields
 * that are theirs to define, and a fallback for the rest when no provider is
 * connected. A `correction` is the user overruling a provider observation on a
 * field the provider would otherwise own; it moves that one field's authority
 * to them and no later observation takes it back.
 */
export type FinancialManualKind = 'statement' | 'correction';

export interface FinancialManualEntry<T extends FinancialFieldValue>
  extends FinancialObservationEntry<T> {
  readonly kind: FinancialManualKind;
}

export const FINANCIAL_CONFLICT_REASONS = Object.freeze([
  'provider_authoritative_for_observed_fact',
  'user_correction_overrides_observation',
  'manual_authoritative_for_user_intent',
] as const);

export type FinancialConflictReason = (typeof FINANCIAL_CONFLICT_REASONS)[number];

/**
 * A disagreement that was resolved, kept so it can be shown.
 *
 * Every conflict in the state is rendered. The losing value stays visible and
 * attributed, because the alternative — resolving silently — is how a product
 * tells someone a number they personally typed has vanished, and leaves them
 * no way to tell whether it was overruled or lost.
 */
export interface FinancialConflict {
  readonly field: FinancialFieldId;
  readonly providerValue: number | string | null;
  readonly manualValue: number | string | null;
  readonly resolvedTo: FinancialSourceKind;
  readonly reason: FinancialConflictReason;
}

/* ── Obligations ──────────────────────────────────────────────────── */

export const FINANCIAL_OBLIGATION_CATEGORIES = Object.freeze([
  'rent',
  'card',
  'loan',
  'subscription',
  'utility',
  'tuition',
  'other',
] as const);

export type FinancialObligationCategory = (typeof FINANCIAL_OBLIGATION_CATEGORIES)[number];

export interface FinancialObligation {
  readonly obligationId: string;
  /**
   * User-written text, or null.
   *
   * Null for everything a provider found. A provider's name for a payment is
   * the merchant string off the transaction — the exact data this contract
   * exists to keep from travelling — so a provider-derived obligation carries a
   * category and an amount and stays anonymous. Only text the user typed
   * themselves is shown as a label.
   */
  readonly label: string | null;
  readonly category: FinancialObligationCategory;
  readonly dueAt: string;
  readonly amount: DerivedAmount;
  readonly recurring: boolean;
}

/* ── The state ────────────────────────────────────────────────────── */

export type FinancialBufferBand = 'comfortable' | 'tight' | 'negative' | 'unknown';

export interface FinancialState {
  readonly version: typeof FINANCIAL_CONTRACT_VERSION;
  readonly schemaVersion: typeof FINANCIAL_SCHEMA_VERSION;
  readonly scopeId: string;
  /** The instant this picture is of. Supplied by the caller, never read from a clock. */
  readonly asOf: string;
  readonly currency: string | null;
  readonly cashAvailable: DerivedAmount | null;
  readonly nextIncomeAt: DerivedInstant | null;
  readonly nextIncomeAmount: DerivedAmount | null;
  /** Everything in `upcomingObligations` that falls at or before the next income. */
  readonly obligationsBeforeNextIncome: DerivedAmount | null;
  readonly fixedMonthlyObligations: DerivedAmount | null;
  readonly recurringCount: DerivedCount | null;
  /** `cashAvailable` minus `obligationsBeforeNextIncome`. */
  readonly freeBuffer: DerivedAmount | null;
  readonly bufferBand: FinancialBufferBand;
  readonly upcomingObligations: readonly FinancialObligation[];
  readonly savingsGoal: DerivedAmount | null;
  readonly sourceKinds: readonly FinancialSourceKind[];
  readonly missingSourceKinds: readonly FinancialSourceKind[];
  readonly conflicts: readonly FinancialConflict[];
}

/**
 * How `bufferBand` is decided, as data.
 *
 * Stated as a ratio against what is actually due rather than a fixed amount,
 * because "500 left" means something different to someone with 400 of bills
 * ahead of them than to someone with 4,000. The comparison is done in integer
 * arithmetic (`buffer * 2 <= obligations`) so the band never depends on a
 * float landing on the right side of a boundary.
 *
 * Half, rather than something tighter, because the risk this band is warning
 * about is the bill nobody planned for. Someone holding less slack than half
 * of what they already owe this fortnight cannot absorb one surprise, and that
 * is the point at which knowing is worth saying.
 */
export const FINANCIAL_BUFFER_BAND_POLICY = Object.freeze({
  tightAtOrBelowFractionOfObligations: 0.5,
});

/**
 * The boundary this feature does not cross, as assertable data.
 *
 * A comment saying "we never send this to the model" is checked by nobody. A
 * frozen object is read by `tests/financial/financialBoundary.test.ts`, which
 * fails if any of these turns true without the rest of the feature changing
 * with it.
 */
export const FINANCIAL_BOUNDARY_POLICY = Object.freeze({
  rawTransactionsPersisted: false,
  rawTransactionsVisibleToModel: false,
  financialStateVisibleToModel: false,
  plannerFieldsAllowed: false,
  paymentInitiationAllowed: false,
  silentConflictOverwrite: false,
});

export function isFinancialFieldId(value: string): value is FinancialFieldId {
  return (FINANCIAL_FIELD_IDS as readonly string[]).includes(value);
}
