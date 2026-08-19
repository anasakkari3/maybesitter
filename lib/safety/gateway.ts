/**
 * The gateway: one decision, one audit record, no writes.
 *
 * It runs the pre validator over the request and the post validator over the
 * candidate, turns the combined findings into a `SafetyVerdict`, and records what
 * it decided. It never edits the candidate, never persists anything, and never
 * reads a clock — `decidedAt` is the request's own `now`.
 *
 * ── The three rules that decide a disposition ────────────────────────────
 *
 *  1. **No findings → allow.** Nothing else.
 *  2. **Any blocking finding → block**, with the safe path
 *     `SAFETY_CODE_RECOVERY` names for the *first* such finding. First by input
 *     position, which is deterministic without a comparator; there is no
 *     severity ranking among blocking codes, because a verdict a caller can
 *     weigh is a verdict a caller can overrule.
 *  3. **Only redactable findings → redact**, dropping the named segments —
 *     *unless* redaction is not actually a fix, in which case it blocks. It is
 *     not a fix in two cases, and both are the fail-closed direction:
 *       - a redactable finding that names **no segment** (an injected
 *         instruction reproduced into an identifier, which is Sprint 07's
 *         recorded leak shape). "Redact it" with no target resolves to "show
 *         it".
 *       - a redaction that would drop **every** segment, which is not a redacted
 *         message but an empty one presented as though something were shown.
 *
 * ── Why the digest comes last ────────────────────────────────────────────
 *
 * `PLANNING_INPUT_POLICY.digestAfterStaticPass`, and Sprint 07 paid for it: a
 * canonical digest computed ahead of the static pass threw on exactly the NaN
 * that pass existed to report. A gateway that hashed its input first would fail
 * on precisely the malformed inputs its report is for — which is every input a
 * red team sends. So the digest is computed from what could be read, after the
 * decision, and it never fails: an input that cannot be serialised gets a digest
 * of the fact that it could not be, and the decision survives.
 */

import {
  SAFETY_CODE_RECOVERY,
  SAFETY_CONTRACT_VERSION,
  SAFETY_SCHEMA_VERSION,
  type Instant,
  type SafeUserPath,
  type SafetyAuditRecord,
  type SafetyCandidate,
  type SafetyFinding,
  type SafetyRequest,
  type SafetySurface,
  type SafetyVerdict,
} from '../../src/contracts/v1/safetyContracts';
import { asArray, capFindings, finding, isObject } from './findings';
import { pressureRetryAfterMillis, validateSafetyRequest } from './preValidator';
import { validateSafetyCandidate } from './postValidator';

export interface SafetyGateInput {
  readonly request: SafetyRequest;
  readonly candidate: SafetyCandidate;
  /** Caller-supplied. This module mints no identifiers — no `randomUUID`, ever. */
  readonly auditId: string;
}

export interface SafetyGateResult {
  readonly verdict: SafetyVerdict;
  readonly audit: SafetyAuditRecord;
}

export function evaluateSafetyGate(input: SafetyGateInput): SafetyGateResult {
  const request = isObject(input) ? (input.request as SafetyRequest) : (undefined as unknown as SafetyRequest);
  const candidate = isObject(input) ? (input.candidate as SafetyCandidate) : (undefined as unknown as SafetyCandidate);
  const auditId = isObject(input) && typeof input.auditId === 'string' ? input.auditId : '';

  const findings = capFindings(
    [...safely(() => validateSafetyRequest(request), 'REQUEST_UNREADABLE'),
     ...safely(() => validateSafetyCandidate(candidate, request), 'UNKNOWN_CANDIDATE_SHAPE')],
    'CANDIDATE_EXCEEDS_LIMIT',
  );

  const segmentCount = isObject(candidate) ? asArray<unknown>(candidate.segments).length : 0;
  const verdict = decide(findings, segmentCount, request);

  return {
    verdict,
    audit: {
      version: SAFETY_CONTRACT_VERSION,
      schemaVersion: SAFETY_SCHEMA_VERSION,
      auditId,
      /**
       * Passed through as the caller supplied it, even when it is not an
       * instant. The record states what the decision was made against; whether
       * that was usable is `checkSafetyAudit`'s answer (`AUDIT_INSTANT_INVALID`)
       * and `EVALUATION_INSTANT_INVALID`'s. Substituting a clock reading here
       * would make the record say a thing the gateway never knew.
       */
      decidedAt: (isObject(request) ? request.now : '') as Instant,
      surface: surfaceOf(request, candidate),
      disposition: verdict.disposition,
      findings: verdict.findings,
      candidateDigest: digestOf(candidate),
      recovery: verdict.disposition === 'allow' ? null : verdict.recovery,
    },
  };
}

/**
 * Run a validator, converting anything it raises into a finding.
 *
 * The validators are written not to throw and are tested for it against hostile
 * input. This exists for the case no taxonomy can anticipate — a property
 * accessor on the candidate that throws when read, which is a shape `JSON.parse`
 * cannot produce but a caller can. `SAFETY_INPUT_POLICY.throwOnlyWhenNoCodeApplies`
 * says a code applies here: the gateway could not read what it was given, which
 * is `UNKNOWN_CANDIDATE_SHAPE`.
 *
 * The caught error is deliberately **not** inspected or reported. An exception
 * message is built from whatever raised it, and that is very often the value
 * itself — so quoting it is the most direct route from raw user text into an
 * audit log that this file could contain.
 */
function safely(run: () => readonly SafetyFinding[], code: 'REQUEST_UNREADABLE' | 'UNKNOWN_CANDIDATE_SHAPE'): readonly SafetyFinding[] {
  try {
    return run();
  } catch {
    return [finding(code, 'the input could not be read at all; the gateway refused rather than guessed')];
  }
}

function decide(
  findings: readonly SafetyFinding[],
  segmentCount: number,
  request: SafetyRequest,
): SafetyVerdict {
  if (findings.length === 0) return { disposition: 'allow', findings: [] };

  const blocking = findings.filter((item) => item.severity === 'blocking');
  const redactable = findings.filter((item) => item.severity === 'redactable');
  const untargeted = redactable.filter((item) => item.segmentIndex === null || item.segmentIndex === undefined);

  const targets = Array.from(
    new Set(
      redactable
        .map((item) => item.segmentIndex)
        .filter((index): index is number => typeof index === 'number' && Number.isInteger(index)),
    ),
  ).sort((left, right) => left - right); // numeric, never a string comparison

  const wouldEmptyTheMessage = segmentCount > 0 && targets.length >= segmentCount;

  if (blocking.length > 0 || untargeted.length > 0 || targets.length === 0 || wouldEmptyTheMessage) {
    const deciding = blocking[0] ?? untargeted[0] ?? redactable[0] ?? findings[0];
    return {
      disposition: 'block',
      findings: findings as readonly [SafetyFinding, ...SafetyFinding[]],
      recovery: pathFor(deciding, request),
    };
  }

  return {
    disposition: 'allow_with_redaction',
    findings: findings as readonly [SafetyFinding, ...SafetyFinding[]],
    // Non-empty by the guard above; the tuple type cannot see that, and a
    // runtime code (`REDACTION_WITHOUT_TARGET`) covers the boundary where the
    // type is absent.
    redactedSegmentIndices: targets as unknown as readonly [number, ...number[]],
    recovery: pathFor(redactable[0], request),
  };
}

/**
 * The path offered for the deciding finding.
 *
 * `retryAdmissible` is the recoverability half of the acceptance criterion, and
 * it is false in exactly one case: a cooldown is fixed by time, not by a better
 * candidate, and saying otherwise would send a producer into a retry loop that
 * cannot succeed. That case is also the only one carrying a `retryAfter`, and
 * the instant is derived from the request's own `now` and the caller's own
 * interval through `pressureRetryAfterMillis` — the same arithmetic the
 * pre-validator decided with, not a second copy of it.
 */
function pathFor(deciding: SafetyFinding, request: SafetyRequest): SafeUserPath {
  const kind = SAFETY_CODE_RECOVERY[deciding.code] ?? 'surface_nothing_and_explain';
  if (deciding.code !== 'PRESSURE_BUDGET_EXHAUSTED') {
    return { kind, retryAdmissible: true, retryAfter: null };
  }
  const millis = pressureRetryAfterMillis(request);
  return {
    kind,
    retryAdmissible: false,
    // `new Date(millis)` reads no clock — the ban is on the zero-argument form.
    retryAfter: millis === null ? null : (new Date(millis).toISOString() as Instant),
  };
}

function surfaceOf(request: SafetyRequest, candidate: SafetyCandidate): SafetySurface {
  if (isObject(request) && typeof request.surface === 'string') return request.surface as SafetySurface;
  if (isObject(candidate) && typeof candidate.surface === 'string') return candidate.surface as SafetySurface;
  return 'audit_note';
}

/**
 * An opaque, deterministic digest of what was judged.
 *
 * FNV-1a over a shallow canonical rendering. It is a *digest* so that two audit
 * records can be shown to be about the same content without either storing the
 * content — the device `ObservedEvidence.valueFingerprint` uses for the same
 * reason — and it is deterministic because a digest that changed between runs
 * would make the audit trail unable to say even that much.
 *
 * Never throws: a candidate that cannot be serialised still gets a non-empty
 * digest, because `AUDIT_DIGEST_MISSING` is about a caller that recorded nothing,
 * not about a caller whose input was hostile.
 */
function digestOf(candidate: SafetyCandidate): string {
  let serialised: string;
  try {
    serialised = JSON.stringify(candidate) ?? 'undefined';
  } catch {
    serialised = 'unserialisable-candidate';
  }
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialised.length; index += 1) {
    hash ^= serialised.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a-${hash.toString(16).padStart(8, '0')}-${serialised.length}`;
}
