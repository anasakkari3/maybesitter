/**
 * The pre validator: everything decidable about a request before any candidate
 * exists.
 *
 * Reports; never throws, for any input. `SAFETY_INPUT_POLICY` states the rule
 * and this module is where it matters most — a safety check that raises has not
 * merely failed to report, it has handed the decision to whichever caller forgot
 * the try/catch, and the default behaviour of an uncaught throw is not "refuse".
 *
 * **No clock.** Every instant comes from `request.now`. There is no `Date.now()`,
 * no zero-arg `new Date()`, no `Math.random()` and no `randomUUID` anywhere
 * under `lib/safety/**`, and `tests/safety/safetyBoundaries.test.ts` scans for
 * all four with comments stripped.
 *
 * **Ordering is by input position**, and no string comparison happens anywhere
 * in this file. Findings come out request-level first, then input by input in
 * `inputs` order and, within an input, in a fixed code order — so two callers
 * checking the same request get byte-identical output without this module
 * needing a comparator. (`compareByCodePoint` in `lib/planning/shared/compare.ts`
 * is the repo's comparator when one *is* needed; `localeCompare` is never it.)
 */

import {
  INSTRUCTION_BEARING_ORIGINS,
  SAFETY_LIMITS,
  SENSITIVITY_RANK,
  isInstant,
  millisBetweenInstants,
  type SafetyFinding,
  type SafetyRequest,
  type SensitivityClass,
  type UntrustedInput,
} from '../../src/contracts/v1/safetyContracts';
import { isInjectedSpan } from './lexicon';
import { asArray, capFindings, finding, isObject } from './findings';
import { scannableInputs } from './inputs';

const MILLIS_PER_MINUTE = 60_000;

/**
 * Judge a request.
 *
 * The order of the passes is the suppression rule from `PLANNING_INPUT_POLICY`:
 * a finding is suppressed only when it borrows a bound from something already
 * reported malformed. So an unusable `now` suppresses the pressure *interval*
 * judgement — which measures against it — and suppresses nothing else. The
 * consecutive-unanswered ceiling borrows no instant, so it still runs; the
 * sensitivity and injection passes read no clock at all.
 */
export function validateSafetyRequest(request: SafetyRequest): readonly SafetyFinding[] {
  const findings: SafetyFinding[] = [];

  if (!isObject(request) || !Array.isArray((request as unknown as { inputs?: unknown }).inputs)) {
    // Fail-closed, and reported rather than raised. This is the code that makes
    // "the gateway could not read what it was given" an outcome a caller can
    // branch on instead of an exception a caller can forget.
    return [
      finding(
        'REQUEST_UNREADABLE',
        'the request is not a readable request: it is absent, not an object, or carries no input list',
      ),
    ];
  }

  const nowIsUsable = isInstant(request.now);
  if (!nowIsUsable) {
    findings.push(
      finding(
        'EVALUATION_INSTANT_INVALID',
        'the request carries no usable evaluation instant; an instant must be ISO-8601 with an explicit offset and must name a real moment',
      ),
    );
  }

  const inputs = asArray<UntrustedInput>(request.inputs);
  if (inputs.length > SAFETY_LIMITS.maxUntrustedInputs) {
    findings.push(
      finding(
        'REQUEST_EXCEEDS_LIMIT',
        `the request carries ${inputs.length} input spans; the bound is ${SAFETY_LIMITS.maxUntrustedInputs}`,
        { limitName: 'maxUntrustedInputs' },
      ),
    );
  }

  /**
   * Every span is reported here; only the ones `scannableInputs` returns are
   * *scanned*, by this pass and by every later one.
   *
   * The split matters. Reporting an over-limit span and then scanning it anyway
   * is what the first version did on the post side, and the bound bounded
   * nothing: 78 seconds of CPU on a request already decided. So the report loop
   * runs over the raw list and the pattern work runs over the bounded one.
   */
  const permitted = rankOfPermitted(request.permittedSensitivity);
  const reportBound = Math.min(inputs.length, SAFETY_LIMITS.maxUntrustedInputs);

  for (let index = 0; index < reportBound; index += 1) {
    const input = inputs[index];
    if (!isObject(input)) {
      findings.push(
        finding('REQUEST_UNREADABLE', `input span #${index} is not a readable span`, { inputIndex: index }),
      );
      continue;
    }

    /**
     * A `text` that is not a string is an unreadable span, not an empty one.
     *
     * The first version coerced it to `''` and carried on, so `new String(x)`,
     * `{ toString() {…} }`, `['x']` and `9` produced **no finding at all** while
     * `SAFETY_INPUT_POLICY.unreadableInputIsBlocked` says otherwise — and each
     * of those is a shape `JSON.parse` or a careless adapter really produces.
     * The span is also excluded from `scannableInputs`, so refusing here is what
     * keeps "not scanned" and "not reported" from being the same thing.
     */
    if (typeof input.text !== 'string') {
      findings.push(
        finding('REQUEST_UNREADABLE', `input span #${index} carries no readable text`, { inputIndex: index }),
      );
      continue;
    }

    const text = input.text;
    if (text.length > SAFETY_LIMITS.maxUntrustedInputChars) {
      findings.push(
        finding(
          'REQUEST_EXCEEDS_LIMIT',
          `input span #${index} carries ${text.length} characters; the bound is ${SAFETY_LIMITS.maxUntrustedInputChars}`,
          { inputIndex: index, limitName: 'maxUntrustedInputChars' },
        ),
      );
      // Not scanned further here, and excluded from `scannableInputs` so that no
      // later pass scans it either. That second half is the fix.
      continue;
    }

    if (rankOfDeclared(input.sensitivity) > permitted) {
      findings.push(
        finding(
          'SENSITIVE_SCOPE_NOT_PERMITTED',
          `input span #${index} is classified more exposed than this surface may draw on`,
          { inputIndex: index },
        ),
      );
    }

    const originBearsInstructions = (INSTRUCTION_BEARING_ORIGINS as readonly string[]).includes(
      input.origin as string,
    );

    if (input.declaredTrust === 'instruction' && !originBearsInstructions) {
      findings.push(
        finding(
          'UNTRUSTED_CONTENT_IN_TRUSTED_SLOT',
          `input span #${index} was submitted as an instruction, but its origin is not one this version treats as instruction-bearing`,
          { inputIndex: index },
        ),
      );
    }

    if (isInjectedSpan(input.origin, text)) {
      findings.push(
        finding(
          'INJECTED_INSTRUCTION',
          // Worded to share no eight-character run with the attacks it fires on.
          // The first draft read "…addressed to the system rather than to a
          // person" and tripped `AUDIT_CONTAINS_RAW_TEXT`, because the payload
          // it was describing also contained "the system". The scanner was
          // right and the prose was wrong; loosening the scanner would have been
          // the comfortable fix and would have blinded it for every finding.
          `input span #${index} carries directive language aimed at this module rather than at a reader`,
          { inputIndex: index },
        ),
      );
    }
  }

  findings.push(...pressureFindings(request, nowIsUsable));

  return capFindings(findings, 'REQUEST_EXCEEDS_LIMIT');
}

/**
 * What the pressure budget says about pressing again.
 *
 * A **discriminated result rather than `number | null`**, and that change is the
 * whole of the fix. The first version returned `null` from eight different
 * guards and the caller read `null` as "no cooldown applies", so every
 * unreadable bound was maximally permissive:
 *
 *     interval 60, pressed 1 minute ago  ->  PRESSURE_BUDGET_EXHAUSTED   (correct)
 *     interval Infinity                  ->  allowed
 *     interval NaN / -5 / missing        ->  allowed
 *     lastPressuredAt 'yesterday'        ->  allowed
 *     lastPressuredAt '2026-02-30T…'     ->  allowed
 *
 * `Infinity` is the natural way a caller writes "never press again" and it was
 * the single most permissive value the field accepted. This is the third
 * instance of the same shape in this module — after the two the red-team suite
 * found in the sensitivity and intensity ranks — and the reason it kept
 * recurring is that `null` is a fine answer to "how long" and a terrible answer
 * to "may I". The type now refuses to conflate them.
 *
 * Exactly one absence stays legitimate: `lastPressuredAt: null` means this
 * subject has never been pressed, so the interval has nothing to measure from.
 * That is `never_pressed`, and it is the only variant that permits.
 */
export type PressureIntervalState =
  | { readonly kind: 'unreadable'; readonly field: string }
  | { readonly kind: 'out_of_range'; readonly minutes: number }
  | { readonly kind: 'never_pressed' }
  | { readonly kind: 'now_unusable' }
  | { readonly kind: 'elapsed' }
  | { readonly kind: 'pending'; readonly retryAfterMillis: number; readonly minutes: number };

export function pressureIntervalState(request: SafetyRequest): PressureIntervalState {
  if (!isObject(request)) return { kind: 'unreadable', field: 'request' };
  const budget = request.pressureBudget;
  if (!isObject(budget)) return { kind: 'unreadable', field: 'pressureBudget' };

  const minutes = budget.minIntervalMinutes;
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) {
    return { kind: 'unreadable', field: 'minIntervalMinutes' };
  }
  if (minutes > SAFETY_LIMITS.maxPressureIntervalMinutes) {
    // Bounded because the value is arithmetic, not just work: added to an epoch
    // instant it produced `+192159-01-24` at 1e11 and a `RangeError` at 1.5e11.
    return { kind: 'out_of_range', minutes };
  }

  const last = budget.lastPressuredAt;
  if (last === null || last === undefined) return { kind: 'never_pressed' };
  if (!isInstant(last)) return { kind: 'unreadable', field: 'lastPressuredAt' };
  if (!isInstant(request.now)) return { kind: 'now_unusable' };

  const elapsed = millisBetweenInstants(last, request.now);
  if (elapsed === null) return { kind: 'now_unusable' };
  if (elapsed >= minutes * MILLIS_PER_MINUTE) return { kind: 'elapsed' };

  // Epoch millis of `lastPressuredAt`, obtained through the same single-sourced
  // arithmetic rather than a second parse of the string. `instantToMillis` is
  // private to the contract on purpose — exporting a raw parser is how a second
  // spelling of "what is a valid instant" gets written.
  const from = millisBetweenInstants(EPOCH, last);
  if (from === null) return { kind: 'unreadable', field: 'lastPressuredAt' };
  return { kind: 'pending', retryAfterMillis: from + minutes * MILLIS_PER_MINUTE, minutes };
}

const EPOCH = '1970-01-01T00:00:00Z';

/**
 * The pressure-permission passes.
 *
 * Three codes, because there are three conditions with three different remedies
 * and one code answering three questions is what this module's own taxonomy
 * rules forbid: a ceiling is fixed by the person replying, an interval by
 * waiting, and an unreadable budget by the caller sending a readable one. The
 * split is also what makes `SafeUserPath`'s invariant true — `retryAfter` is
 * non-null exactly for `PRESSURE_BUDGET_EXHAUSTED`.
 */
function pressureFindings(request: SafetyRequest, nowIsUsable: boolean): readonly SafetyFinding[] {
  const budget = isObject(request) ? request.pressureBudget : undefined;
  if (!isObject(budget)) {
    return [
      finding(
        'PRESSURE_BUDGET_UNREADABLE',
        'the request carries no readable pressure budget, so nothing establishes that pressing is permitted',
      ),
    ];
  }

  const findings: SafetyFinding[] = [];

  const consecutive = budget.consecutiveUnansweredCount;
  const ceiling = budget.maxConsecutiveUnanswered;
  const countsAreReadable =
    typeof consecutive === 'number' &&
    typeof ceiling === 'number' &&
    Number.isFinite(consecutive) &&
    Number.isFinite(ceiling) &&
    consecutive >= 0 &&
    ceiling >= 0;

  if (!countsAreReadable) {
    findings.push(
      finding(
        'PRESSURE_BUDGET_UNREADABLE',
        'the pressure budget states no readable unanswered-attempt counts',
      ),
    );
  } else if (consecutive >= ceiling) {
    // The clause the product's cooldown has no shape for: a cooldown alone
    // permits an unbounded run of hourly nudges to someone who has answered
    // none of them, and harmful pressure is exactly that sequence. Waiting does
    // not fix it, which is why it is not `PRESSURE_BUDGET_EXHAUSTED`.
    findings.push(
      finding(
        'PRESSURE_UNANSWERED_CEILING',
        `this surface has pressed ${consecutive} times without an answer; the ceiling is ${ceiling}`,
      ),
    );
  }

  const state = pressureIntervalState(request);
  switch (state.kind) {
    case 'unreadable':
      findings.push(
        finding(
          'PRESSURE_BUDGET_UNREADABLE',
          `the pressure budget's ${state.field} cannot be read, so no interval bounds the next attempt`,
        ),
      );
      break;
    case 'out_of_range':
      findings.push(
        finding(
          'REQUEST_EXCEEDS_LIMIT',
          `the pressure interval is ${state.minutes} minutes; the bound is ${SAFETY_LIMITS.maxPressureIntervalMinutes}`,
          { limitName: 'maxPressureIntervalMinutes' },
        ),
      );
      break;
    case 'pending':
      findings.push(
        finding(
          'PRESSURE_BUDGET_EXHAUSTED',
          `less than the caller's own interval of ${state.minutes} minutes has passed since this surface last pressed`,
        ),
      );
      break;
    case 'now_unusable':
      // Suppressed rather than decided: this judgement measures against `now`,
      // and a check against an unusable bound reports a fact about the bound.
      // `EVALUATION_INSTANT_INVALID` already names it — see the guard below,
      // which exists so a future edit cannot make the suppression silent.
      if (!nowIsUsable) break;
      findings.push(
        finding('PRESSURE_BUDGET_UNREADABLE', 'the interval could not be measured against the evaluation instant'),
      );
      break;
    case 'never_pressed':
    case 'elapsed':
      break;
  }

  return findings;
}

/**
 * The two sides of the sensitivity comparison rank an unknown label in
 * **opposite** directions, and getting that backwards is a fail-open bug the
 * red-team suite caught in the first draft of this file.
 *
 * One shared helper returning `MAX_SAFE_INTEGER` for anything unrecognised looks
 * conservative and is only conservative on one side: applied to
 * `permittedSensitivity`, it says an unreadable clearance permits *everything*.
 * A misspelled or newly-added class in the request would then have opened the
 * privacy boundary completely, silently, on every surface at once.
 *
 * So: an unknown class on the **content** side ranks above everything known (it
 * might be anything, so treat it as the most exposed), and an unknown class on
 * the **clearance** side ranks at the bottom (nothing was legibly permitted, so
 * permit only the least exposed).
 */
function rankOfDeclared(value: unknown): number {
  const rank = SENSITIVITY_RANK[value as SensitivityClass];
  return typeof rank === 'number' ? rank : Number.MAX_SAFE_INTEGER;
}

function rankOfPermitted(value: unknown): number {
  const rank = SENSITIVITY_RANK[value as SensitivityClass];
  return typeof rank === 'number' ? rank : SENSITIVITY_RANK.public;
}
