/**
 * The safety module's entry point.
 *
 * `evaluateSafetyGate` is the one a producer calls; the two validators are
 * exported beside it because the pre stage is usable on its own — a caller can
 * find out that a request is unanswerable before spending anything building an
 * answer to it, which is the point of having a pre stage at all.
 *
 * Nothing here imports `lib/coaching/**`, `coachingContracts`, `lib/services/**`
 * or any route or UI surface. `tests/safety/safetyBoundaries.test.ts` walks the
 * whole import closure and enforces it.
 */

export { evaluateSafetyGate, type SafetyGateInput, type SafetyGateResult } from './gateway';
export { validateSafetyRequest, pressureIntervalState, type PressureIntervalState } from './preValidator';
export { scannableInputs, type ScannableInput } from './inputs';
export { validateSafetyCandidate } from './postValidator';
export {
  COERCION_PATTERNS,
  INJECTION_PATTERNS,
  PERSISTENCE_CLAIM_PATTERNS,
  SHAME_PATTERNS,
  matchesAny,
} from './lexicon';
