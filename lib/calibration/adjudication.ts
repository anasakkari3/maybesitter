import { ADJUDICATION_CONTRACT_VERSION, CONSISTENCY_DIMENSIONS, DISAGREEMENT_CLASSES } from './contracts';
import type { AdjudicationRecord, AnnotationPolicyRegistry, ConsistencyDimension } from './contracts';
import type { ValidationResult } from '../evaluation/registry/contracts';
import { findPolicy, policyChangeAffects, ruleChangesBetween } from './policy';
import {
  IssueCollector,
  isIsoTimestamp,
  isNonEmptyString,
  isPlainObject,
  isSemver,
} from '../evaluation/registry/validationPrimitives';

const SUPPORTED_CONTRACT_MAJOR = ADJUDICATION_CONTRACT_VERSION.split('.')[0];
const CANONICAL_PASSES = ['first', 'second', 'neither'];

export interface AdjudicationContext {
  policies?: AnnotationPolicyRegistry;
  /** Source ids that actually disagreed, so adjudications cannot be invented. */
  disagreedSourceIds?: readonly string[];
}

function validateRecord(
  collector: IssueCollector,
  path: string,
  value: unknown,
  context: AdjudicationContext,
): AdjudicationRecord | null {
  if (!isPlainObject(value)) {
    collector.error('ADJ010', path, 'adjudication must be an object');
    return null;
  }

  let structurallyValid = true;

  if (!isSemver(value.contractVersion)) {
    collector.error('ADJ011', `${path}.contractVersion`, 'contractVersion must be semver');
  } else if (String(value.contractVersion).split('.')[0] !== SUPPORTED_CONTRACT_MAJOR) {
    collector.error(
      'ADJ012',
      `${path}.contractVersion`,
      `unsupported contract major version ${String(value.contractVersion)}`,
    );
  }
  if (!isNonEmptyString(value.sourceQueueId)) {
    collector.error('ADJ013', `${path}.sourceQueueId`, 'sourceQueueId is required');
    structurallyValid = false;
  }
  if (typeof value.dimension !== 'string' || !(CONSISTENCY_DIMENSIONS as readonly string[]).includes(value.dimension)) {
    collector.error('ADJ023', `${path}.dimension`, `unknown dimension ${String(value.dimension)}`);
    structurallyValid = false;
  }
  if (typeof value.classification !== 'string' || !(DISAGREEMENT_CLASSES as readonly string[]).includes(value.classification)) {
    collector.error('ADJ014', `${path}.classification`, `unknown classification ${String(value.classification)}`);
    structurallyValid = false;
  }
  if (typeof value.canonicalPass !== 'string' || !CANONICAL_PASSES.includes(value.canonicalPass)) {
    collector.error('ADJ015', `${path}.canonicalPass`, `unknown canonicalPass ${String(value.canonicalPass)}`);
    structurallyValid = false;
  }
  for (const field of ['firstPassPolicy', 'secondPassPolicy', 'adjudicatedUnderPolicy'] as const) {
    if (!isSemver(value[field])) {
      collector.error('ADJ016', `${path}.${field}`, `${field} must be a semver policy version`);
      structurallyValid = false;
    }
  }
  if (!isNonEmptyString(value.rationale)) {
    collector.error(
      'ADJ017',
      `${path}.rationale`,
      'an adjudication must record why one pass is canonical; an unexplained override is not traceable',
    );
  }
  if (!isNonEmptyString(value.adjudicatedBy)) {
    collector.error('ADJ018', `${path}.adjudicatedBy`, 'adjudicatedBy is required');
  }
  if (!isIsoTimestamp(value.adjudicatedAt)) {
    collector.error('ADJ019', `${path}.adjudicatedAt`, 'adjudicatedAt must be an ISO timestamp');
  }
  if (!isNonEmptyString(value.authorizingIssue)) {
    collector.error('ADJ020', `${path}.authorizingIssue`, 'authorizingIssue is required');
  }
  if (value.defectId !== null && !isNonEmptyString(value.defectId)) {
    collector.error('ADJ021', `${path}.defectId`, 'defectId must be a defect reference or null');
  }
  if (typeof value.requiresReannotation !== 'boolean') {
    collector.error('ADJ022', `${path}.requiresReannotation`, 'requiresReannotation must be a boolean');
  }

  if (!structurallyValid) return null;
  const record = value as unknown as AdjudicationRecord;

  if (record.classification === 'agreement') {
    collector.error(
      'ADJ030',
      `${path}.classification`,
      'an adjudication records a disagreement; "agreement" is not an outcome that needs one',
    );
  }

  if (record.classification === 'tooling_defect' && record.defectId === null) {
    collector.error(
      'ADJ031',
      `${path}.defectId`,
      'a tooling_defect classification must reference the defect it blames',
    );
  }

  if (
    record.dimension === 'decision' &&
    context.disagreedSourceIds !== undefined &&
    !context.disagreedSourceIds.includes(record.sourceQueueId)
  ) {
    collector.error(
      'ADJ032',
      `${path}.sourceQueueId`,
      `${record.sourceQueueId} did not disagree between passes; there is nothing to adjudicate`,
    );
  }

  const policies = context.policies;
  if (policies !== undefined) {
    for (const field of ['firstPassPolicy', 'secondPassPolicy', 'adjudicatedUnderPolicy'] as const) {
      if (findPolicy(policies, record[field]) === null) {
        collector.error('ADJ040', `${path}.${field}`, `policy version ${record[field]} is not registered`);
      }
    }

    if (record.classification === 'policy_shift') {
      if (record.firstPassPolicy === record.secondPassPolicy) {
        collector.error(
          'ADJ041',
          `${path}.classification`,
          'policy_shift requires the two passes to have been made under different policy versions',
        );
      } else {
        const changes = ruleChangesBetween(policies, record.firstPassPolicy, record.secondPassPolicy);
        if (changes === null) {
          collector.error(
            'ADJ042',
            `${path}.classification`,
            `${record.firstPassPolicy} and ${record.secondPassPolicy} are not on one supersession chain, so the disagreement cannot be attributed to a policy change`,
          );
        } else if (!policyChangeAffects(changes, record.dimension)) {
          collector.error(
            'ADJ043',
            `${path}.classification`,
            `no rule change between ${record.firstPassPolicy} and ${record.secondPassPolicy} affects the ${record.dimension} dimension, so this disagreement may not be labelled policy_shift`,
          );
        }
      }
    }
  }

  return record;
}

/**
 * Adjudications are additive: they are appended alongside the human decisions
 * and never replace them. Validation therefore also rejects two live
 * adjudications for one source, which would make "which pass is canonical"
 * ambiguous.
 */
export function validateAdjudications(
  values: readonly unknown[],
  context: AdjudicationContext = {},
): ValidationResult {
  const collector = new IssueCollector();
  const records: AdjudicationRecord[] = [];

  values.forEach((value, index) => {
    const record = validateRecord(collector, `adjudications[${index}]`, value, context);
    if (record !== null) records.push(record);
  });

  const byScope = new Map<string, number>();
  for (const record of records) {
    const key = `${record.sourceQueueId}/${record.dimension}`;
    byScope.set(key, (byScope.get(key) ?? 0) + 1);
  }
  byScope.forEach((count, key) => {
    if (count > 1) {
      collector.error(
        'ADJ050',
        `adjudications.${key}`,
        `${key} has ${count} adjudications; exactly one may be canonical per source and dimension`,
      );
    }
  });

  return collector.result();
}

export function adjudicationFor(
  records: readonly AdjudicationRecord[],
  sourceQueueId: string,
  dimension: ConsistencyDimension = 'decision',
): AdjudicationRecord | null {
  return (
    records.find(
      (record) => record.sourceQueueId === sourceQueueId && record.dimension === dimension,
    ) ?? null
  );
}

export function adjudicationsForSource(
  records: readonly AdjudicationRecord[],
  sourceQueueId: string,
): readonly AdjudicationRecord[] {
  return records.filter((record) => record.sourceQueueId === sourceQueueId);
}
