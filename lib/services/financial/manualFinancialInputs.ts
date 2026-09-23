/**
 * What the user told us themselves.
 *
 * Two shapes rather than one, because they answer different questions. A field
 * row is the user speaking about a value the state already has a slot for — a
 * savings goal they set, or a balance they are correcting. An obligation row
 * is a bill the bank has no way to know about: the tuition instalment, the
 * money owed to a friend, the thing that is only in their head until they
 * type it.
 *
 * An obligation the user typed is the one place in this feature where free
 * text is kept, because the label is theirs. Nothing here comes from a
 * provider, so nothing here is untrusted external content.
 */
import type {
  FinancialFieldId,
  FinancialFieldValue,
  FinancialManualKind,
  FinancialObligationCategory,
} from '../../../src/contracts/v1/financialContracts';

export interface ManualFieldRow {
  readonly field: FinancialFieldId;
  readonly kind: FinancialManualKind;
  readonly value: FinancialFieldValue;
  readonly observedAt: string;
}

export interface ManualObligationRow {
  readonly obligationId: string;
  readonly label: string;
  readonly category: FinancialObligationCategory;
  readonly dueAt: string;
  readonly amountMinorUnits: number;
  readonly currency: string;
  readonly recurring: boolean;
  readonly observedAt: string;
}

export interface ManualFinancialInputs {
  readonly fields: readonly ManualFieldRow[];
  readonly obligations: readonly ManualObligationRow[];
}

export const EMPTY_MANUAL_FINANCIAL_INPUTS: ManualFinancialInputs = Object.freeze({
  fields: Object.freeze([]),
  obligations: Object.freeze([]),
});
