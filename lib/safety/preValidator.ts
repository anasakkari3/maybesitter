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
import { INJECTION_PATTERNS, matchesAny } from './lexicon';
import { asArray, capFindings, finding, isObject } from './findings';

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
   * Scanning stops at the bound rather than continuing past it.
   *
   * That is what makes the limit load-bearing instead of decorative: Sprint 08's
   * unenforced `maxEvidenceRefsPerReason` let a valid request spend 8.2 seconds
   * of CPU on an unauthenticated route. Reporting the excess and then scanning
   * all of it anyway would repeat exactly that.
   */
  const scanned = Math.min(inputs.length, SAFETY_LIMITS.maxUntrustedInputs);
  const permitted = rankOfPermitted(request.permittedSensitivity);

  for (let index = 0; index < scanned; index += 1) {
    const input = inputs[index];
    if (!isObject(input)) {
      findings.push(
        finding('REQUEST_UNREADABLE', `input span #${index} is not a readable span`, { inputIndex: index }),
      );
      continue;
    }

    const text = typeof input.text === 'string' ? input.text : '';
    if (text.length > SAFETY_LIMITS.maxUntrustedInputChars) {
      findings.push(
        finding(
          'REQUEST_EXCEEDS_LIMIT',
          `input span #${index} carries ${text.length} characters; the bound is ${SAFETY_LIMITS.maxUntrustedInputChars}`,
          { inputIndex: index, limitName: 'maxUntrustedInputChars' },
        ),
      );
      // Not scanned further: the patterns below are linear in the text, and the
      // bound exists so that a caller cannot choose how long that is.
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

    if (!originBearsInstructions && matchesAny(text, INJECTION_PATTERNS)) {
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
 * The instant, in milliseconds, after which pressing again is admissible — or
 * null when nothing bounds it.
 *
 * Exported because the gateway needs the *same* arithmetic to build
 * `SafeUserPath.retryAfter`, and a second copy of it there would be a second
 * copy of a cooldown. The number itself is the caller's: this repo's product
 * cooldown lives in `lib/services/pressureService.ts` as
 * `PRESSURE_DELIVERY_COOLDOWN_MS` and is deliberately not restated here.
 */
export function pressureRetryAfterMillis(request: SafetyRequest): number | null {
  if (!isObject(request)) return null;
  const budget = request.pressureBudget;
  if (!isObject(budget)) return null;
  if (budget.lastPressuredAt === null || budget.lastPressuredAt === undefined) return null;
  const minutes = budget.minIntervalMinutes;
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return null;
  const elapsed = millisBetweenInstants(budget.lastPressuredAt, request.now);
  if (elapsed === null) return null;
  const remaining = minutes * MILLIS_PER_MINUTE - elapsed;
  if (remaining <= 0) return null;
  // Epoch millis of `lastPressuredAt`, obtained through the same single-sourced
  // arithmetic rather than a second parse of the string. `instantToMillis` is
  // private to the contract on purpose — exporting a raw parser is how a second
  // spelling of "what is a valid instant" gets written.
  const from = millisBetweenInstants('1970-01-01T00:00:00Z', budget.lastPressuredAt);
  if (from === null) return null;
  return from + minutes * MILLIS_PER_MINUTE;
}

function pressureFindings(request: SafetyRequest, nowIsUsable: boolean): readonly SafetyFinding[] {
  const budget = request.pressureBudget;
  if (!isObject(budget)) return [];

  const consecutive = budget.consecutiveUnansweredCount;
  const ceiling = budget.maxConsecutiveUnanswered;
  if (
    typeof consecutive === 'number' &&
    typeof ceiling === 'number' &&
    Number.isFinite(consecutive) &&
    Number.isFinite(ceiling) &&
    consecutive >= ceiling
  ) {
    // The clause the product's cooldown has no shape for: a cooldown alone
    // permits an unbounded run of hourly nudges to someone who has answered
    // none of them, and harmful pressure is exactly that sequence.
    return [
      finding(
        'PRESSURE_BUDGET_EXHAUSTED',
        `this surface has pressed ${consecutive} times without an answer; the ceiling is ${ceiling}`,
      ),
    ];
  }

  // Suppressed rather than decided: this judgement measures against `now`, and a
  // check against an unusable bound reports a fact about the bound. The
  // comfortable alternative — reading an unreadable `now` as "the interval has
  // elapsed" — makes the cooldown pass hardest exactly when the caller has lost
  // track of the clock.
  if (!nowIsUsable) return [];
  if (pressureRetryAfterMillis(request) === null) return [];

  const minutes = typeof budget.minIntervalMinutes === 'number' ? budget.minIntervalMinutes : 0;
  return [
    finding(
      'PRESSURE_BUDGET_EXHAUSTED',
      `less than the caller's own interval of ${minutes} minutes has passed since this surface last pressed`,
    ),
  ];
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
