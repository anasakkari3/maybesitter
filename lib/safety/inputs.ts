/**
 * The one definition of "which input spans may be scanned, and how much of
 * them".
 *
 * This module exists because the bound was applied in one validator and not the
 * other, which meant it bounded nothing. `preValidator` reported
 * `REQUEST_EXCEEDS_LIMIT` and stopped **its own** scan; the gateway then ran
 * `postValidator` unconditionally, and that built its sensitive-text and
 * injected-text corpora from `request.inputs` with no count bound and no
 * per-span length filter. The measured cost on a request the gateway had
 * *already decided to block* was 78 seconds of CPU at 200 spans of 200K
 * characters — Sprint 08's `maxEvidenceRefsPerReason` at roughly ten times the
 * price.
 *
 * The lesson is narrower than "enforce your limits", because both limits *were*
 * enforced in the sense the enumeration test checked: a finding naming each one
 * was emitted. What was not true is that the work stopped. **A bound is a bound
 * on work, not a bound on findings** — so the bound now lives in one function
 * that returns the spans, and every pass that reads inputs reads them through
 * it. A future pass cannot forget, because there is no other way to get the
 * list.
 */

import { SAFETY_LIMITS, type SafetyRequest, type UntrustedInput } from '../../src/contracts/v1/safetyContracts';
import { asArray, isObject } from './findings';

export interface ScannableInput {
  /** Position in `request.inputs`. Findings name spans by this, never by id. */
  readonly index: number;
  readonly input: UntrustedInput;
  readonly text: string;
}

/**
 * The spans any pass may scan, already bounded in count and in length.
 *
 * A span is excluded when it is not a readable object, when its `text` is not a
 * string, when it is longer than `maxUntrustedInputChars`, or when it sits past
 * `maxUntrustedInputs`. Each exclusion is reported by `preValidator` — either as
 * `REQUEST_EXCEEDS_LIMIT` or as `REQUEST_UNREADABLE` — so nothing is dropped
 * silently; this function's job is only to make sure no later pass touches it.
 */
export function scannableInputs(request: unknown): readonly ScannableInput[] {
  if (!isObject(request)) return [];
  const inputs = asArray<UntrustedInput>((request as unknown as SafetyRequest).inputs);
  const scannable: ScannableInput[] = [];
  const bound = Math.min(inputs.length, SAFETY_LIMITS.maxUntrustedInputs);
  for (let index = 0; index < bound; index += 1) {
    const input = inputs[index];
    if (!isObject(input)) continue;
    const text = (input as UntrustedInput).text;
    if (typeof text !== 'string') continue;
    if (text.length > SAFETY_LIMITS.maxUntrustedInputChars) continue;
    scannable.push({ index, input: input as UntrustedInput, text });
  }
  return scannable;
}
