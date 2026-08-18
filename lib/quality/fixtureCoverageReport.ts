/**
 * SYNTHETIC — ENGINEERING QA ONLY — NOT HUMAN EVIDENCE
 *
 * Coverage report for the Life-State / runtime-memory fixture corpus
 * (Sprint 02, issue #11).
 *
 * Reports coverage across language × context-condition and renders it as
 * markdown plus JSON, mirroring the shape of `generateMarkdownReport` in
 * lib/quality/alphaQualityHarness.ts: a header line of totals, a `GATE PASSED`
 * / `GATE FAILED` status, a seeded-failure line, then the breakdown.
 *
 * This lives in lib/quality/ rather than lib/lifeState/ for two reasons. It is
 * a report generator, and every other report generator in the repo lives here
 * next to the harness whose output shape it copies; and lib/lifeState/ belongs
 * to the projection (#9), where fixtureValidator.ts is the single agreed
 * exception.
 *
 * A gate here fails on a coverage gap, a fixture that does not validate, or a
 * seeded malformed fixture the validator failed to reject. The last one
 * matters most: a validator that cannot fail is not evidence of anything.
 */
import {
  describeIssues,
  validateFixture,
  validateFixtureCorpus,
} from '../lifeState/fixtureValidator';
import {
  CONTEXT_CONDITIONS,
  FIXTURE_LANGUAGES,
  LIFE_STATE_MEMORY_FIXTURES,
  MALFORMED_FIXTURES,
  type ContextCondition,
  type LifeStateMemoryFixture,
  type MalformedFixtureCase,
} from '../../tests/fixtures/lifeStateMemoryFixtures';
import type { MemoryLanguage } from '../../src/contracts/v1/memoryContracts';

/* ── Types ──────────────────────────────────────────────────────── */

export interface CoverageCell {
  fixtureIds: string[];
  memoryRecordCount: number;
  inScopeRecordCount: number;
  sensitiveRecordCount: number;
  /** Fixture text carrying an RTL script and Latin or digits in the same run. */
  bidirectionalStringCount: number;
  valid: boolean;
}

export interface CoverageGap {
  language: string;
  condition: string;
  reason: string;
}

export interface SeededFailureOutcome {
  caseId: string;
  defect: string;
  expectedIssueCode: string;
  detected: boolean;
  detail: string;
}

export interface FixtureCoverageReport {
  generatedAt: string;
  totalFixtures: number;
  validFixtures: number;
  invalidFixtures: number;
  languages: string[];
  conditions: string[];
  matrix: Record<string, Record<string, CoverageCell>>;
  gaps: CoverageGap[];
  totalMemoryRecords: number;
  totalSensitiveRecords: number;
  totalBidirectionalStrings: number;
  corpusIssues: string[];
  seededFailures: SeededFailureOutcome[];
  seededFailureTested: boolean;
  status: 'GATE PASSED' | 'GATE FAILED';
}

/* ── Helpers ────────────────────────────────────────────────────── */

const RTL_SCRIPT = /[؀-ۿݐ-ݿࢠ-ࣿ֐-׿ﭐ-﷿ﹰ-﻿]/;
const LATIN_OR_DIGIT = /[A-Za-z0-9]/;

/** The genuinely tricky bidi case: an RTL run with Latin or digits inside it. */
function isBidirectional(text: string): boolean {
  return RTL_SCRIPT.test(text) && LATIN_OR_DIGIT.test(text);
}

function fixtureStrings(fixture: LifeStateMemoryFixture): string[] {
  const out: string[] = [];
  for (const commitment of Object.values(fixture.lifeState.input.state.commitments)) {
    out.push(commitment.title);
    if (commitment.person) out.push(commitment.person);
    if (commitment.description) out.push(commitment.description);
  }
  for (const record of fixture.memory.records) out.push(record.input.content);
  return out;
}

function emptyCell(): CoverageCell {
  return {
    fixtureIds: [],
    memoryRecordCount: 0,
    inScopeRecordCount: 0,
    sensitiveRecordCount: 0,
    bidirectionalStringCount: 0,
    valid: true,
  };
}

/* ── Seeded-failure validation ──────────────────────────────────── */

/**
 * Runs every deliberately malformed fixture through the validator and reports
 * whether each was rejected with the issue code it declares. This is the
 * fixture-side counterpart of runSeededFailureTest() in the alpha quality
 * harness: proof that the checker can actually fail.
 */
export function runFixtureSeededFailureTest(
  cases: readonly MalformedFixtureCase[] = MALFORMED_FIXTURES,
): SeededFailureOutcome[] {
  return cases.map((malformed) => {
    const result = validateFixture(malformed.fixture);
    const codes = result.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.code);
    if (result.valid) {
      return {
        caseId: malformed.id,
        defect: malformed.defect,
        expectedIssueCode: malformed.expectedIssueCode,
        detected: false,
        detail: 'validator accepted a fixture that carries a deliberate defect',
      };
    }
    if (!codes.includes(malformed.expectedIssueCode)) {
      return {
        caseId: malformed.id,
        defect: malformed.defect,
        expectedIssueCode: malformed.expectedIssueCode,
        detected: false,
        detail: `rejected, but for the wrong reason: raised [${codes.join(', ')}]`,
      };
    }
    return {
      caseId: malformed.id,
      defect: malformed.defect,
      expectedIssueCode: malformed.expectedIssueCode,
      detected: true,
      detail: `rejected with ${malformed.expectedIssueCode}`,
    };
  });
}

/* ── Report ─────────────────────────────────────────────────────── */

export function buildFixtureCoverageReport(options?: {
  fixtures?: readonly LifeStateMemoryFixture[];
  malformed?: readonly MalformedFixtureCase[];
  generatedAt?: string;
}): FixtureCoverageReport {
  const fixtures = options?.fixtures ?? LIFE_STATE_MEMORY_FIXTURES;
  const matrix: Record<string, Record<string, CoverageCell>> = {};

  for (const language of FIXTURE_LANGUAGES) {
    matrix[language] = {};
    for (const condition of CONTEXT_CONDITIONS) {
      matrix[language][condition] = emptyCell();
    }
  }

  let validFixtures = 0;
  let totalMemoryRecords = 0;
  let totalSensitiveRecords = 0;
  let totalBidirectionalStrings = 0;

  for (const fixture of fixtures) {
    const result = validateFixture(fixture);
    if (result.valid) validFixtures += 1;

    const row = matrix[fixture.language] ?? (matrix[fixture.language] = {});
    const cell = row[fixture.condition] ?? (row[fixture.condition] = emptyCell());

    cell.fixtureIds.push(fixture.id);
    cell.memoryRecordCount += fixture.memory.records.length;
    cell.inScopeRecordCount += fixture.memory.records.filter((r) => r.expected.listedInScope).length;
    cell.sensitiveRecordCount += fixture.memory.records.filter((r) => r.sensitive).length;
    cell.bidirectionalStringCount += fixtureStrings(fixture).filter(isBidirectional).length;
    if (!result.valid) cell.valid = false;

    totalMemoryRecords += fixture.memory.records.length;
    totalSensitiveRecords += fixture.memory.records.filter((r) => r.sensitive).length;
    totalBidirectionalStrings += fixtureStrings(fixture).filter(isBidirectional).length;
  }

  const gaps: CoverageGap[] = [];
  for (const language of FIXTURE_LANGUAGES) {
    for (const condition of CONTEXT_CONDITIONS) {
      const cell = matrix[language]?.[condition];
      if (!cell || cell.fixtureIds.length === 0) {
        gaps.push({ language, condition, reason: 'no fixture covers this language and context condition' });
      } else if (!cell.valid) {
        gaps.push({ language, condition, reason: 'a fixture in this cell does not validate' });
      }
    }
  }

  const corpusResult = validateFixtureCorpus(fixtures);
  const corpusIssues = corpusResult.valid ? [] : describeIssues(corpusResult).split('\n').filter(Boolean);

  const seededFailures = runFixtureSeededFailureTest(options?.malformed ?? MALFORMED_FIXTURES);
  const seededFailureTested = seededFailures.length > 0 && seededFailures.every((outcome) => outcome.detected);

  const invalidFixtures = fixtures.length - validFixtures;
  const passed = gaps.length === 0 && invalidFixtures === 0 && corpusResult.valid && seededFailureTested;

  return {
    generatedAt: options?.generatedAt ?? new Date().toISOString(),
    totalFixtures: fixtures.length,
    validFixtures,
    invalidFixtures,
    languages: [...FIXTURE_LANGUAGES],
    conditions: [...CONTEXT_CONDITIONS],
    matrix,
    gaps,
    totalMemoryRecords,
    totalSensitiveRecords,
    totalBidirectionalStrings,
    corpusIssues,
    seededFailures,
    seededFailureTested,
    status: passed ? 'GATE PASSED' : 'GATE FAILED',
  };
}

export function generateFixtureCoverageMarkdown(report: FixtureCoverageReport): string {
  const lines: string[] = [
    '# Life-State & Memory Fixture Coverage',
    '',
    '> **SYNTHETIC — ENGINEERING QA ONLY — NOT HUMAN EVIDENCE**',
    '',
    `Generated: ${report.generatedAt}`,
    `Fixtures: ${report.totalFixtures} | Valid: ${report.validFixtures} | Invalid: ${report.invalidFixtures} | Gaps: ${report.gaps.length}`,
    `Memory records: ${report.totalMemoryRecords} | Sensitive: ${report.totalSensitiveRecords} | Bidirectional strings: ${report.totalBidirectionalStrings}`,
    `Status: **${report.status}**`,
    `Seeded-failure test: ${report.seededFailureTested ? 'PASS' : 'FAIL'} (${report.seededFailures.filter((s) => s.detected).length}/${report.seededFailures.length} malformed fixtures rejected)`,
    '',
    '## Coverage matrix',
    '',
    'Each cell shows `fixtures · memory records · sensitive records`.',
    '',
  ];

  lines.push(`| language | ${report.conditions.join(' | ')} |`);
  lines.push(`|---|${report.conditions.map(() => '---').join('|')}|`);
  for (const language of report.languages) {
    const cells = report.conditions.map((condition) => {
      const cell = report.matrix[language]?.[condition];
      if (!cell || cell.fixtureIds.length === 0) return '**GAP**';
      const flag = cell.valid ? '' : ' ⚠️';
      return `${cell.fixtureIds.length} · ${cell.memoryRecordCount} · ${cell.sensitiveRecordCount}${flag}`;
    });
    lines.push(`| \`${language}\` | ${cells.join(' | ')} |`);
  }

  if (report.gaps.length > 0) {
    lines.push('', '## Gaps', '');
    for (const gap of report.gaps) {
      lines.push(`- **${gap.language} × ${gap.condition}**: ${gap.reason}`);
    }
  }

  if (report.corpusIssues.length > 0) {
    lines.push('', '## Corpus validation issues', '');
    for (const issue of report.corpusIssues) lines.push(`- ${issue}`);
  }

  lines.push('', '## Seeded malformed fixtures', '');
  for (const outcome of report.seededFailures) {
    const mark = outcome.detected ? 'detected' : '**NOT DETECTED**';
    lines.push(`- \`${outcome.caseId}\` (${outcome.expectedIssueCode}): ${mark} — ${outcome.defect}`);
  }

  lines.push('', '## Fixtures by cell', '');
  for (const language of report.languages) {
    for (const condition of report.conditions) {
      const cell = report.matrix[language]?.[condition];
      if (!cell || cell.fixtureIds.length === 0) continue;
      lines.push(
        `- \`${language}\` × \`${condition}\`: ${cell.fixtureIds.map((id) => `\`${id}\``).join(', ')} ` +
          `(${cell.inScopeRecordCount} in-scope records, ${cell.bidirectionalStringCount} bidirectional strings)`,
      );
    }
  }

  lines.push('');
  lines.push('---');
  lines.push('*End of report.*');
  return lines.join('\n');
}

/** Convenience for callers that only want the matrix, e.g. a test assertion. */
export function coverageCell(
  report: FixtureCoverageReport,
  language: MemoryLanguage,
  condition: ContextCondition,
): CoverageCell | undefined {
  return report.matrix[language]?.[condition];
}
