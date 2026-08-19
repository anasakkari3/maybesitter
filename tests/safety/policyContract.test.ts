/**
 * The central policy decision contract: taxonomy, tables, and the two
 * structural checkers.
 *
 * The tests here are about properties the *contract* claims, not about any
 * validator's judgement. Sprint 08's recorded lesson is that a vocabulary is
 * only as real as the assertion that enumerates it — `defer` was reachable in
 * the code and unreachable as an outcome, and nothing about `defer` itself could
 * see that. So almost every test below iterates a frozen list rather than
 * probing a hand-picked member.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUDIT_LEAK_DEFAULT_RUN_LENGTH,
  SAFETY_BLOCK_SCOPES,
  SAFETY_BOUNDARIES,
  SAFETY_CODE_BOUNDARIES,
  SAFETY_CODE_PARTITIONS,
  SAFETY_CODE_RECOVERY,
  SAFETY_CODE_SCOPES,
  SAFETY_CODE_SEVERITY,
  SAFETY_CODE_STAGES,
  SAFETY_CONTRACT_VERSION,
  SAFETY_INPUT_POLICY,
  SAFETY_LIMITS,
  SAFETY_LIMIT_NAMES,
  SAFETY_PERSISTENCE_POLICY,
  SAFETY_POST_CODES,
  SAFETY_PRE_CODES,
  SAFETY_REASON_CODES,
  SAFETY_SCHEMA_VERSION,
  SAFETY_VERDICT_DEFECT_CODES,
  SAFE_USER_PATH_KINDS,
  checkEvidenceGraph,
  checkSafetyAudit,
  checkSafetyFindings,
  checkSafetyVerdict,
  codesForBoundary,
  isInstant,
  resolveEvidenceRoots,
  type SafeUserPath,
  type SafetyAuditRecord,
  type SafetyFinding,
  type SafetyReasonCode,
  type SafetyVerdict,
} from '../../src/contracts/v1/safetyContracts.ts';
import { MODULE_CONTRACT_VERSION } from '../../src/contracts/v1/moduleContracts.ts';

const AT = '2026-08-20T09:00:00Z' as const;

function findingFor(code: SafetyReasonCode, overrides: Partial<SafetyFinding> = {}): SafetyFinding {
  return {
    code,
    stage: SAFETY_CODE_STAGES[code],
    boundary: SAFETY_CODE_BOUNDARIES[code],
    scope: SAFETY_CODE_SCOPES[code],
    severity: SAFETY_CODE_SEVERITY[code],
    inputIndex: null,
    segmentIndex: null,
    claimIndex: null,
    nodeIndex: null,
    effectIndex: null,
    limitName: null,
    detail: 'a finding built by the contract suite',
    ...overrides,
  };
}

const SAFE_PATH: SafeUserPath = Object.freeze({
  kind: 'show_evidence_only',
  retryAdmissible: true,
  retryAfter: null,
});

/* ── Versions ────────────────────────────────────────────────────── */

test('the schema version is spelled the way the module descriptor pins it', () => {
  assert.equal(SAFETY_SCHEMA_VERSION, 'safety-v1');
  assert.equal(SAFETY_CONTRACT_VERSION, MODULE_CONTRACT_VERSION);
});

/* ── The partition ───────────────────────────────────────────────── */

test('the stage partition covers every code exactly once and the halves are disjoint', () => {
  const pre = new Set<string>(SAFETY_PRE_CODES);
  const post = new Set<string>(SAFETY_POST_CODES);

  assert.equal(pre.size, SAFETY_PRE_CODES.length, 'the pre list repeats a code');
  assert.equal(post.size, SAFETY_POST_CODES.length, 'the post list repeats a code');

  const overlap = SAFETY_PRE_CODES.filter((code) => post.has(code));
  assert.deepEqual(overlap, [], 'the two stages must be disjoint; a code cannot be decided at both');

  assert.deepEqual(
    [...SAFETY_REASON_CODES].sort(),
    [...SAFETY_PRE_CODES, ...SAFETY_POST_CODES].sort(),
    'the union of the partitions must be the full vocabulary',
  );
  assert.deepEqual(SAFETY_CODE_PARTITIONS.pre, SAFETY_PRE_CODES);
  assert.deepEqual(SAFETY_CODE_PARTITIONS.post, SAFETY_POST_CODES);
});

test('the stage table agrees with the partition it is derived from', () => {
  for (const code of SAFETY_PRE_CODES) assert.equal(SAFETY_CODE_STAGES[code], 'pre', code);
  for (const code of SAFETY_POST_CODES) assert.equal(SAFETY_CODE_STAGES[code], 'post', code);
  assert.equal(Object.keys(SAFETY_CODE_STAGES).length, SAFETY_REASON_CODES.length);
});

/* ── Totality of every table ─────────────────────────────────────── */

test('every classification table is total over the vocabulary', () => {
  // A partial table is the failure that hides behind a hand-picked test: the
  // member with no entry is the one nobody wrote a case for.
  const tables: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]> = [
    ['SAFETY_CODE_BOUNDARIES', SAFETY_CODE_BOUNDARIES],
    ['SAFETY_CODE_SCOPES', SAFETY_CODE_SCOPES],
    ['SAFETY_CODE_SEVERITY', SAFETY_CODE_SEVERITY],
    ['SAFETY_CODE_RECOVERY', SAFETY_CODE_RECOVERY],
    ['SAFETY_CODE_STAGES', SAFETY_CODE_STAGES],
  ];
  for (const [name, table] of tables) {
    assert.deepEqual(
      Object.keys(table).sort(),
      [...SAFETY_REASON_CODES].sort(),
      `${name} does not cover exactly the reason codes`,
    );
    for (const code of SAFETY_REASON_CODES) {
      assert.notEqual(table[code], undefined, `${name} has no entry for ${code}`);
    }
  }
});

test('every boundary the contract names actually owns at least one code', () => {
  // The mirror of the totality check: a boundary with no members is a category
  // that reads as covered and enforces nothing.
  for (const boundary of SAFETY_BOUNDARIES) {
    const codes = codesForBoundary(boundary);
    assert.ok(codes.length > 0, `no code is filed under the ${boundary} boundary`);
    for (const code of codes) assert.equal(SAFETY_CODE_BOUNDARIES[code], boundary);
  }
  const partitionedByBoundary = SAFETY_BOUNDARIES.flatMap((boundary) => codesForBoundary(boundary));
  assert.deepEqual(
    [...partitionedByBoundary].sort(),
    [...SAFETY_REASON_CODES].sort(),
    'the boundary grouping must partition the vocabulary, not sample it',
  );
});

test('the five boundaries the issue names are each enforced by a code', () => {
  // Named individually and on purpose. The issue's acceptance criteria are
  // stated per boundary, and a test that only iterates SAFETY_BOUNDARIES would
  // keep passing if one of the five were quietly dropped from the union.
  for (const boundary of ['privacy', 'harmful_pressure', 'injection', 'hallucinated_time', 'persistence'] as const) {
    assert.ok(codesForBoundary(boundary).length > 0, `the ${boundary} boundary has no code`);
  }
});

/* ── Fail-closed is scoped and recoverable ───────────────────────── */

test('no code can stop more than one surface', () => {
  // Criterion: fail-closed behaviour is *scoped*. A safety check able to lock a
  // person out of the product is a denial of service with a justification.
  assert.deepEqual([...SAFETY_BLOCK_SCOPES], ['candidate', 'surface']);
  for (const code of SAFETY_REASON_CODES) {
    const scope = SAFETY_CODE_SCOPES[code];
    assert.ok(
      (SAFETY_BLOCK_SCOPES as readonly string[]).includes(scope),
      `${code} claims a scope outside the vocabulary`,
    );
    assert.notEqual(scope as string, 'session', `${code} escalates past a surface`);
  }
  const surfaceScoped = SAFETY_REASON_CODES.filter((code) => SAFETY_CODE_SCOPES[code] === 'surface');
  assert.deepEqual(
    surfaceScoped,
    ['PRESSURE_BUDGET_EXHAUSTED'],
    'only a condition that rebuilding cannot fix may pause a whole surface',
  );
});

test('every code names a safe user path, and every named path is one the vocabulary has', () => {
  // Criterion: all blocked actions give a safe user path. Totality of
  // SAFETY_CODE_RECOVERY is the mechanism; this is the assertion.
  for (const code of SAFETY_REASON_CODES) {
    const kind = SAFETY_CODE_RECOVERY[code];
    assert.ok(
      (SAFE_USER_PATH_KINDS as readonly string[]).includes(kind),
      `${code} recovers to "${kind}", which is not a path kind`,
    );
  }
});

test('every safe path kind is reachable from some code', () => {
  // Sprint 08's unreachable-outcome lesson, applied to the recovery vocabulary:
  // a path a user can never be offered is copy nobody will ever proofread.
  const offered = new Set(SAFETY_REASON_CODES.map((code) => SAFETY_CODE_RECOVERY[code]));
  for (const kind of SAFE_USER_PATH_KINDS) {
    assert.ok(offered.has(kind), `no code ever offers "${kind}"; it is an unreachable outcome`);
  }
});

/* ── Limits ──────────────────────────────────────────────────────── */

test('every declared limit is a positive integer and is named by SafetyLimitName', () => {
  assert.deepEqual([...SAFETY_LIMIT_NAMES].sort(), Object.keys(SAFETY_LIMITS).sort());
  assert.ok(SAFETY_LIMIT_NAMES.length > 0, 'the limit table is empty; nothing below means anything');
  for (const name of SAFETY_LIMIT_NAMES) {
    const value = SAFETY_LIMITS[name];
    assert.equal(Number.isInteger(value), true, `${name} is not an integer`);
    assert.ok(value > 0, `${name} is not positive`);
  }
});

/* ── The verdict checker ─────────────────────────────────────────── */

test('a block with no finding, or with no safe path, is reported rather than accepted', () => {
  const noFinding = { disposition: 'block', findings: [], recovery: SAFE_PATH } as unknown as SafetyVerdict;
  assert.deepEqual(
    checkSafetyVerdict(noFinding, 1).map((defect) => defect.code),
    ['BLOCK_WITHOUT_FINDING'],
  );

  const noPath = {
    disposition: 'block',
    findings: [findingFor('UNSOURCED_CLAIM')],
  } as unknown as SafetyVerdict;
  assert.deepEqual(
    checkSafetyVerdict(noPath, 1).map((defect) => defect.code),
    ['BLOCK_WITHOUT_SAFE_PATH'],
  );
});

test('an allow carrying a blocking finding is reported', () => {
  // The quiet failure: the check ran, found the problem, and shipped anyway.
  const verdict: SafetyVerdict = {
    disposition: 'allow',
    findings: [findingFor('SHAMING_LANGUAGE')],
  };
  const codes = checkSafetyVerdict(verdict, 1).map((defect) => defect.code);
  assert.deepEqual(codes, ['ALLOW_WITH_BLOCKING_FINDING']);
});

test('a redaction that names nothing, or names a segment that does not exist, is reported', () => {
  const empty = {
    disposition: 'allow_with_redaction',
    findings: [findingFor('RAW_IDENTIFIER_DISCLOSED')],
    redactedSegmentIndices: [],
    recovery: SAFE_PATH,
  } as unknown as SafetyVerdict;
  assert.ok(checkSafetyVerdict(empty, 2).some((defect) => defect.code === 'REDACTION_WITHOUT_TARGET'));

  const outOfRange = {
    disposition: 'allow_with_redaction',
    findings: [findingFor('RAW_IDENTIFIER_DISCLOSED', { segmentIndex: 5 })],
    redactedSegmentIndices: [5],
    recovery: SAFE_PATH,
  } as unknown as SafetyVerdict;
  assert.ok(
    checkSafetyVerdict(outOfRange, 2).some((defect) => defect.code === 'REDACTION_TARGET_OUT_OF_RANGE'),
  );
});

test('a redactable finding whose segment is not dropped is reported', () => {
  // The verdict claims it handled something it did not: the renderer removes
  // segment 0 and the leak is in segment 1.
  const verdict = {
    disposition: 'allow_with_redaction',
    findings: [
      findingFor('RAW_IDENTIFIER_DISCLOSED', { segmentIndex: 0 }),
      findingFor('SENSITIVE_TEXT_DISCLOSED', { segmentIndex: 1 }),
    ],
    redactedSegmentIndices: [0],
    recovery: SAFE_PATH,
  } as unknown as SafetyVerdict;
  const defects = checkSafetyVerdict(verdict, 2);
  assert.deepEqual(defects.map((defect) => defect.code), ['REDACTION_MISSES_FINDING']);
  assert.equal(defects[0].findingIndex, 1);
});

test('a well-formed verdict of each disposition reports nothing', () => {
  // Without this the checker could return a defect for everything and every
  // negative test above would still pass.
  assert.deepEqual(checkSafetyVerdict({ disposition: 'allow', findings: [] }, 1), []);
  assert.deepEqual(
    checkSafetyVerdict(
      { disposition: 'block', findings: [findingFor('UNSOURCED_CLAIM')], recovery: SAFE_PATH },
      1,
    ),
    [],
  );
  assert.deepEqual(
    checkSafetyVerdict(
      {
        disposition: 'allow_with_redaction',
        findings: [findingFor('RAW_IDENTIFIER_DISCLOSED', { segmentIndex: 0 })],
        redactedSegmentIndices: [0],
        recovery: SAFE_PATH,
      },
      1,
    ),
    [],
  );
});

test('a finding that classifies its own code differently from the tables is reported', () => {
  const lying = { ...findingFor('SHAMING_LANGUAGE'), boundary: 'privacy' } as SafetyFinding;
  assert.deepEqual(
    checkSafetyFindings([lying]).map((defect) => defect.code),
    ['FINDING_CLASSIFICATION_MISMATCH'],
  );

  const scopeLie = { ...findingFor('UNSOURCED_CLAIM'), scope: 'surface' } as SafetyFinding;
  assert.deepEqual(
    checkSafetyFindings([scopeLie]).map((defect) => defect.code),
    ['FINDING_CLASSIFICATION_MISMATCH'],
  );
});

test('an unknown code is reported and does not go on to be classified', () => {
  const alien = { ...findingFor('UNSOURCED_CLAIM'), code: 'NOT_A_CODE' } as unknown as SafetyFinding;
  const codes = checkSafetyFindings([alien]).map((defect) => defect.code);
  assert.deepEqual(codes, ['UNKNOWN_SAFETY_CODE'], 'one defect earns one code');
});

test('more findings than the cap is itself reported', () => {
  const many = Array.from({ length: SAFETY_LIMITS.maxFindings + 1 }, () => findingFor('UNSOURCED_CLAIM'));
  const verdict = {
    disposition: 'block',
    findings: many,
    recovery: SAFE_PATH,
  } as unknown as SafetyVerdict;
  assert.ok(
    checkSafetyVerdict(verdict, 1).some((defect) => defect.code === 'FINDING_CAP_EXCEEDED'),
    'a crafted input that yields one finding per character turns a refusal into a payload',
  );
});

test('the verdict checker returns findings for every malformed input rather than throwing', () => {
  // SAFETY_INPUT_POLICY.reportWhatTheTaxonomyNames. A safety checker that raises
  // has handed the decision to whichever caller forgot the try/catch, and the
  // default behaviour of an uncaught throw is not "refuse".
  const hostile: readonly unknown[] = [
    null,
    undefined,
    0,
    'block',
    [],
    { disposition: 'maybe' },
    { disposition: 'block' },
    { disposition: 'block', findings: null },
    { disposition: 'allow', findings: [null] },
    { disposition: 'allow_with_redaction', findings: [null], redactedSegmentIndices: 'nope' },
    { disposition: 'block', findings: [{ code: 7 }] },
  ];
  for (const input of hostile) {
    assert.doesNotThrow(() => checkSafetyVerdict(input as SafetyVerdict, 1), `threw on ${String(input)}`);
    assert.ok(Array.isArray(checkSafetyVerdict(input as SafetyVerdict, 1)));
  }
  assert.doesNotThrow(() => checkSafetyFindings(null as unknown as readonly SafetyFinding[]));
});

/* ── The audit record ────────────────────────────────────────────── */

function auditFor(overrides: Partial<SafetyAuditRecord> = {}): SafetyAuditRecord {
  return {
    version: SAFETY_CONTRACT_VERSION,
    schemaVersion: SAFETY_SCHEMA_VERSION,
    auditId: 'audit-1',
    decidedAt: AT,
    surface: 'coaching_message',
    disposition: 'block',
    findings: [findingFor('UNSOURCED_CLAIM')],
    candidateDigest: 'digest-abc',
    recovery: SAFE_PATH,
    ...overrides,
  };
}

test('the audit record type has no field that can hold judged text', () => {
  // Structural, and asserted over the value because a type cannot be iterated.
  // The point of the shape is that a leak has exactly one surface to reach —
  // a finding `detail` — which is what checkSafetyAudit scans.
  const record = auditFor();
  assert.deepEqual(
    Object.keys(record).sort(),
    [
      'auditId',
      'candidateDigest',
      'decidedAt',
      'disposition',
      'findings',
      'recovery',
      'schemaVersion',
      'surface',
      'version',
    ],
    'a new audit field must be justified against "sensitive raw text is not logged"',
  );
});

test('a detail reproducing judged text is reported', () => {
  const secret = 'call dr cohen about the biopsy results tomorrow';
  const record = auditFor({
    findings: [findingFor('SENSITIVE_TEXT_DISCLOSED', { detail: `the segment repeats ${secret}` })],
  });
  const verdict = {
    disposition: 'block',
    findings: record.findings,
    recovery: SAFE_PATH,
  } as unknown as SafetyVerdict;
  const codes = checkSafetyAudit(record, verdict, {
    texts: [secret],
    identifiers: [],
    minimumRunLength: AUDIT_LEAK_DEFAULT_RUN_LENGTH,
  }).map((defect) => defect.code);
  assert.ok(codes.includes('AUDIT_CONTAINS_RAW_TEXT'));
});

test('a detail reproducing a caller-chosen identifier is reported', () => {
  // Sprint 07's real leak: `working window call-dr.cohen-about-the-biopsy` went
  // out past a test that checked only that the title was absent. Ids are free
  // strings people fill with content.
  const identifier = 'call-dr.cohen-about-the-biopsy';
  const record = auditFor({
    findings: [findingFor('UNSOURCED_CLAIM', { detail: `claim ${identifier} cites nothing` })],
  });
  const verdict = {
    disposition: 'block',
    findings: record.findings,
    recovery: SAFE_PATH,
  } as unknown as SafetyVerdict;
  const codes = checkSafetyAudit(record, verdict, {
    texts: [],
    identifiers: [identifier],
    minimumRunLength: AUDIT_LEAK_DEFAULT_RUN_LENGTH,
  }).map((defect) => defect.code);
  assert.deepEqual(codes, ['AUDIT_CONTAINS_IDENTIFIER']);
});

test('the leak scan does not fire on ordinary prose that shares short words', () => {
  // The other half. A check that always fires is as uninformative as one that
  // never does, and Sprint 08 recorded that the comfortable number is the one
  // to distrust. `minimumRunLength` is what keeps `the` from being a leak.
  const record = auditFor({
    findings: [findingFor('UNSOURCED_CLAIM', { detail: 'a claim cites no evidence at all' })],
  });
  const verdict = {
    disposition: 'block',
    findings: record.findings,
    recovery: SAFE_PATH,
  } as unknown as SafetyVerdict;
  assert.deepEqual(
    checkSafetyAudit(record, verdict, {
      texts: ['the appointment is at the clinic'],
      identifiers: [],
      minimumRunLength: AUDIT_LEAK_DEFAULT_RUN_LENGTH,
    }),
    [],
  );
});

test('the leak scan sees a lowercased or re-spaced copy of the same text', () => {
  const secret = 'Biopsy  Results   Appointment';
  const record = auditFor({
    findings: [findingFor('SENSITIVE_TEXT_DISCLOSED', { detail: 'echo: biopsy results appointment' })],
  });
  const verdict = {
    disposition: 'block',
    findings: record.findings,
    recovery: SAFE_PATH,
  } as unknown as SafetyVerdict;
  assert.ok(
    checkSafetyAudit(record, verdict, {
      texts: [secret],
      identifiers: [],
      minimumRunLength: AUDIT_LEAK_DEFAULT_RUN_LENGTH,
    }).some((defect) => defect.code === 'AUDIT_CONTAINS_RAW_TEXT'),
    'a leak that survives lowercasing is still a leak',
  );
});

test('a blank digest and an unparseable decision time are reported', () => {
  const verdict = {
    disposition: 'block',
    findings: [findingFor('UNSOURCED_CLAIM')],
    recovery: SAFE_PATH,
  } as unknown as SafetyVerdict;
  const record = auditFor({ candidateDigest: '   ', decidedAt: '2026-02-30T00:00:00Z' as never });
  const codes = checkSafetyAudit(record, verdict, { texts: [], identifiers: [], minimumRunLength: 8 })
    .map((defect) => defect.code);
  assert.ok(codes.includes('AUDIT_DIGEST_MISSING'));
  assert.ok(
    codes.includes('AUDIT_INSTANT_INVALID'),
    'the 30th of February parses to the 2nd of March; it must not read as a real instant',
  );
});

test('an audit record disagreeing with the verdict it records is reported', () => {
  const verdict = {
    disposition: 'block',
    findings: [findingFor('UNSOURCED_CLAIM')],
    recovery: SAFE_PATH,
  } as unknown as SafetyVerdict;
  const codes = checkSafetyAudit(auditFor({ disposition: 'allow' }), verdict, {
    texts: [],
    identifiers: [],
    minimumRunLength: 8,
  }).map((defect) => defect.code);
  assert.deepEqual(codes, ['AUDIT_DISPOSITION_MISMATCH']);
});

test('a clean audit record reports nothing, and the checker never throws', () => {
  const verdict = {
    disposition: 'block',
    findings: [findingFor('UNSOURCED_CLAIM')],
    recovery: SAFE_PATH,
  } as unknown as SafetyVerdict;
  assert.deepEqual(
    checkSafetyAudit(auditFor(), verdict, { texts: ['unrelated content'], identifiers: ['x-1'], minimumRunLength: 8 }),
    [],
  );
  for (const hostile of [null, undefined, 0, 'x', []]) {
    assert.doesNotThrow(() =>
      checkSafetyAudit(hostile as unknown as SafetyAuditRecord, verdict, {
        texts: [],
        identifiers: [],
        minimumRunLength: 8,
      }),
    );
  }
  assert.doesNotThrow(() => checkSafetyAudit(auditFor(), verdict, null as never));
});

/* ── The reuse, asserted rather than argued ──────────────────────── */

test('the evidence machinery is Sprint 08’s, re-exported and not re-implemented', async () => {
  // If a future edit writes a local evidence checker, these identities break.
  // Sprint 06 paid four review rounds for three copies of one lexicon; Sprint 07
  // paid two integration rounds pulling three copies of one arithmetic apart.
  const contracts = await import('../../src/contracts/v1/recommendationContracts.ts');
  assert.equal(checkEvidenceGraph, contracts.checkEvidenceGraph);
  assert.equal(resolveEvidenceRoots, contracts.resolveEvidenceRoots);
  assert.equal(isInstant, contracts.isInstant);
});

/* ── Policies ────────────────────────────────────────────────────── */

test('the input and persistence policies state the rules this sprint is judged on', () => {
  assert.equal(SAFETY_INPUT_POLICY.reportWhatTheTaxonomyNames, true);
  assert.equal(SAFETY_INPUT_POLICY.unreadableInputIsBlocked, true);
  assert.equal(SAFETY_INPUT_POLICY.blockScopeNeverExceedsSurface, true);
  assert.equal(SAFETY_INPUT_POLICY.everyBlockOffersASafePath, true);
  assert.equal(SAFETY_INPUT_POLICY.digestAfterStaticPass, true);

  assert.equal(SAFETY_PERSISTENCE_POLICY.rawInputInAudit, false);
  assert.equal(SAFETY_PERSISTENCE_POLICY.noAmbientClock, true);
  assert.equal(SAFETY_PERSISTENCE_POLICY.gatewayPerformsNoWrites, true);
  assert.equal(SAFETY_PERSISTENCE_POLICY.everyRefusalIsRecoverable, true);
});

test('the frozen tables cannot be widened at runtime by whatever is being judged', () => {
  // A code list a caller can push onto is a vocabulary the caller controls.
  for (const frozen of [
    SAFETY_REASON_CODES,
    SAFETY_PRE_CODES,
    SAFETY_POST_CODES,
    SAFETY_BOUNDARIES,
    SAFETY_LIMITS,
    SAFETY_CODE_SCOPES,
    SAFETY_CODE_RECOVERY,
    SAFETY_VERDICT_DEFECT_CODES,
  ] as readonly object[]) {
    assert.equal(Object.isFrozen(frozen), true);
  }
});
