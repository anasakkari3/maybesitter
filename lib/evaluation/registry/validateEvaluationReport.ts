import { EVALUATION_REPORT_CONTRACT_VERSION } from './contracts';
import type {
  DatasetRegistry,
  EvaluationReport,
  LockedArtifactLedger,
  ValidationResult,
} from './contracts';
import { findArtifact } from './validateRegistry';
import {
  IssueCollector,
  checksumsEqual,
  isIsoTimestamp,
  isNonEmptyString,
  isPlainObject,
  isSemver,
  isSlug,
  isValidChecksum,
} from './validationPrimitives';

const SUPPORTED_CONTRACT_MAJOR = EVALUATION_REPORT_CONTRACT_VERSION.split('.')[0];

export interface EvaluationReportContext {
  registry?: DatasetRegistry;
  ledger?: LockedArtifactLedger;
}

function validateModelFingerprint(collector: IssueCollector, value: unknown): void {
  if (!isPlainObject(value)) {
    collector.error('EVR020', 'report.model', 'model fingerprint is required');
    return;
  }

  if (!isNonEmptyString(value.id)) {
    collector.error('EVR021', 'report.model.id', 'model id is required');
  }
  if (!isNonEmptyString(value.runtime)) {
    collector.error('EVR022', 'report.model.runtime', 'model runtime is required (for example mlx or ollama)');
  }
  if (!isValidChecksum(value.checksum)) {
    collector.error('EVR023', 'report.model.checksum', 'model checksum is required');
  }
  if (!isValidChecksum(value.promptChecksum)) {
    collector.error(
      'EVR024',
      'report.model.promptChecksum',
      'prompt checksum is required; the prompt is part of the evaluated system',
    );
  }

  if (value.adapter === undefined) {
    collector.error('EVR025', 'report.model.adapter', 'adapter must be stated explicitly, or null when none was used');
    return;
  }
  if (value.adapter === null) return;

  if (!isPlainObject(value.adapter)) {
    collector.error('EVR026', 'report.model.adapter', 'adapter must be an object or null');
    return;
  }
  if (!isNonEmptyString(value.adapter.id)) {
    collector.error('EVR027', 'report.model.adapter.id', 'adapter id is required');
  }
  if (!isValidChecksum(value.adapter.checksum)) {
    collector.error('EVR028', 'report.model.adapter.checksum', 'adapter checksum is required');
  }
}

function validateConfigFingerprint(collector: IssueCollector, value: unknown): void {
  if (!isPlainObject(value)) {
    collector.error('EVR030', 'report.config', 'config fingerprint is required');
    return;
  }

  if (!isValidChecksum(value.checksum)) {
    collector.error('EVR031', 'report.config.checksum', 'config checksum is required');
  }
  if (!Number.isInteger(value.seed)) {
    collector.error(
      'EVR032',
      'report.config.seed',
      'seed must be an integer; an unseeded run is not reproducible and cannot back a gate',
    );
  }
  if (!Number.isInteger(value.maxTokens) || (value.maxTokens as number) <= 0) {
    collector.error('EVR033', 'report.config.maxTokens', 'maxTokens must be a positive integer');
  }
  if (typeof value.repairEnabled !== 'boolean') {
    collector.error('EVR034', 'report.config.repairEnabled', 'repairEnabled must be stated explicitly');
  }
  if (value.limit !== null && (!Number.isInteger(value.limit) || (value.limit as number) < 0)) {
    collector.error('EVR035', 'report.config.limit', 'limit must be a non-negative integer or null');
  }
  if (!isPlainObject(value.decoding)) {
    collector.error('EVR036', 'report.config.decoding', 'decoding parameters must be recorded, even if empty');
  }
}

function validateMetrics(collector: IssueCollector, path: string, value: unknown): void {
  if (!isPlainObject(value)) {
    collector.error('EVR040', path, 'metrics must be an object');
    return;
  }

  for (const [key, metric] of Object.entries(value)) {
    if (metric === null) continue;
    if (typeof metric !== 'number' || !Number.isFinite(metric)) {
      collector.error(
        'EVR041',
        `${path}.${key}`,
        'metric values must be finite numbers or null; null means "not measured"',
      );
    }
  }
}

/**
 * Validates an evaluation report and, when a registry is supplied, binds it to
 * the registered artifact it claims to have evaluated. A report whose dataset
 * checksum does not match the registry was produced against different bytes
 * than the ones under governance, so it cannot be used as gate evidence.
 */
export function validateEvaluationReport(
  value: unknown,
  context: EvaluationReportContext = {},
): ValidationResult {
  const collector = new IssueCollector();

  if (!isPlainObject(value)) {
    collector.error('EVR001', 'report', 'report must be an object');
    return collector.result();
  }

  if (!isSemver(value.contractVersion)) {
    collector.error('EVR002', 'report.contractVersion', 'contractVersion must be semver');
  } else if (String(value.contractVersion).split('.')[0] !== SUPPORTED_CONTRACT_MAJOR) {
    collector.error(
      'EVR003',
      'report.contractVersion',
      `unsupported contract major version ${String(value.contractVersion)}; this build understands ${EVALUATION_REPORT_CONTRACT_VERSION}`,
    );
  }
  if (!isNonEmptyString(value.reportId)) {
    collector.error('EVR004', 'report.reportId', 'reportId is required');
  }
  if (!isIsoTimestamp(value.createdAt)) {
    collector.error('EVR005', 'report.createdAt', 'createdAt must be an ISO timestamp');
  }

  const dataset = value.dataset;
  if (!isPlainObject(dataset)) {
    collector.error('EVR010', 'report.dataset', 'evaluated dataset reference is required');
  } else {
    if (!isSlug(dataset.datasetId)) {
      collector.error('EVR011', 'report.dataset.datasetId', 'datasetId must be a registered dataset id');
    }
    if (!isSemver(dataset.datasetVersion)) {
      collector.error('EVR012', 'report.dataset.datasetVersion', 'datasetVersion must be semver');
    }
    if (!isSlug(dataset.artifactId)) {
      collector.error('EVR013', 'report.dataset.artifactId', 'artifactId must be a registered artifact id');
    }
    if (!isValidChecksum(dataset.checksum)) {
      collector.error('EVR014', 'report.dataset.checksum', 'evaluated dataset checksum is required');
    }
  }

  validateModelFingerprint(collector, value.model);
  validateConfigFingerprint(collector, value.config);
  validateMetrics(collector, 'report.metrics', value.metrics);

  if (value.contractSnapshot === undefined) {
    collector.error(
      'EVR070',
      'report.contractSnapshot',
      'contractSnapshot must be stated explicitly, or null when the run was not scored against a snapshot',
    );
  } else if (value.contractSnapshot !== null) {
    if (!isPlainObject(value.contractSnapshot)) {
      collector.error('EVR071', 'report.contractSnapshot', 'contractSnapshot must be an object or null');
    } else {
      if (!isSlug(value.contractSnapshot.artifactId)) {
        collector.error(
          'EVR072',
          'report.contractSnapshot.artifactId',
          'contractSnapshot.artifactId must be a registered artifact id',
        );
      }
      if (!isValidChecksum(value.contractSnapshot.checksum)) {
        collector.error('EVR073', 'report.contractSnapshot.checksum', 'contractSnapshot checksum is required');
      }
    }
  }

  if (value.slices !== undefined) {
    if (!isPlainObject(value.slices)) {
      collector.error('EVR042', 'report.slices', 'slices must be an object of metric groups');
    } else {
      for (const [sliceName, sliceMetrics] of Object.entries(value.slices)) {
        validateMetrics(collector, `report.slices.${sliceName}`, sliceMetrics);
      }
    }
  }

  const registry = context.registry;
  if (registry === undefined || !isPlainObject(dataset)) {
    return collector.result();
  }

  const found = findArtifact(registry, String(dataset.artifactId));
  if (found === null) {
    collector.error(
      'EVR050',
      'report.dataset.artifactId',
      `artifact ${String(dataset.artifactId)} is not registered; evaluations must run against registered artifacts`,
    );
    return collector.result();
  }

  if (found.entry.id !== dataset.datasetId) {
    collector.error(
      'EVR051',
      'report.dataset.datasetId',
      `artifact ${found.artifact.id} belongs to dataset ${found.entry.id}, not ${String(dataset.datasetId)}`,
    );
  }
  if (found.entry.version !== dataset.datasetVersion) {
    collector.error(
      'EVR052',
      'report.dataset.datasetVersion',
      `report evaluated dataset version ${String(dataset.datasetVersion)}, registry declares ${found.entry.version}`,
    );
  }
  if (isValidChecksum(dataset.checksum) && !checksumsEqual(found.artifact.checksum, dataset.checksum)) {
    collector.error(
      'EVR053',
      'report.dataset.checksum',
      `report evaluated ${dataset.checksum.value} but the registry declares ${found.artifact.checksum.value} for ${found.artifact.id}; the report describes different bytes than the governed artifact`,
    );
  }

  if (isPlainObject(value.contractSnapshot)) {
    const snapshot = findArtifact(registry, String(value.contractSnapshot.artifactId));
    if (snapshot === null) {
      collector.error(
        'EVR074',
        'report.contractSnapshot.artifactId',
        `contract snapshot ${String(value.contractSnapshot.artifactId)} is not registered`,
      );
    } else {
      if (snapshot.artifact.role !== 'schema_snapshot') {
        collector.error(
          'EVR075',
          'report.contractSnapshot.artifactId',
          `artifact ${snapshot.artifact.id} has role ${snapshot.artifact.role}, not schema_snapshot`,
        );
      }
      if (
        isValidChecksum(value.contractSnapshot.checksum) &&
        !checksumsEqual(snapshot.artifact.checksum, value.contractSnapshot.checksum)
      ) {
        collector.error(
          'EVR076',
          'report.contractSnapshot.checksum',
          `report was scored against snapshot ${value.contractSnapshot.checksum.value} but the registry declares ${snapshot.artifact.checksum.value}`,
        );
      }
    }
  }

  if (found.artifact.role === 'test') {
    if (found.artifact.mutability !== 'locked') {
      collector.error(
        'EVR060',
        'report.dataset.artifactId',
        `test artifact ${found.artifact.id} is not locked, so this report cannot back a release gate`,
      );
    }

    const ledger = context.ledger;
    if (ledger !== undefined) {
      const record = ledger.records.find(
        (candidate) => candidate.artifactId === found.artifact.id && candidate.state === 'active',
      );
      if (record === undefined) {
        collector.error(
          'EVR061',
          'report.dataset.artifactId',
          `test artifact ${found.artifact.id} has no active lock record`,
        );
      } else if (isValidChecksum(dataset.checksum) && !checksumsEqual(record.checksum, dataset.checksum)) {
        collector.error(
          'EVR062',
          'report.dataset.checksum',
          `report evaluated ${dataset.checksum.value} but the lock ledger recorded ${record.checksum.value} for ${found.artifact.id}`,
        );
      }
    }
  }

  return collector.result();
}

export function parseEvaluationReport(
  value: unknown,
  context: EvaluationReportContext = {},
): { report: EvaluationReport | null; result: ValidationResult } {
  const result = validateEvaluationReport(value, context);
  return { report: result.valid ? (value as EvaluationReport) : null, result };
}
