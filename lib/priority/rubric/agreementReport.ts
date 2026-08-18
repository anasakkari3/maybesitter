/**
 * Inter-annotator agreement for the Priority annotation corpus
 * (Sprint 04, issue #19).
 *
 * ── Status ─────────────────────────────────────────────────────────
 *
 * **No judgments exist.** Sprint 04 ships this ingestion point *wired and
 * empty*: schema, loader, validation and the agreement arithmetic are all here
 * and tested, and `data/quality/priority-judgments.json` carries zero rows. The
 * point of shipping it wired is that the first real annotation run needs no code
 * change — so the arithmetic below has to be correct now, against judgments that
 * do not yet exist, rather than sketched and fixed later.
 *
 * `AgreementReport.corpusEmpty` exists for the same reason: a report over no
 * judgments must say so. Rendering `observedAgreement: 0` over an empty corpus
 * would present the absence of data as a measurement of total disagreement,
 * which is not a smaller error than fabricating rows — it is the same error
 * wearing a number.
 *
 * ── How `unresolved` is handled, and why ───────────────────────────
 *
 * `unresolved` is **excluded from the observed-agreement denominator**. It is
 * neither agreement nor disagreement; it is reported separately as
 * `unresolvedCount`, and the pairs it makes unscorable are reported as
 * `unscorablePairCount`.
 *
 * The two alternatives were considered and rejected:
 *
 *  - *Two `unresolved` verdicts count as agreement.* This makes abstention the
 *    cheapest way to raise the score. Two annotators who both gave up on a pair
 *    have demonstrated nothing about whether they would order it the same way,
 *    and a metric maximised by giving up will be maximised by giving up.
 *  - *`unresolved` counts against agreement.* This penalises an annotator for
 *    correctly following the rubric's abstention rules and pushes them to guess,
 *    converting honest abstention into fabricated preference — the exact failure
 *    this whole track exists to prevent.
 *
 * Exclusion has a cost — agreement is then computed over a *subset* — and the
 * report states that cost rather than hiding it: every rendering of the
 * agreement figure carries the pair coverage next to it, because 100% over one
 * of forty pairs is not a high agreement rate, it is a rubric nobody could
 * apply.
 *
 * ── Unit of agreement ──────────────────────────────────────────────
 *
 * The unit is the **annotator pair within one seed pair**, not the seed pair.
 * With two annotators the two coincide; with three, a pair on which two agree
 * and one dissents is 1/3 agreement rather than a binary "disagreed", which is
 * the honest reading and the one that stays stable as annotators are added.
 */
import type {
  AgreementReport,
  JudgmentVerdict,
  PairwiseJudgment,
} from '../../../src/contracts/v1/priorityContracts';
import { PRIORITY_SCHEMA_VERSION } from '../../../src/contracts/v1/priorityContracts';
import type { ValidationIssue } from '../../evaluation/registry/contracts';
import { IssueCollector, isIsoTimestamp, isNonEmptyString, isPlainObject } from '../../evaluation/registry/validationPrimitives';
import { RUBRIC_VERSION, type PrioritySeedPair } from '../../../tests/fixtures/prioritySeedSet';

/* ── Corpus schema ──────────────────────────────────────────────── */

/**
 * Versioned separately from the rubric: the rubric governs how a verdict is
 * *decided*, this governs how a row is *shaped*. A loader that guesses at an
 * unrecognised version is a loader that silently mis-reads the next schema.
 */
export const JUDGMENT_CORPUS_CONTRACT_VERSION = 'priority-judgments-v1' as const;

export interface PairwiseJudgmentCorpus {
  readonly contractVersion: typeof JUDGMENT_CORPUS_CONTRACT_VERSION;
  readonly rubricVersion?: string;
  readonly judgments: readonly PairwiseJudgment[];
}

const VERDICTS: readonly JudgmentVerdict[] = Object.freeze(['left', 'right', 'tie', 'unresolved']);

const JUDGMENT_KEYS: readonly string[] = Object.freeze([
  'pairId',
  'leftCommitmentId',
  'rightCommitmentId',
  'verdict',
  'annotatorId',
  'rationale',
  'judgedAt',
]);

const CORPUS_KEYS: readonly string[] = Object.freeze(['contractVersion', 'rubricVersion', 'judgments']);

/* ── Loader ─────────────────────────────────────────────────────── */

export interface JudgmentLoadResult {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
  /** Only rows that validated. A rejected row never reaches the report. */
  readonly judgments: readonly PairwiseJudgment[];
  readonly corpusEmpty: boolean;
  readonly rubricVersion: string | null;
}

export interface LoadJudgmentsOptions {
  /**
   * When supplied, every judgment must name a pair that exists and must orient
   * left/right the same way the pair does. Optional so the loader can validate
   * shape without the seed set, but any real ingestion should pass it: a verdict
   * of `left` means nothing if `left` referred to something else.
   */
  readonly seedPairs?: readonly PrioritySeedPair[];
}

export function loadPairwiseJudgments(raw: unknown, options?: LoadJudgmentsOptions): JudgmentLoadResult {
  const collector = new IssueCollector();

  if (!isPlainObject(raw)) {
    collector.error('PRJ001', 'corpus', 'judgment corpus must be an object');
    return { valid: false, issues: collector.result().issues, judgments: [], corpusEmpty: true, rubricVersion: null };
  }

  for (const key of Object.keys(raw)) {
    if (!CORPUS_KEYS.includes(key)) {
      collector.error('PRJ003', `corpus.${key}`, `unknown corpus field '${key}'`);
    }
  }

  if (raw.contractVersion !== JUDGMENT_CORPUS_CONTRACT_VERSION) {
    collector.error(
      'PRJ002',
      'corpus.contractVersion',
      `expected '${JUDGMENT_CORPUS_CONTRACT_VERSION}', found ${JSON.stringify(raw.contractVersion)}`,
    );
  }

  const rubricVersion = typeof raw.rubricVersion === 'string' ? raw.rubricVersion : null;
  if (rubricVersion !== null && rubricVersion !== RUBRIC_VERSION) {
    // A warning, not an error: judgments collected under an older rubric are
    // real judgments. They are simply not comparable with newer ones, and that
    // has to be visible rather than fatal.
    collector.warn(
      'PRJ004',
      'corpus.rubricVersion',
      `judgments were collected under '${rubricVersion}' but the current rubric is '${RUBRIC_VERSION}'; ` +
        'they are not comparable across rubric versions',
    );
  }

  if (!Array.isArray(raw.judgments)) {
    collector.error('PRJ005', 'corpus.judgments', 'judgments must be an array');
    return { valid: false, issues: collector.result().issues, judgments: [], corpusEmpty: true, rubricVersion };
  }

  const byPairId = new Map<string, PrioritySeedPair>();
  for (const pair of options?.seedPairs ?? []) byPairId.set(pair.pairId, pair);

  const accepted: PairwiseJudgment[] = [];
  const seen = new Set<string>();

  raw.judgments.forEach((row, index) => {
    const path = `corpus.judgments[${index}]`;
    const before = collector.result().issues.length;

    if (!isPlainObject(row)) {
      collector.error('PRJ010', path, 'judgment must be an object');
      return;
    }

    for (const key of Object.keys(row)) {
      if (!JUDGMENT_KEYS.includes(key)) {
        collector.error('PRJ019', `${path}.${key}`, `unknown judgment field '${key}'`);
      }
    }

    if (!isNonEmptyString(row.pairId)) collector.error('PRJ011', `${path}.pairId`, 'pairId must be a non-empty string');
    if (!isNonEmptyString(row.leftCommitmentId)) {
      collector.error('PRJ012', `${path}.leftCommitmentId`, 'leftCommitmentId must be a non-empty string');
    }
    if (!isNonEmptyString(row.rightCommitmentId)) {
      collector.error('PRJ013', `${path}.rightCommitmentId`, 'rightCommitmentId must be a non-empty string');
    }
    if (
      isNonEmptyString(row.leftCommitmentId) &&
      row.leftCommitmentId === row.rightCommitmentId
    ) {
      collector.error('PRJ014', path, 'a judgment cannot compare a commitment with itself');
    }
    if (!VERDICTS.includes(row.verdict as JudgmentVerdict)) {
      collector.error('PRJ015', `${path}.verdict`, `verdict must be one of ${VERDICTS.join(' | ')}`);
    }
    if (!isNonEmptyString(row.annotatorId)) {
      collector.error('PRJ016', `${path}.annotatorId`, 'annotatorId must be a non-empty string');
    }
    if (!isNonEmptyString(row.rationale)) {
      // Mandatory even for `tie`. A verdict with no stated criterion cannot be
      // audited against the rubric, and an unauditable corpus cannot be trusted.
      collector.error('PRJ017', `${path}.rationale`, 'rationale is mandatory and must name a rubric criterion');
    }
    if (!isIsoTimestamp(row.judgedAt)) {
      collector.error('PRJ018', `${path}.judgedAt`, 'judgedAt must be an ISO-8601 timestamp');
    }

    if (isNonEmptyString(row.pairId) && isNonEmptyString(row.annotatorId)) {
      const key = `${row.pairId}::${row.annotatorId}`;
      if (seen.has(key)) {
        collector.error(
          'PRJ020',
          path,
          `annotator '${row.annotatorId}' judged pair '${row.pairId}' more than once; ` +
            'agreement over a repeated judgment is not agreement between annotators',
        );
      }
      seen.add(key);
    }

    if (byPairId.size > 0 && isNonEmptyString(row.pairId)) {
      const pair = byPairId.get(row.pairId);
      if (!pair) {
        collector.error('PRJ021', `${path}.pairId`, `no seed pair '${row.pairId}' exists`);
      } else if (
        pair.left.commitment.id !== row.leftCommitmentId ||
        pair.right.commitment.id !== row.rightCommitmentId
      ) {
        collector.error(
          'PRJ022',
          path,
          `judgment orients '${row.pairId}' as ${row.leftCommitmentId} / ${row.rightCommitmentId}, ` +
            `but the seed pair is ${pair.left.commitment.id} / ${pair.right.commitment.id}; ` +
            "a verdict of 'left' would refer to a different commitment",
        );
      }
    }

    if (collector.result().issues.length === before) accepted.push(row as unknown as PairwiseJudgment);
  });

  const result = collector.result();
  return {
    valid: result.valid,
    issues: result.issues,
    judgments: result.valid ? accepted : [],
    corpusEmpty: accepted.length === 0,
    rubricVersion,
  };
}

/* ── Report ─────────────────────────────────────────────────────── */

export interface AnnotatorSummary {
  readonly annotatorId: string;
  readonly judgmentCount: number;
  readonly unresolvedCount: number;
  /** Abstentions over all this annotator's rows, so a serial abstainer shows up. */
  readonly unresolvedRate: number;
  /** Concordance with every other annotator, or null with nothing to compare. */
  readonly agreementWithOthers: number | null;
}

/**
 * Extends the committed `AgreementReport` rather than replacing it. The contract
 * fixes the fields a consumer may rely on; these add the coverage figures that
 * make `observedAgreement` readable without being misread.
 */
/**
 * `rubricVersion`, `scorablePairCount` and `unscorablePairCount` moved into the
 * committed `AgreementReport` at merge — they belong with the figure they
 * qualify, not beside it. What remains here is the detail a report needs and a
 * consumer of the contract does not.
 */
export interface PriorityAgreementReport extends AgreementReport {
  readonly judgmentCount: number;
  /** Annotator-pair comparisons in the denominator. */
  readonly comparableVerdictPairCount: number;
  readonly concordantVerdictPairCount: number;
  readonly perAnnotator: readonly AnnotatorSummary[];
  readonly status: 'CORPUS EMPTY' | 'NO COMPARABLE VERDICTS' | 'REPORTED';
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Code-unit comparison, never localeCompare: ordering must not depend on the host locale. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * `generatedAt` is required for the same reason it is on the coverage report:
 * this output is committed, so reading the host clock here would make an
 * unchanged corpus produce a changed file.
 */
export function buildAgreementReport(
  judgments: readonly PairwiseJudgment[],
  options: { generatedAt: string; rubricVersion?: string },
): PriorityAgreementReport {
  const { generatedAt } = options;
  const rubricVersion = options.rubricVersion ?? RUBRIC_VERSION;

  const pairIds = Array.from(new Set(judgments.map((judgment) => judgment.pairId))).sort(byCodeUnit);
  const annotatorIds = Array.from(new Set(judgments.map((judgment) => judgment.annotatorId))).sort(byCodeUnit);
  const unresolvedCount = judgments.filter((judgment) => judgment.verdict === 'unresolved').length;

  let comparable = 0;
  let concordant = 0;
  let scorablePairCount = 0;
  const disagreements: string[] = [];
  const perAnnotatorComparisons = new Map<string, { comparable: number; concordant: number }>();

  for (const pairId of pairIds) {
    // Abstentions drop out here, and only here. Everything downstream — the
    // denominator, the disagreement list, the scorable-pair count — follows from
    // this one exclusion, so the rule lives in one place.
    const resolving = judgments
      .filter((judgment) => judgment.pairId === pairId && judgment.verdict !== 'unresolved')
      .sort((a, b) => byCodeUnit(a.annotatorId, b.annotatorId));

    if (resolving.length >= 2) scorablePairCount += 1;

    for (let i = 0; i < resolving.length; i += 1) {
      for (let j = i + 1; j < resolving.length; j += 1) {
        const left = resolving[i];
        const right = resolving[j];
        comparable += 1;
        const agree = left.verdict === right.verdict;
        if (agree) {
          concordant += 1;
        } else {
          disagreements.push(
            `${pairId}: ${left.annotatorId}='${left.verdict}' vs ${right.annotatorId}='${right.verdict}'`,
          );
        }
        for (const annotatorId of [left.annotatorId, right.annotatorId]) {
          const tally = perAnnotatorComparisons.get(annotatorId) ?? { comparable: 0, concordant: 0 };
          tally.comparable += 1;
          if (agree) tally.concordant += 1;
          perAnnotatorComparisons.set(annotatorId, tally);
        }
      }
    }
  }

  const perAnnotator: AnnotatorSummary[] = annotatorIds.map((annotatorId) => {
    const rows = judgments.filter((judgment) => judgment.annotatorId === annotatorId);
    const abstentions = rows.filter((judgment) => judgment.verdict === 'unresolved').length;
    const tally = perAnnotatorComparisons.get(annotatorId);
    return {
      annotatorId,
      judgmentCount: rows.length,
      unresolvedCount: abstentions,
      unresolvedRate: rows.length === 0 ? 0 : round4(abstentions / rows.length),
      agreementWithOthers: tally && tally.comparable > 0 ? round4(tally.concordant / tally.comparable) : null,
    };
  });

  const corpusEmpty = judgments.length === 0;

  return {
    version: PRIORITY_SCHEMA_VERSION,
    generatedAt,
    rubricVersion,
    pairCount: pairIds.length,
    annotatorCount: annotatorIds.length,
    judgmentCount: judgments.length,
    observedAgreement: comparable === 0 ? null : round4(concordant / comparable),
    unresolvedCount,
    disagreements: disagreements.sort(byCodeUnit),
    corpusEmpty,
    scorablePairCount,
    unscorablePairCount: pairIds.length - scorablePairCount,
    comparableVerdictPairCount: comparable,
    concordantVerdictPairCount: concordant,
    perAnnotator,
    status: corpusEmpty ? 'CORPUS EMPTY' : comparable === 0 ? 'NO COMPARABLE VERDICTS' : 'REPORTED',
  };
}

/* ── Markdown ───────────────────────────────────────────────────── */

const UNRESOLVED_RULE =
  'An `unresolved` verdict is **excluded from the denominator**: it counts as neither agreement nor ' +
  'disagreement. Counting two abstentions as agreement would make giving up the cheapest way to raise the ' +
  'score; counting abstention as disagreement would push annotators to guess. Agreement is therefore ' +
  'computed over a subset, and the pair coverage below is part of the figure, not a footnote to it.';

export function generateAgreementMarkdown(report: PriorityAgreementReport): string {
  const lines: string[] = [
    '# Priority Inter-Annotator Agreement',
    '',
    '> The commitment pairs compared here are **SYNTHETIC — ENGINEERING QA ONLY — NOT HUMAN EVIDENCE**',
    '> (`tests/fixtures/prioritySeedSet.ts`). The *verdicts*, when any exist, are human judgments and are',
    '> the only human evidence in this report.',
    '',
    `Generated: ${report.generatedAt}`,
    `Rubric: \`${report.rubricVersion}\` | Schema: \`${report.version}\``,
    `Status: **${report.status}**`,
    '',
  ];

  if (report.corpusEmpty) {
    lines.push(
      '## No annotation has been collected',
      '',
      'The judgment corpus contains **no judgments**. Sprint 04 ships this ingestion point wired and empty:',
      'the schema, loader, validation and agreement arithmetic are present and tested, and zero rows exist.',
      '',
      'No agreement figure is reported, because there is nothing to report. An `observedAgreement` of 0 here',
      'would present the absence of data as a measurement of total disagreement.',
      '',
      `${UNRESOLVED_RULE}`,
      '',
      'To supply real judgments, see §9.1 of `docs/quality/PRIORITY_ANNOTATION_RUBRIC.md`.',
      '',
      '---',
      '*End of report.*',
    );
    return lines.join('\n');
  }

  const agreement =
    report.observedAgreement === null ? 'not computable' : `${(report.observedAgreement * 100).toFixed(1)}%`;

  lines.push(
    '## Headline',
    '',
    `Observed agreement: **${agreement}**`,
    `Computed over ${report.scorablePairCount} of ${report.pairCount} pairs ` +
      `(${report.concordantVerdictPairCount}/${report.comparableVerdictPairCount} annotator-pair comparisons).`,
    `Judgments: ${report.judgmentCount} | Annotators: ${report.annotatorCount} | ` +
      `Unresolved: ${report.unresolvedCount} | Unscorable pairs: ${report.unscorablePairCount}`,
    '',
    '### How `unresolved` is treated',
    '',
    UNRESOLVED_RULE,
    '',
  );

  if (report.observedAgreement === null) {
    lines.push(
      '> No pair carries two resolving verdicts, so no agreement figure is computable. Rows exist, but every',
      '> one of them is an abstention or stands alone.',
      '',
    );
  }

  lines.push('## Per annotator', '', '| annotator | judgments | unresolved | unresolved rate | agreement with others |', '|---|---|---|---|---|');
  for (const row of report.perAnnotator) {
    lines.push(
      `| \`${row.annotatorId}\` | ${row.judgmentCount} | ${row.unresolvedCount} | ` +
        `${(row.unresolvedRate * 100).toFixed(1)}% | ` +
        `${row.agreementWithOthers === null ? 'n/a' : `${(row.agreementWithOthers * 100).toFixed(1)}%`} |`,
    );
  }

  lines.push('', '## Disagreements', '');
  if (report.disagreements.length === 0) {
    lines.push('None. Every comparable annotator pair reached the same verdict.');
  } else {
    for (const disagreement of report.disagreements) lines.push(`- ${disagreement}`);
  }

  lines.push('', '---', '*End of report.*');
  return lines.join('\n');
}
