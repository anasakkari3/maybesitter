/**
 * Construction of the unknown-aware Field<T> wrapper and its provenance.
 *
 * Centralised so that "what does source mean" is answered once, in one place,
 * rather than being decided differently by each view. The rule is:
 *
 *   source = 'domain_state' when at least one DomainState record contributed
 *          = 'absent'       when nothing contributed at all
 *
 * which makes `source` a function of `derivedFrom` and therefore impossible for a
 * view to get inconsistently wrong. A known-zero over an empty set is honestly
 * 'absent': the value is known, but no record produced it. 'deterministic_rule'
 * is unused in v1 — every field reads DomainState, none is computed from `now`
 * alone.
 */
import type {
  FieldProvenance,
  KnownField,
  UnknownField,
  UnknownReason,
} from '../../src/contracts/v1/lifeStateContracts';

/**
 * Code-unit ordering rather than localeCompare: sort results feed the digest and
 * the serialized projection, so they must not shift with the host's locale.
 */
export function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Newest contributing timestamp, or null when nothing contributed.
 *
 * Candidates are compared as instants, not as strings, because ISO timestamps
 * with different offsets sort differently as text than they do in time. Ties are
 * broken on the lexicographically smallest spelling so that two spellings of the
 * same instant cannot make the result depend on iteration order.
 */
export function newestTimestamp(candidates: readonly (string | null | undefined)[]): string | null {
  let bestMs: number | null = null;
  let best: string | null = null;

  for (const candidate of candidates) {
    const ms = parseIsoMs(candidate);
    if (ms === null || !candidate) continue;
    if (bestMs === null || ms > bestMs || (ms === bestMs && best !== null && compareStrings(candidate, best) < 0)) {
      bestMs = ms;
      best = candidate;
    }
  }
  return best;
}

export function provenanceOf(derivedFrom: string | null, computedAt: string): FieldProvenance {
  return {
    source: derivedFrom === null ? 'absent' : 'domain_state',
    derivedFrom,
    computedAt,
  };
}

export function knownField<T>(value: T, derivedFrom: string | null, computedAt: string): KnownField<T> {
  return { known: true, value, provenance: provenanceOf(derivedFrom, computedAt) };
}

export function unknownField(reason: UnknownReason, derivedFrom: string | null, computedAt: string): UnknownField {
  return { known: false, reason, provenance: provenanceOf(derivedFrom, computedAt) };
}
