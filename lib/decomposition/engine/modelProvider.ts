/**
 * The optional model side of the detector.
 *
 * Optional is structural, not a courtesy: the provider is injected, so the
 * engine has no import path to any model client and cannot acquire one by
 * accident. Everything the module does without a provider it does with one —
 * the model changes the *quality* of the split, never whether decomposition is
 * available, which is the property the Sprint 00 kill switch exists to protect.
 *
 * The draft is deliberately not a `DecompositionProposal`. A provider returns a
 * candidate that is then validated exactly like any other untrusted input; if
 * it could return a proposal it could return a *confirmed-looking* one, and the
 * boundary would depend on the provider behaving.
 */

import type { DecompositionStepProposal } from '../../../src/contracts/v1/decompositionContracts';

export interface DecompositionModelRequest {
  readonly sourceText: string;
}

export interface DecompositionModelDraft {
  /** Empty means "the model sees one action here", not "the model failed". */
  readonly steps: readonly DecompositionStepProposal[];
  /** 0..1. Compared against the caller's threshold before anything is offered. */
  readonly confidence: number;
}

export interface DecompositionModelProvider {
  propose(request: DecompositionModelRequest): Promise<DecompositionModelDraft>;
}
