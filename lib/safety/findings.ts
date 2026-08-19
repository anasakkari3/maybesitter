/**
 * The one place a `SafetyFinding` is constructed.
 *
 * Every finding's `stage`, `boundary`, `scope` and `severity` are read from the
 * contract's tables rather than passed in by the caller. That is the whole
 * reason this module exists: a validator that spelled its own classification
 * would be a second copy of one, and `FINDING_CLASSIFICATION_MISMATCH` would
 * then be reporting a disagreement between two things this repo owns rather than
 * catching a producer that got it wrong. Sprint 06 spent four review rounds
 * pulling apart three copies of one lexicon; this is the same shape, caught
 * before it was written.
 *
 * `detail` is the caller's, and the rule on it is absolute: static prose plus
 * numbers derived from the input, never an identifier and never a quotation. See
 * `SafetyFinding` in the contract for why — Sprint 07's real leak was a detail
 * string, not a data field.
 */

import {
  SAFETY_CODE_BOUNDARIES,
  SAFETY_CODE_SCOPES,
  SAFETY_CODE_SEVERITY,
  SAFETY_CODE_STAGES,
  SAFETY_LIMITS,
  type SafetyFinding,
  type SafetyLimitName,
  type SafetyReasonCode,
} from '../../src/contracts/v1/safetyContracts';

/** Positions only. There is no field here that can hold an identifier. */
export interface FindingLocators {
  readonly inputIndex?: number | null;
  readonly segmentIndex?: number | null;
  readonly claimIndex?: number | null;
  readonly nodeIndex?: number | null;
  readonly effectIndex?: number | null;
  readonly limitName?: SafetyLimitName | null;
}

export function finding(
  code: SafetyReasonCode,
  detail: string,
  locators: FindingLocators = {},
): SafetyFinding {
  return {
    code,
    stage: SAFETY_CODE_STAGES[code],
    boundary: SAFETY_CODE_BOUNDARIES[code],
    scope: SAFETY_CODE_SCOPES[code],
    severity: SAFETY_CODE_SEVERITY[code],
    inputIndex: locators.inputIndex ?? null,
    segmentIndex: locators.segmentIndex ?? null,
    claimIndex: locators.claimIndex ?? null,
    nodeIndex: locators.nodeIndex ?? null,
    effectIndex: locators.effectIndex ?? null,
    limitName: locators.limitName ?? null,
    detail,
  };
}

/**
 * Hold a finding list to `SAFETY_LIMITS.maxFindings`, announcing the truncation.
 *
 * A bound on the *output*, and it is enforced rather than declared for the
 * reason Sprint 08 recorded: a crafted input that produces one finding per
 * character turns a refusal into a payload, and the request that does it is
 * otherwise perfectly valid. The truncation keeps one slot for the marker, so a
 * caller can always tell a capped list from a complete one — a silently
 * truncated list is a list that under-reports exactly when there was most to
 * report.
 */
export function capFindings(findings: readonly SafetyFinding[], code: SafetyReasonCode): readonly SafetyFinding[] {
  if (findings.length <= SAFETY_LIMITS.maxFindings) return findings;
  return [
    ...findings.slice(0, SAFETY_LIMITS.maxFindings - 1),
    finding(
      code,
      `more findings were produced than may be reported; the list is truncated at ${SAFETY_LIMITS.maxFindings}`,
      { limitName: 'maxFindings' },
    ),
  ];
}

/** A total, non-throwing array read for values arriving from an untyped boundary. */
export function asArray<T>(value: unknown): readonly T[] {
  return Array.isArray(value) ? (value as readonly T[]) : [];
}

/** A total object test. `typeof null === 'object'` is the trap this exists for. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
