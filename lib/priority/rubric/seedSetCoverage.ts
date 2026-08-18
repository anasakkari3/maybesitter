/**
 * SYNTHETIC — ENGINEERING QA ONLY — NOT HUMAN EVIDENCE
 *
 * Coverage and balance report for the Priority annotation seed set
 * (Sprint 04, issue #19).
 *
 * "Balanced across languages and load patterns" is an acceptance criterion, and
 * a criterion checked by an assertion that says `balanced === true` is a
 * criterion nobody can audit. This report therefore emits the whole
 * distribution — every language × load-pattern cell, the reason-mix spread, the
 * split sizes, the designed-ambiguous counts — and names any cell that
 * dominates or is starved, so a reviewer sees the shape rather than a verdict
 * about the shape.
 *
 * Two distinct failure kinds, deliberately treated differently:
 *
 *  - A **gap** (an empty cell) fails the gate. A missing cell means a whole
 *    language or load pattern is unmeasured, and a corpus that silently omits
 *    Hebrew under load is exactly the multilingual regression this set exists
 *    to catch.
 *  - An **imbalance** is reported but does not fail. Adding a second pair to a
 *    cell that needs one is legitimate; a cell carrying ten times its
 *    neighbours is not, and the difference is a judgment a human should make
 *    with the numbers in front of them.
 *
 * Shape and idiom follow lib/quality/fixtureCoverageReport.ts: a header of
 * totals, a GATE PASSED / GATE FAILED status, then the breakdown.
 */
import {
  LOAD_PATTERNS,
  PRIORITY_SEED_PAIRS,
  REASON_MIXES,
  RUBRIC_VERSION,
  SEED_CLOCK_ISO,
  SEED_LANGUAGES,
  reasonMixOf,
  seedPairStrings,
  type LoadPattern,
  type PrioritySeedPair,
  type ReasonMix,
  type SeedLanguage,
} from '../../../tests/fixtures/prioritySeedSet';

/* ── Types ──────────────────────────────────────────────────────── */

export interface SeedCoverageCell {
  pairIds: string[];
  designedAmbiguous: number;
  lockedPairs: number;
  /** Pair text carrying an RTL script and Latin or digits in the same run. */
  bidirectionalStrings: number;
  reasonMixes: string[];
}

export interface SeedCoverageGap {
  language: string;
  loadPattern: string;
  reason: string;
}

export interface SeedCoverageImbalance {
  language: string;
  loadPattern: string;
  pairCount: number;
  meanPairsPerCell: number;
  direction: 'over_represented' | 'under_represented';
}

export interface SeedSetCoverageReport {
  generatedAt: string;
  rubricVersion: string;
  clock: string;
  totalPairs: number;
  languages: string[];
  loadPatterns: string[];
  matrix: Record<string, Record<string, SeedCoverageCell>>;
  byLanguage: Record<string, number>;
  byLoadPattern: Record<string, number>;
  byReasonMix: Record<string, number>;
  uncoveredReasonMixes: string[];
  designedAmbiguousByLanguage: Record<string, number>;
  designedAmbiguousTotal: number;
  lockedPairCount: number;
  calibrationPairCount: number;
  totalBidirectionalStrings: number;
  gaps: SeedCoverageGap[];
  imbalances: SeedCoverageImbalance[];
  status: 'GATE PASSED' | 'GATE FAILED';
}

/* ── Helpers ────────────────────────────────────────────────────── */

const RTL_SCRIPT = /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const LATIN_OR_DIGIT = /[A-Za-z0-9]/;

/** The genuinely tricky bidi case: an RTL run with Latin or digits inside it. */
function isBidirectional(text: string): boolean {
  return RTL_SCRIPT.test(text) && LATIN_OR_DIGIT.test(text);
}

function emptyCell(): SeedCoverageCell {
  return { pairIds: [], designedAmbiguous: 0, lockedPairs: 0, bidirectionalStrings: 0, reasonMixes: [] };
}

function tally<T extends string>(keys: readonly T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of keys) out[key] = 0;
  return out;
}

/* ── Report ─────────────────────────────────────────────────────── */

/**
 * `generatedAt` is required, not defaulted to the host clock. These reports are
 * committed artifacts, so a clock read here makes two runs over identical
 * inputs produce different files — churn that has already had to be discarded
 * twice elsewhere in this repo. The caller that owns the clock (the CLI) passes
 * it in.
 */
export function buildSeedSetCoverageReport(options: {
  pairs?: readonly PrioritySeedPair[];
  generatedAt: string;
}): SeedSetCoverageReport {
  const { generatedAt } = options;
  const pairs = options?.pairs ?? PRIORITY_SEED_PAIRS;

  const matrix: Record<string, Record<string, SeedCoverageCell>> = {};
  for (const language of SEED_LANGUAGES) {
    matrix[language] = {};
    for (const loadPattern of LOAD_PATTERNS) matrix[language][loadPattern] = emptyCell();
  }

  const byLanguage = tally(SEED_LANGUAGES);
  const byLoadPattern = tally(LOAD_PATTERNS);
  const byReasonMix = tally(REASON_MIXES as readonly string[]);
  const designedAmbiguousByLanguage = tally(SEED_LANGUAGES);

  let designedAmbiguousTotal = 0;
  let lockedPairCount = 0;
  let totalBidirectionalStrings = 0;

  for (const pair of pairs) {
    const row = matrix[pair.language] ?? (matrix[pair.language] = {});
    const cell = row[pair.loadPattern] ?? (row[pair.loadPattern] = emptyCell());
    const mix = reasonMixOf(pair);
    const bidirectional = seedPairStrings(pair).filter(isBidirectional).length;

    cell.pairIds.push(pair.pairId);
    cell.bidirectionalStrings += bidirectional;
    if (!cell.reasonMixes.includes(mix)) cell.reasonMixes.push(mix);
    if (pair.designedAmbiguous) cell.designedAmbiguous += 1;
    if (pair.split === 'locked') cell.lockedPairs += 1;

    byLanguage[pair.language] = (byLanguage[pair.language] ?? 0) + 1;
    byLoadPattern[pair.loadPattern] = (byLoadPattern[pair.loadPattern] ?? 0) + 1;
    byReasonMix[mix] = (byReasonMix[mix] ?? 0) + 1;
    if (pair.designedAmbiguous) {
      designedAmbiguousByLanguage[pair.language] = (designedAmbiguousByLanguage[pair.language] ?? 0) + 1;
      designedAmbiguousTotal += 1;
    }
    if (pair.split === 'locked') lockedPairCount += 1;
    totalBidirectionalStrings += bidirectional;
  }

  const gaps: SeedCoverageGap[] = [];
  for (const language of SEED_LANGUAGES) {
    for (const loadPattern of LOAD_PATTERNS) {
      if ((matrix[language]?.[loadPattern]?.pairIds.length ?? 0) === 0) {
        gaps.push({
          language,
          loadPattern,
          reason: 'no seed pair covers this language and load pattern',
        });
      }
    }
  }

  const cellCount = SEED_LANGUAGES.length * LOAD_PATTERNS.length;
  const meanPairsPerCell = pairs.length / cellCount;
  const imbalances: SeedCoverageImbalance[] = [];
  for (const language of SEED_LANGUAGES) {
    for (const loadPattern of LOAD_PATTERNS) {
      const count = matrix[language]?.[loadPattern]?.pairIds.length ?? 0;
      if (count === 0) continue; // already a gap; do not double-report it
      // Over-represented: at least twice the mean *and* at least two pairs clear
      // of it, so a second pair in a cell of ones is not called a skew.
      if (count >= 2 * meanPairsPerCell && count - meanPairsPerCell >= 2) {
        imbalances.push({ language, loadPattern, pairCount: count, meanPairsPerCell, direction: 'over_represented' });
      } else if (count * 2 < meanPairsPerCell) {
        imbalances.push({ language, loadPattern, pairCount: count, meanPairsPerCell, direction: 'under_represented' });
      }
    }
  }

  const uncoveredReasonMixes = (REASON_MIXES as readonly string[]).filter((mix) => (byReasonMix[mix] ?? 0) === 0);

  return {
    generatedAt,
    rubricVersion: RUBRIC_VERSION,
    clock: SEED_CLOCK_ISO,
    totalPairs: pairs.length,
    languages: [...SEED_LANGUAGES],
    loadPatterns: [...LOAD_PATTERNS],
    matrix,
    byLanguage,
    byLoadPattern,
    byReasonMix,
    uncoveredReasonMixes,
    designedAmbiguousByLanguage,
    designedAmbiguousTotal,
    lockedPairCount,
    calibrationPairCount: pairs.length - lockedPairCount,
    totalBidirectionalStrings,
    gaps,
    imbalances,
    status: gaps.length === 0 && uncoveredReasonMixes.length === 0 ? 'GATE PASSED' : 'GATE FAILED',
  };
}

/* ── Markdown ───────────────────────────────────────────────────── */

export function generateSeedSetCoverageMarkdown(report: SeedSetCoverageReport): string {
  const lines: string[] = [
    '# Priority Seed-Set Distribution',
    '',
    '> **SYNTHETIC — ENGINEERING QA ONLY — NOT HUMAN EVIDENCE**',
    '> These are the commitment pairs an annotator is asked to compare. They carry no verdicts:',
    '> no human judgment has been collected.',
    '',
    `Generated: ${report.generatedAt}`,
    `Rubric: \`${report.rubricVersion}\` | Clock: \`${report.clock}\``,
    `Pairs: ${report.totalPairs} | Locked split: ${report.lockedPairCount} | Calibration: ${report.calibrationPairCount}`,
    `Designed-ambiguous: ${report.designedAmbiguousTotal} | Bidirectional strings: ${report.totalBidirectionalStrings}`,
    `Status: **${report.status}**`,
    '',
    '## Distribution: language × load pattern',
    '',
    'Each cell shows `pairs · designed-ambiguous · locked`.',
    '',
  ];

  lines.push(`| language | ${report.loadPatterns.join(' | ')} | total |`);
  lines.push(`|---|${report.loadPatterns.map(() => '---').join('|')}|---|`);
  for (const language of report.languages) {
    const cells = report.loadPatterns.map((loadPattern) => {
      const cell = report.matrix[language]?.[loadPattern];
      if (!cell || cell.pairIds.length === 0) return '**GAP**';
      return `${cell.pairIds.length} · ${cell.designedAmbiguous} · ${cell.lockedPairs}`;
    });
    lines.push(`| \`${language}\` | ${cells.join(' | ')} | ${report.byLanguage[language] ?? 0} |`);
  }
  lines.push(
    `| **total** | ${report.loadPatterns.map((loadPattern) => report.byLoadPattern[loadPattern] ?? 0).join(' | ')} | ${
      report.totalPairs
    } |`,
  );

  lines.push('', '## Distribution: reason mix', '', '| mix | pairs |', '|---|---|');
  for (const mix of Object.keys(report.byReasonMix)) {
    // The `|` separating the two bands has to be escaped or it splits the cell.
    lines.push(`| \`${mix.replace('|', '\\|')}\` | ${report.byReasonMix[mix]} |`);
  }
  if (report.uncoveredReasonMixes.length > 0) {
    lines.push('', 'Uncovered mixes:');
    for (const mix of report.uncoveredReasonMixes) lines.push(`- **\`${mix}\`** has no pair`);
  }

  if (report.gaps.length > 0) {
    lines.push('', '## Gaps', '');
    for (const gap of report.gaps) {
      lines.push(`- **GAP ${gap.language} × ${gap.loadPattern}**: ${gap.reason}`);
    }
  }

  if (report.imbalances.length > 0) {
    lines.push(
      '',
      '## Imbalance',
      '',
      'Reported, not fatal. A deliberate extra pair is legitimate; an unnoticed skew is not.',
      '',
    );
    for (const imbalance of report.imbalances) {
      lines.push(
        `- \`${imbalance.language}\` × \`${imbalance.loadPattern}\`: ${imbalance.pairCount} pairs against a mean of ` +
          `${imbalance.meanPairsPerCell.toFixed(2)} — ${imbalance.direction.replace('_', '-')}`,
      );
    }
  }

  lines.push('', '## Pairs by cell', '');
  for (const language of report.languages) {
    for (const loadPattern of report.loadPatterns) {
      const cell = report.matrix[language]?.[loadPattern];
      if (!cell || cell.pairIds.length === 0) continue;
      lines.push(
        `- \`${language}\` × \`${loadPattern}\`: ${cell.pairIds.map((id) => `\`${id}\``).join(', ')} ` +
          `(mixes: ${cell.reasonMixes.join(', ')})`,
      );
    }
  }

  lines.push('');
  lines.push('---');
  lines.push('*End of report.*');
  return lines.join('\n');
}

/** Convenience for callers that only want one cell, e.g. a test assertion. */
export function seedCoverageCell(
  report: SeedSetCoverageReport,
  language: SeedLanguage,
  loadPattern: LoadPattern,
): SeedCoverageCell | undefined {
  return report.matrix[language]?.[loadPattern];
}

export type { ReasonMix };
