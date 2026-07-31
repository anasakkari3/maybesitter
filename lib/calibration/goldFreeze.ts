import { GOLD_FREEZE_CONTRACT_VERSION } from './contracts';
import type {
  AdjudicationRecord,
  FrozenGoldRecord,
  GateInput,
  GoldFreezeManifest,
} from './contracts';
import type { ConsistencyGateReport } from './contracts';
import type { PerItemAnnotation, ReviewDecision } from './consistency';
import { adjudicationFor, adjudicationsForSource } from './adjudication';
import { gateAuthorizesFreeze } from './gate';
import { canonicalJson, checksumOf } from '../evaluation/registry/fingerprint';
import type { Checksum, ValidationResult } from '../evaluation/registry/contracts';
import {
  IssueCollector,
  checksumsEqual,
  isIsoTimestamp,
  isNonEmptyString,
  isPlainObject,
  isSemver,
  isValidChecksum,
} from '../evaluation/registry/validationPrimitives';

const SUPPORTED_CONTRACT_MAJOR = GOLD_FREEZE_CONTRACT_VERSION.split('.')[0];

export interface BuildFreezeInput {
  freezeId: string;
  version: string;
  frozenAt: string;
  frozenBy: string;
  authorizingIssue: string;
  policyVersion: string;
  gateReport: ConsistencyGateReport;
  inputs: readonly GateInput[];
  /** Canonical human decisions, exactly as written. Never modified. */
  decisions: readonly ReviewDecision[];
  /** Raw decision lines, so the freeze pins the bytes a reviewer actually wrote. */
  decisionLines: ReadonlyMap<string, string>;
  adjudications: readonly AdjudicationRecord[];
  perItemAnnotations: readonly PerItemAnnotation[];
}

/**
 * Builds the freeze manifest.
 *
 * The manifest is a *pointer* structure: it checksums the canonical decision
 * lines in place rather than copying or rewriting them, so the reviewer's own
 * records stay the single source of truth and any later edit to them is
 * detectable. A source whose adjudication says it still needs re-annotation is
 * excluded, with the reason recorded, rather than frozen in a known-bad state.
 */
export function buildGoldFreezeManifest(input: BuildFreezeInput): GoldFreezeManifest {
  if (!gateAuthorizesFreeze(input.gateReport)) {
    throw new Error(
      `cannot freeze Gold: consistency gate ${input.gateReport.reportId} status is ${input.gateReport.status}`,
    );
  }

  const perItemIndex = new Map<string, { annotation: PerItemAnnotation; index: number }>();
  input.perItemAnnotations.forEach((annotation, index) => {
    // Append-only file: the last annotation of a source is the canonical one.
    perItemIndex.set(annotation.sourceQueueId, { annotation, index });
  });

  const records: FrozenGoldRecord[] = [];

  for (const decision of input.decisions) {
    const scoped = adjudicationsForSource(input.adjudications, decision.sourceQueueId);
    const decisionAdjudication = adjudicationFor(input.adjudications, decision.sourceQueueId, 'decision');
    const line = input.decisionLines.get(decision.sourceQueueId);
    const perItem = perItemIndex.get(decision.sourceQueueId);

    // A source is excluded when ANY dimension still needs re-annotation: its
    // decision may be settled while its per-item Gold is known-bad.
    const blocking = scoped.filter((record) => record.requiresReannotation);

    records.push({
      sourceQueueId: decision.sourceQueueId,
      decisionChecksum: checksumOf(line ?? canonicalJson(decision)),
      decision: decision.decision,
      policyVersion: input.policyVersion,
      canonicalPass: decisionAdjudication === null ? 'first' : decisionAdjudication.canonicalPass,
      adjudicated: scoped.length > 0,
      perItemChecksum: perItem ? checksumOf(canonicalJson(perItem.annotation)) : null,
      perItemAnnotationIndex: perItem ? perItem.index : null,
      excluded: blocking.length > 0,
      exclusionReason:
        blocking.length > 0
          ? `${blocking
              .map((record) => `${record.dimension} defect ${record.defectId ?? 'n/a'}`)
              .join('; ')} requires re-annotation before this Gold is usable`
          : null,
    });
  }

  records.sort((a, b) => (a.sourceQueueId < b.sourceQueueId ? -1 : 1));

  return {
    contractVersion: GOLD_FREEZE_CONTRACT_VERSION,
    freezeId: input.freezeId,
    version: input.version,
    state: 'frozen',
    frozenAt: input.frozenAt,
    frozenBy: input.frozenBy,
    authorizingIssue: input.authorizingIssue,
    policyVersion: input.policyVersion,
    gateReportId: input.gateReport.reportId,
    supersededBy: null,
    inputs: input.inputs,
    records,
    recordsChecksum: checksumOf(canonicalJson(records)),
    includedCount: records.filter((record) => !record.excluded).length,
    excludedCount: records.filter((record) => record.excluded).length,
    trainingStarted: false,
  };
}

export function recomputeRecordsChecksum(manifest: GoldFreezeManifest): Checksum {
  return checksumOf(canonicalJson(manifest.records));
}

export interface VerifyFreezeContext {
  /** Raw canonical decision lines as they exist now, keyed by source id. */
  decisionLines?: ReadonlyMap<string, string>;
  gateReport?: ConsistencyGateReport;
}

export function validateGoldFreezeManifest(
  value: unknown,
  context: VerifyFreezeContext = {},
): ValidationResult {
  const collector = new IssueCollector();

  if (!isPlainObject(value)) {
    collector.error('FRZ001', 'freeze', 'freeze manifest must be an object');
    return collector.result();
  }

  if (!isSemver(value.contractVersion)) {
    collector.error('FRZ002', 'freeze.contractVersion', 'contractVersion must be semver');
  } else if (String(value.contractVersion).split('.')[0] !== SUPPORTED_CONTRACT_MAJOR) {
    collector.error(
      'FRZ003',
      'freeze.contractVersion',
      `unsupported contract major version ${String(value.contractVersion)}`,
    );
  }
  if (!isNonEmptyString(value.freezeId)) {
    collector.error('FRZ004', 'freeze.freezeId', 'freezeId is required');
  }
  if (!isSemver(value.version)) {
    collector.error('FRZ005', 'freeze.version', 'freeze version must be semver');
  }
  if (value.state !== 'frozen' && value.state !== 'superseded') {
    collector.error('FRZ006', 'freeze.state', `unknown freeze state ${String(value.state)}`);
  }
  if (!isIsoTimestamp(value.frozenAt)) {
    collector.error('FRZ007', 'freeze.frozenAt', 'frozenAt must be an ISO timestamp');
  }
  if (!isNonEmptyString(value.frozenBy)) {
    collector.error('FRZ008', 'freeze.frozenBy', 'frozenBy is required');
  }
  if (!isNonEmptyString(value.authorizingIssue)) {
    collector.error('FRZ009', 'freeze.authorizingIssue', 'authorizingIssue is required');
  }
  if (!isSemver(value.policyVersion)) {
    collector.error('FRZ010', 'freeze.policyVersion', 'policyVersion must be a semver policy version');
  }
  if (!isNonEmptyString(value.gateReportId)) {
    collector.error(
      'FRZ011',
      'freeze.gateReportId',
      'a freeze must name the consistency gate report that authorized it',
    );
  }

  if (value.trainingStarted !== false) {
    collector.error(
      'FRZ012',
      'freeze.trainingStarted',
      'freezing Gold never starts training; trainingStarted must be false',
    );
  }

  if (value.state === 'superseded' && !isNonEmptyString(value.supersededBy)) {
    collector.error('FRZ013', 'freeze.supersededBy', 'a superseded freeze must name its successor');
  }
  if (value.state === 'frozen' && value.supersededBy !== null) {
    collector.error('FRZ014', 'freeze.supersededBy', 'an active freeze may not declare supersededBy');
  }

  if (!Array.isArray(value.records) || value.records.length === 0) {
    collector.error('FRZ015', 'freeze.records', 'a freeze must contain at least one record');
    return collector.result();
  }

  const seen = new Set<string>();
  const records: FrozenGoldRecord[] = [];

  value.records.forEach((record, index) => {
    const path = `freeze.records[${index}]`;
    if (!isPlainObject(record)) {
      collector.error('FRZ020', path, 'record must be an object');
      return;
    }
    if (!isNonEmptyString(record.sourceQueueId)) {
      collector.error('FRZ021', `${path}.sourceQueueId`, 'sourceQueueId is required');
      return;
    }
    if (seen.has(record.sourceQueueId)) {
      collector.error('FRZ022', `${path}.sourceQueueId`, `duplicate source ${record.sourceQueueId}`);
    }
    seen.add(record.sourceQueueId);

    if (!isValidChecksum(record.decisionChecksum)) {
      collector.error('FRZ023', `${path}.decisionChecksum`, 'decisionChecksum is required');
    }
    if (record.perItemChecksum !== null && !isValidChecksum(record.perItemChecksum)) {
      collector.error('FRZ024', `${path}.perItemChecksum`, 'perItemChecksum must be a checksum or null');
    }
    if (typeof record.excluded !== 'boolean') {
      collector.error('FRZ025', `${path}.excluded`, 'excluded must be a boolean');
    }
    if (record.excluded === true && !isNonEmptyString(record.exclusionReason)) {
      collector.error(
        'FRZ026',
        `${path}.exclusionReason`,
        'an excluded record must say why, so the exclusion is auditable',
      );
    }
    if (record.excluded === false && record.exclusionReason !== null) {
      collector.error('FRZ027', `${path}.exclusionReason`, 'only excluded records may carry a reason');
    }

    records.push(record as unknown as FrozenGoldRecord);
  });

  const included = records.filter((record) => !record.excluded).length;
  const excluded = records.length - included;
  if (value.includedCount !== included) {
    collector.error('FRZ030', 'freeze.includedCount', `includedCount says ${String(value.includedCount)}, records say ${included}`);
  }
  if (value.excludedCount !== excluded) {
    collector.error('FRZ031', 'freeze.excludedCount', `excludedCount says ${String(value.excludedCount)}, records say ${excluded}`);
  }

  if (!isValidChecksum(value.recordsChecksum)) {
    collector.error('FRZ032', 'freeze.recordsChecksum', 'recordsChecksum is required');
  } else {
    const expected = checksumOf(canonicalJson(records));
    if (!checksumsEqual(value.recordsChecksum as Checksum, expected)) {
      collector.error(
        'FRZ033',
        'freeze.recordsChecksum',
        `recordsChecksum ${(value.recordsChecksum as Checksum).value} does not match the records it covers (${expected.value}); the freeze was edited after it was sealed`,
      );
    }
  }

  if (context.gateReport !== undefined && context.gateReport.reportId !== value.gateReportId) {
    collector.error(
      'FRZ040',
      'freeze.gateReportId',
      `freeze cites gate report ${String(value.gateReportId)}, but ${context.gateReport.reportId} was supplied`,
    );
  }
  if (context.gateReport !== undefined && !gateAuthorizesFreeze(context.gateReport)) {
    collector.error(
      'FRZ041',
      'freeze.gateReportId',
      `gate report ${context.gateReport.reportId} status ${context.gateReport.status} does not authorize a freeze`,
    );
  }

  // The point of the freeze: prove the canonical human decisions were not
  // rewritten after they were frozen.
  const lines = context.decisionLines;
  if (lines !== undefined) {
    for (const record of records) {
      const line = lines.get(record.sourceQueueId);
      if (line === undefined) {
        collector.error(
          'FRZ050',
          `freeze.records.${record.sourceQueueId}`,
          `frozen source ${record.sourceQueueId} no longer has a canonical decision`,
        );
        continue;
      }
      if (!checksumsEqual(record.decisionChecksum, checksumOf(line))) {
        collector.error(
          'FRZ051',
          `freeze.records.${record.sourceQueueId}.decisionChecksum`,
          `the canonical human decision for ${record.sourceQueueId} changed after the freeze; frozen Gold is immutable and human decisions are never rewritten`,
        );
      }
    }
  }

  return collector.result();
}
