/**
 * Which source wins a field, and why the losing value is still in the answer.
 *
 * ── The rule ─────────────────────────────────────────────────────
 *
 * Authority follows the field, from `FINANCIAL_FIELD_AUTHORITY`. Recency is
 * real but confined: it picks between entries *within* one source and never
 * reaches across to the other. The one thing that moves a field's authority is
 * an explicit user correction, which moves it to the user and is not taken
 * back by any later reading.
 *
 * ── Why disagreement is never resolved quietly ───────────────────
 *
 * Whenever both sources have a value and the values differ, the loser is
 * returned in a `FinancialConflict` alongside the winner. There is no
 * tolerance band: two amounts that differ by one minor unit produce a
 * conflict, because a tolerance is a silent overwrite with a threshold on it,
 * and the person looking at the screen is the one who should decide whether a
 * small difference matters.
 */
import {
  FINANCIAL_FIELD_AUTHORITY,
  type FinancialConflict,
  type FinancialFieldValue,
  type FinancialManualEntry,
  type FinancialObservationEntry,
  type FinancialConflictReason,
  type FinancialFieldId,
  type FinancialManualKind,
  type FinancialProvenance,
  type FinancialSourceKind,
} from '../../../src/contracts/v1/financialContracts';

export type {
  FinancialFieldValue,
  FinancialManualEntry,
  FinancialObservationEntry,
} from '../../../src/contracts/v1/financialContracts';

export interface ResolveFinancialFieldInput<T extends FinancialFieldValue> {
  readonly field: FinancialFieldId;
  readonly provider: readonly FinancialObservationEntry<T>[];
  readonly manual: readonly FinancialManualEntry<T>[];
}

export interface ResolvedFinancialField<T extends FinancialFieldValue> {
  readonly value: T | null;
  readonly provenance: FinancialProvenance | null;
  readonly conflict: FinancialConflict | null;
}

/**
 * The newest entry, with a deterministic answer when two share an instant.
 *
 * Two readings stamped at the same millisecond happen — a sync that writes a
 * balance and a currency together, a fixture with round numbers. Falling back
 * to input order would make the answer depend on the order a store handed the
 * rows back, which is the shape of bug where a list reorders itself between
 * two reads of the same data. The value's own string form is the tiebreaker.
 */
function newest<T extends FinancialFieldValue, E extends FinancialObservationEntry<T>>(
  entries: readonly E[],
): E | null {
  if (entries.length === 0) return null;
  return entries.reduce((best, candidate) => {
    if (candidate.observedAt !== best.observedAt) {
      return candidate.observedAt > best.observedAt ? candidate : best;
    }
    return String(candidate.value) > String(best.value) ? candidate : best;
  });
}

function provenanceOf<T extends FinancialFieldValue>(
  entry: FinancialObservationEntry<T>,
  origin: FinancialSourceKind,
): FinancialProvenance {
  return {
    origin,
    contributingSources: [origin],
    observedAt: entry.observedAt,
    confidence: entry.confidence,
    connectionId: origin === 'provider' ? entry.connectionId : null,
  };
}

export function resolveFinancialField<T extends FinancialFieldValue>(
  input: ResolveFinancialFieldInput<T>,
): ResolvedFinancialField<T> {
  const provider = newest<T, FinancialObservationEntry<T>>(input.provider);
  const manual = newest<T, FinancialManualEntry<T>>(input.manual);

  if (!provider && !manual) {
    return { value: null, provenance: null, conflict: null };
  }

  // A correction is the user taking the field, so it decides authority before
  // the table is consulted. Anything else leaves the table in charge.
  const corrected = manual?.kind === 'correction';
  const authority: FinancialSourceKind = corrected ? 'manual' : FINANCIAL_FIELD_AUTHORITY[input.field];

  // With only one source present there is nothing to arbitrate: the value that
  // exists is used whichever source it came from, and no conflict is invented.
  const winner = authority === 'manual' ? (manual ?? provider!) : (provider ?? manual!);
  const winningSource: FinancialSourceKind = winner === manual ? 'manual' : 'provider';

  const disagrees = provider !== null && manual !== null && !Object.is(provider.value, manual.value);
  const reason: FinancialConflictReason = corrected
    ? 'user_correction_overrides_observation'
    : FINANCIAL_FIELD_AUTHORITY[input.field] === 'manual'
      ? 'manual_authoritative_for_user_intent'
      : 'provider_authoritative_for_observed_fact';

  return {
    value: winner.value,
    provenance: provenanceOf(winner, winningSource),
    conflict: disagrees
      ? {
          field: input.field,
          providerValue: provider!.value,
          manualValue: manual!.value,
          resolvedTo: winningSource,
          reason,
        }
      : null,
  };
}
