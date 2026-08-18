/**
 * SYNTHETIC — ENGINEERING QA ONLY — NOT HUMAN EVIDENCE
 *
 * Tests for the Life-State / runtime-memory fixture corpus (Sprint 02, #11):
 * validator conformance, coverage completeness across language ×
 * context-condition, the expected decision for each condition, and a
 * seeded-failure proof that the validator can actually reject.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTEXT_CONDITIONS,
  FIXTURE_CLOCK_ISO,
  FIXTURE_LANGUAGES,
  LIFE_STATE_MEMORY_FIXTURES,
  MALFORMED_FIXTURES,
  RECENT_OUTCOMES_WINDOW_START,
  fixtureFor,
  type ExpectedField,
  type LifeStateMemoryFixture,
} from './lifeStateMemoryFixtures.ts';
import {
  describeIssues,
  validateFixture,
  validateFixtureCorpus,
} from '../../lib/lifeState/fixtureValidator.ts';
import {
  buildFixtureCoverageReport,
  generateFixtureCoverageMarkdown,
  runFixtureSeededFailureTest,
} from '../../lib/quality/fixtureCoverageReport.ts';
import { DEFAULT_RECENT_OUTCOMES_WINDOW_DAYS } from '../../src/contracts/v1/lifeStateContracts.ts';

const LIFE_STATE_FIELDS = ['commitments', 'availability', 'load', 'recentOutcomes'] as const;

test('fixtures: every fixture passes the shape and consistency validator', () => {
  for (const fixture of LIFE_STATE_MEMORY_FIXTURES) {
    const result = validateFixture(fixture);
    assert.equal(result.valid, true, `${fixture.id} did not validate:\n${describeIssues(result)}`);
  }
});

test('fixtures: the corpus validates as a whole', () => {
  const result = validateFixtureCorpus(LIFE_STATE_MEMORY_FIXTURES);
  assert.equal(result.valid, true, `corpus did not validate:\n${describeIssues(result)}`);
});

test('fixtures: the corpus produces no validator warnings either', () => {
  // A corpus that ships warnings teaches people to ignore them.
  const warnings = LIFE_STATE_MEMORY_FIXTURES.flatMap((fixture) =>
    validateFixture(fixture).issues.filter((issue) => issue.severity === 'warning'),
  );
  assert.deepEqual(warnings.map((issue) => `${issue.path}: ${issue.code}`), []);
});

test('fixtures: corpus covers every language x every context condition', () => {
  // Pinned explicitly: adding a language or a condition without adding fixtures
  // for it has to fail here rather than silently shrink coverage.
  assert.deepEqual([...FIXTURE_LANGUAGES].sort(), ['ar', 'en', 'he', 'mixed']);
  assert.deepEqual([...CONTEXT_CONDITIONS].sort(), ['conflicting', 'missing', 'sensitive', 'stale']);
  assert.equal(
    LIFE_STATE_MEMORY_FIXTURES.length,
    FIXTURE_LANGUAGES.length * CONTEXT_CONDITIONS.length,
    'the corpus must hold exactly one fixture per language x condition cell',
  );

  for (const language of FIXTURE_LANGUAGES) {
    for (const condition of CONTEXT_CONDITIONS) {
      const fixture = fixtureFor(language, condition);
      assert.ok(fixture, `no fixture covers ${language} x ${condition}`);
    }
  }

  const ids = LIFE_STATE_MEMORY_FIXTURES.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, 'fixture ids must be unique');
});

test('fixtures: every expected provenance is stamped with the fixed clock', () => {
  for (const fixture of LIFE_STATE_MEMORY_FIXTURES) {
    assert.equal(fixture.now, FIXTURE_CLOCK_ISO, `${fixture.id} does not use the fixed clock`);
    assert.equal(fixture.lifeState.input.now, FIXTURE_CLOCK_ISO);
    for (const field of LIFE_STATE_FIELDS) {
      assert.equal(
        fixture.lifeState.expected[field].provenance.computedAt,
        FIXTURE_CLOCK_ISO,
        `${fixture.id}.${field} must be computed at the fixed clock, never the system clock`,
      );
    }
  }
});

test('fixtures: missing context separates what an empty record proves from what it cannot', () => {
  // DomainState is the authoritative record of commitments, so an empty one
  // proves there are zero — a known fact. It proves nothing about the user's
  // free time or their behaviour, so those two stay unknown. Getting this
  // backwards in either direction defeats the point of Field<T>.
  const AUTHORITATIVE = new Set(['commitments', 'load']);

  for (const language of FIXTURE_LANGUAGES) {
    const fixture = fixtureFor(language, 'missing');
    assert.ok(fixture);
    assert.deepEqual(Object.keys(fixture.lifeState.input.state.commitments), []);

    for (const field of LIFE_STATE_FIELDS) {
      const declared: ExpectedField<unknown> = fixture.lifeState.expected[field];

      if (AUTHORITATIVE.has(field)) {
        assert.equal(declared.known, true, `${fixture.id}.${field} must be known-zero over an empty state`);
      } else {
        assert.equal(declared.known, false, `${fixture.id}.${field} must be unknown`);
        assert.equal(declared.known === false ? declared.reason : null, 'NO_DATA');
      }

      // Either way nothing was read, so provenance reports no source.
      assert.equal(declared.provenance.source, 'absent');
      assert.equal(declared.provenance.derivedFrom, null);
    }

    // Scope isolation: the probe record exists, just not for this scope.
    assert.equal(fixture.memory.records.length, 1);
    assert.notEqual(fixture.memory.records[0].input.scopeId, fixture.scopeId);
    assert.deepEqual([...fixture.memory.expectedRetrieveHandles], []);
    assert.deepEqual([...fixture.memory.expectedListAllHandles], []);
    assert.equal(fixture.memory.expectedAssertNoPersonalMemoryThrows, false);
  }
});

test('fixtures: stale context expects records past staleAfter and a known-zero window', () => {
  const clockMs = Date.parse(FIXTURE_CLOCK_ISO);
  for (const language of FIXTURE_LANGUAGES) {
    const fixture = fixtureFor(language, 'stale');
    assert.ok(fixture);

    const stale = fixture.memory.records.find((r) => r.handle === 'stale-fact');
    assert.ok(stale, `${fixture.id} must carry the stale record`);
    assert.ok(Date.parse(stale.expected.staleAfter) <= clockMs, 'staleAfter must be at or before the clock');
    assert.equal(stale.expected.staleAtNow, true);
    assert.equal(stale.expected.retrievableAtNow, false, 'retrieve() filters to staleAfter > now');
    assert.equal(stale.expected.statusBeforePrune, 'active');
    assert.equal(stale.expected.statusAfterPrune, 'expired', 'prune() expires stale active records');
    assert.equal(stale.expected.listedInScope, true, 'a stale record stays inspectable via listAll');
    assert.equal(fixture.memory.expectedPrunedCount, 1);
    assert.deepEqual([...fixture.memory.expectedRetrieveHandles], []);

    // staleAfter runs from write time, so an old observedAt alone never makes a record stale.
    assert.equal(stale.expected.staleAfter, new Date(Date.parse(stale.putAt) + 90 * 24 * 60 * 60 * 1_000).toISOString());

    // The point of the condition: old data is still data. Nothing happened
    // inside the window, and "nothing happened" is a known zero, not unknown.
    const outcomes = fixture.lifeState.expected.recentOutcomes;
    assert.equal(outcomes.known, true, 'recentOutcomes must be known-zero, never unknown');
    assert.ok(outcomes.known);
    assert.equal(outcomes.value.windowDays, DEFAULT_RECENT_OUTCOMES_WINDOW_DAYS);
    assert.equal(outcomes.value.windowStart, RECENT_OUTCOMES_WINDOW_START);
    assert.equal(outcomes.value.completedCount, 0);
    assert.deepEqual(outcomes.value.countsByAckState, {});

    // The rest of the projection stays known, with an old derivedFrom.
    const commitments = fixture.lifeState.expected.commitments;
    assert.equal(commitments.known, true);
    assert.ok(commitments.provenance.derivedFrom);
    assert.ok(
      Date.parse(commitments.provenance.derivedFrom) < clockMs - 30 * 24 * 60 * 60 * 1_000,
      'the stale fixture must derive from input that is genuinely old',
    );
  }
});

test('fixtures: conflicting context keeps both sides inspectable and resolves nothing', () => {
  for (const language of FIXTURE_LANGUAGES) {
    const fixture = fixtureFor(language, 'conflicting');
    assert.ok(fixture);

    const original = fixture.memory.records.find((r) => r.handle === 'original');
    const replacement = fixture.memory.records.find((r) => r.handle === 'replacement');
    assert.ok(original && replacement);

    assert.equal(original.expected.statusBeforePrune, 'superseded');
    assert.equal(original.expected.supersededByHandle, 'replacement');
    assert.equal(original.expected.retrievableAtNow, false, 'retrieve() hides the superseded record');
    assert.equal(original.expected.listedInScope, true, 'listAll() still shows the whole chain');
    assert.equal(replacement.supersedesHandle, 'original');
    assert.equal(replacement.expected.retrievableAtNow, true);

    // An unresolved contradiction stays visible alongside the replacement.
    assert.ok(
      fixture.memory.expectedRetrieveHandles.length >= 2,
      'a conflict that retrieves a single record is not a conflict',
    );
    assert.ok(fixture.memory.expectedRetrieveHandles.includes('unresolved'));
    assert.ok(fixture.memory.expectedListAllHandles.includes('original'));

    // Two commitments claim the same instant; both windows must survive.
    const availability = fixture.lifeState.expected.availability;
    assert.ok(availability.known);
    assert.equal(availability.value.busyWindows.length, 2);
    assert.equal(
      availability.value.busyWindows[0].startsAt,
      availability.value.busyWindows[1].startsAt,
      'the double booking is the conflict; merging or dropping a window loses it',
    );
    assert.equal(availability.value.unscheduledCommitmentCount, 1);

    const load = fixture.lifeState.expected.load;
    assert.ok(load.known);
    assert.equal(load.value.openCount, 3);
    assert.equal(load.value.band, 'moderate', 'three open commitments band above LOAD_BAND_THRESHOLDS.light');
  }
});

test('fixtures: sensitive context expects personal_never_export and content-free projection', () => {
  for (const language of FIXTURE_LANGUAGES) {
    const fixture = fixtureFor(language, 'sensitive');
    assert.ok(fixture);

    const sensitiveRecords = fixture.memory.records.filter((r) => r.sensitive);
    assert.ok(sensitiveRecords.length >= 2, `${fixture.id} must carry sensitive records`);
    for (const record of sensitiveRecords) {
      assert.equal(
        record.expected.exportPolicy,
        'personal_never_export',
        'sensitive content has no shareable form',
      );
    }

    // The protection must not depend on the caller remembering the field.
    const defaulted = sensitiveRecords.find((r) => r.input.exportPolicy === undefined);
    assert.ok(defaulted, 'one sensitive record must omit exportPolicy so the contract default is exercised');
    assert.equal(defaulted.expected.exportPolicy, 'personal_never_export');

    assert.equal(fixture.memory.expectedAssertNoPersonalMemoryThrows, true);
    assert.deepEqual([...fixture.memory.expectedShareableAggregateHandles], []);

    // LifeState carries ids and counts, never commitment content.
    assert.ok(
      fixture.expectedAbsentFromProjection.length >= 2,
      'the clinical title and the clinician name must both be asserted absent',
    );
    const state = fixture.lifeState.input.state;
    for (const value of fixture.expectedAbsentFromProjection) {
      const present = Object.values(state.commitments).some(
        (c) => c.title === value || c.person === value || c.description === value,
      );
      assert.ok(present, `"${value}" must exist in the input, or asserting its absence proves nothing`);
    }
  }
});

test('fixtures: only the conflicting cell declares a shareable_aggregate record', () => {
  for (const fixture of LIFE_STATE_MEMORY_FIXTURES) {
    const shareable = fixture.memory.records.filter(
      (r) => r.expected.exportPolicy === 'shareable_aggregate',
    );
    if (fixture.condition === 'conflicting') {
      assert.equal(shareable.length, 1, `${fixture.id} carries the corpus's non-personal record`);
      assert.equal(shareable[0].sensitive, false);
    } else {
      assert.equal(shareable.length, 0, `${fixture.id} must not declare shareable content`);
    }
  }
});

test('fixtures: the expected decision for a condition is language-invariant', () => {
  // Only ids and text may vary across languages. A decision that changes with
  // the language is a multilingual regression by definition.
  const skeletonOf = (fixture: LifeStateMemoryFixture): string => {
    const shaped = {
      condition: fixture.condition,
      lifeState: fixture.lifeState.expected,
      memory: {
        records: fixture.memory.records.map((record) => ({
          handle: record.handle,
          putAt: record.putAt,
          observedAt: record.input.observedAt,
          scopeId: record.input.scopeId,
          kind: record.input.kind,
          source: record.input.source,
          confidence: record.input.confidence,
          declaredExportPolicy: record.input.exportPolicy ?? null,
          evidenceIds: record.input.evidenceIds ?? [],
          supersedesHandle: record.supersedesHandle ?? null,
          sensitive: record.sensitive,
          expected: record.expected,
        })),
        expectedRetrieveHandles: fixture.memory.expectedRetrieveHandles,
        expectedListAllHandles: fixture.memory.expectedListAllHandles,
        expectedPrunedCount: fixture.memory.expectedPrunedCount,
        expectedAssertNoPersonalMemoryThrows: fixture.memory.expectedAssertNoPersonalMemoryThrows,
        expectedShareableAggregateHandles: fixture.memory.expectedShareableAggregateHandles,
      },
      absentAssertionCount: fixture.expectedAbsentFromProjection.length,
    };
    return JSON.stringify(shaped).replace(new RegExp(`-${fixture.language}(?=[-"])`, 'g'), '-<lang>');
  };

  for (const condition of CONTEXT_CONDITIONS) {
    const skeletons = FIXTURE_LANGUAGES.map((language) => {
      const fixture = fixtureFor(language, condition);
      assert.ok(fixture);
      return { language, skeleton: skeletonOf(fixture) };
    });
    for (const entry of skeletons.slice(1)) {
      assert.equal(
        entry.skeleton,
        skeletons[0].skeleton,
        `${condition}: the ${entry.language} expectation differs from the ${skeletons[0].language} one`,
      );
    }
  }
});

/* ── Seeded failure: prove the validator can reject ──────────────── */

test('fixtures: the validator rejects every seeded malformed fixture with its declared code', () => {
  assert.ok(MALFORMED_FIXTURES.length >= 15, 'the negative corpus must exercise a real range of defects');
  for (const malformed of MALFORMED_FIXTURES) {
    const result = validateFixture(malformed.fixture);
    assert.equal(result.valid, false, `${malformed.id} was accepted despite: ${malformed.defect}`);
    const codes = result.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.code);
    assert.ok(
      codes.includes(malformed.expectedIssueCode),
      `${malformed.id} was rejected for the wrong reason. Expected ${malformed.expectedIssueCode}, got [${codes.join(', ')}]`,
    );
  }
});

test('fixtures: every declared malformed issue code is distinct enough to be worth a case', () => {
  const codes = MALFORMED_FIXTURES.map((m) => m.expectedIssueCode);
  assert.ok(new Set(codes).size >= 12, 'the negative corpus must cover more than a handful of distinct rules');
  const ids = MALFORMED_FIXTURES.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, 'malformed case ids must be unique');
});

test('fixtures: the seeded-failure runner reports every malformed fixture as detected', () => {
  const outcomes = runFixtureSeededFailureTest();
  assert.equal(outcomes.length, MALFORMED_FIXTURES.length);
  const undetected = outcomes.filter((outcome) => !outcome.detected);
  assert.deepEqual(
    undetected.map((outcome) => `${outcome.caseId}: ${outcome.detail}`),
    [],
    'a validator that cannot fail is not evidence of anything',
  );
});

/* ── Coverage report ─────────────────────────────────────────────── */

test('coverage report: full matrix, passing gate, QA-only header', () => {
  const report = buildFixtureCoverageReport({ generatedAt: FIXTURE_CLOCK_ISO });

  assert.equal(report.totalFixtures, 16);
  assert.equal(report.validFixtures, 16);
  assert.equal(report.invalidFixtures, 0);
  assert.deepEqual(report.gaps, []);
  assert.deepEqual(report.corpusIssues, []);
  assert.equal(report.seededFailureTested, true);
  assert.equal(report.status, 'GATE PASSED');
  assert.equal(report.totalMemoryRecords, 32);
  assert.equal(report.totalSensitiveRecords, 8);
  assert.ok(report.totalBidirectionalStrings > 0, 'the corpus must carry bidirectional text');

  for (const language of report.languages) {
    for (const condition of report.conditions) {
      const cell = report.matrix[language][condition];
      assert.equal(cell.fixtureIds.length, 1, `${language} x ${condition} must hold exactly one fixture`);
      assert.equal(cell.valid, true);
    }
  }

  const markdown = generateFixtureCoverageMarkdown(report);
  assert.match(markdown, /SYNTHETIC — ENGINEERING QA ONLY — NOT HUMAN EVIDENCE/);
  assert.match(markdown, /Status: \*\*GATE PASSED\*\*/);
  assert.match(markdown, /## Coverage matrix/);
  assert.doesNotMatch(markdown, /\*\*GAP\*\*/);
  for (const fixture of LIFE_STATE_MEMORY_FIXTURES) {
    assert.ok(markdown.includes(fixture.id), `report must name ${fixture.id}`);
  }
});

test('coverage report: a missing cell fails the gate loudly', () => {
  const withoutArabic = LIFE_STATE_MEMORY_FIXTURES.filter((f) => f.language !== 'ar');
  const report = buildFixtureCoverageReport({ fixtures: withoutArabic, generatedAt: FIXTURE_CLOCK_ISO });

  assert.equal(report.status, 'GATE FAILED');
  assert.equal(report.gaps.length, CONTEXT_CONDITIONS.length);
  assert.ok(report.gaps.every((gap) => gap.language === 'ar'));
  assert.ok(report.corpusIssues.some((issue) => issue.includes('COVERAGE_GAP')));
  assert.match(generateFixtureCoverageMarkdown(report), /\*\*GAP\*\*/);
});
