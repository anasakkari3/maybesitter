import { LOCKED_ARTIFACT_LEDGER_CONTRACT_VERSION, LOCK_STATES } from './contracts';
import type {
  DatasetRegistry,
  LockedArtifactLedger,
  LockedArtifactRecord,
  ValidationResult,
} from './contracts';
import { computeChain } from './lockChain';
import { findArtifact, lockedArtifacts } from './validateRegistry';
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

const SUPPORTED_CONTRACT_MAJOR = LOCKED_ARTIFACT_LEDGER_CONTRACT_VERSION.split('.')[0];

function validateRecordShape(
  collector: IssueCollector,
  path: string,
  record: unknown,
): LockedArtifactRecord | null {
  if (!isPlainObject(record)) {
    collector.error('LCK010', path, 'ledger record must be an object');
    return null;
  }

  let structurallyValid = true;

  if (!isSlug(record.artifactId)) {
    collector.error('LCK011', `${path}.artifactId`, 'artifactId must be a kebab-case slug');
    structurallyValid = false;
  }
  if (!isSlug(record.datasetId)) {
    collector.error('LCK012', `${path}.datasetId`, 'datasetId must be a kebab-case slug');
    structurallyValid = false;
  }
  if (!isValidChecksum(record.checksum)) {
    collector.error('LCK013', `${path}.checksum`, 'checksum must be {algorithm:"sha256", value:<64 hex chars>}');
    structurallyValid = false;
  }
  if (
    record.recordCount !== null &&
    (typeof record.recordCount !== 'number' || !Number.isInteger(record.recordCount) || record.recordCount < 0)
  ) {
    collector.error('LCK014', `${path}.recordCount`, 'recordCount must be a non-negative integer or null');
  }
  if (!isIsoTimestamp(record.lockedAt)) {
    collector.error('LCK015', `${path}.lockedAt`, 'lockedAt must be an ISO timestamp');
  }
  if (!isNonEmptyString(record.lockedBy)) {
    collector.error('LCK016', `${path}.lockedBy`, 'lockedBy is required');
  }
  if (!isNonEmptyString(record.authorizingIssue)) {
    collector.error(
      'LCK017',
      `${path}.authorizingIssue`,
      'a lock must reference the issue or gate that authorized it',
    );
  }
  if (typeof record.state !== 'string' || !(LOCK_STATES as readonly string[]).includes(record.state)) {
    collector.error('LCK018', `${path}.state`, `unknown lock state ${String(record.state)}`);
    structurallyValid = false;
  }
  if (!isValidChecksum(record.chainChecksum)) {
    collector.error('LCK019', `${path}.chainChecksum`, 'chainChecksum must be {algorithm:"sha256", value:<64 hex chars>}');
    structurallyValid = false;
  }

  return structurallyValid ? (record as unknown as LockedArtifactRecord) : null;
}

function validateChain(collector: IssueCollector, records: readonly LockedArtifactRecord[]): void {
  const expected = computeChain(records);

  for (let index = 0; index < records.length; index += 1) {
    if (!checksumsEqual(records[index].chainChecksum, expected[index])) {
      collector.error(
        'LCK060',
        `records[${index}].chainChecksum`,
        `ledger chain is broken at ${records[index].artifactId}: expected ${expected[index].value}, found ${records[index].chainChecksum.value}. A row was edited or removed; the ledger is append-only.`,
      );
      return;
    }
  }
}

function validateSupersessionProcedure(
  collector: IssueCollector,
  path: string,
  record: LockedArtifactRecord,
  byArtifactId: ReadonlyMap<string, readonly LockedArtifactRecord[]>,
): void {
  if (record.state === 'active') {
    if (record.supersededBy !== null || record.supersessionIssue !== null || record.supersessionReason !== null) {
      collector.error(
        'LCK020',
        path,
        'an active lock may not carry supersession fields; set state to "superseded" instead',
      );
    }
    return;
  }

  if (!isNonEmptyString(record.supersededBy)) {
    collector.error(
      'LCK021',
      `${path}.supersededBy`,
      'a superseded lock must name the artifact id that replaced it',
    );
  } else if (!byArtifactId.has(record.supersededBy)) {
    collector.error(
      'LCK022',
      `${path}.supersededBy`,
      `successor artifact ${record.supersededBy} has no ledger record`,
    );
  } else if (record.supersededBy === record.artifactId) {
    collector.error(
      'LCK023',
      `${path}.supersededBy`,
      'a locked artifact may not supersede itself; supersession requires a new artifact id',
    );
  }

  if (!isNonEmptyString(record.supersessionIssue)) {
    collector.error(
      'LCK024',
      `${path}.supersessionIssue`,
      'supersession must reference the issue or gate that approved the change',
    );
  }
  if (!isNonEmptyString(record.supersessionReason)) {
    collector.error('LCK025', `${path}.supersessionReason`, 'supersession must record why the lock was replaced');
  }
}

/**
 * Validates the append-only lock ledger on its own, and — when a registry is
 * supplied — cross-checks it against the registry. The cross-check is what
 * makes an edited locked artifact fail: changing a locked artifact's bytes
 * changes its registry checksum, which then disagrees with the active ledger
 * row that recorded the lock.
 */
export function validateLockedArtifactLedger(
  value: unknown,
  registry?: DatasetRegistry,
): ValidationResult {
  const collector = new IssueCollector();

  if (!isPlainObject(value)) {
    collector.error('LCK001', 'ledger', 'ledger must be an object');
    return collector.result();
  }

  if (!isSemver(value.contractVersion)) {
    collector.error('LCK002', 'ledger.contractVersion', 'contractVersion must be semver');
  } else if (String(value.contractVersion).split('.')[0] !== SUPPORTED_CONTRACT_MAJOR) {
    collector.error(
      'LCK003',
      'ledger.contractVersion',
      `unsupported contract major version ${String(value.contractVersion)}; this build understands ${LOCKED_ARTIFACT_LEDGER_CONTRACT_VERSION}`,
    );
  }

  if (!Array.isArray(value.records)) {
    collector.error('LCK004', 'ledger.records', 'records must be an array');
    return collector.result();
  }

  const records: LockedArtifactRecord[] = [];
  value.records.forEach((record, index) => {
    const parsed = validateRecordShape(collector, `records[${index}]`, record);
    if (parsed !== null) records.push(parsed);
  });

  const byArtifactId = new Map<string, LockedArtifactRecord[]>();
  for (const record of records) {
    const bucket = byArtifactId.get(record.artifactId);
    if (bucket) bucket.push(record);
    else byArtifactId.set(record.artifactId, [record]);
  }

  byArtifactId.forEach((bucket, artifactId) => {
    if (bucket.length > 1) {
      collector.error(
        'LCK030',
        `records.${artifactId}`,
        `artifact ${artifactId} has ${bucket.length} ledger rows; the ledger is append-only and one artifact id may be locked once`,
      );
    }
  });

  records.forEach((record, index) => {
    validateSupersessionProcedure(collector, `records[${index}]`, record, byArtifactId);
  });

  if (records.length === value.records.length) {
    validateChain(collector, records);
  }

  if (registry === undefined) {
    return collector.result();
  }

  const activeRecords = records.filter((record) => record.state === 'active');

  for (const record of activeRecords) {
    const found = findArtifact(registry, record.artifactId);
    if (found === null) {
      collector.error(
        'LCK040',
        `records.${record.artifactId}`,
        `active lock references artifact ${record.artifactId}, which is not in the registry`,
      );
      continue;
    }

    if (found.entry.id !== record.datasetId) {
      collector.error(
        'LCK041',
        `records.${record.artifactId}.datasetId`,
        `ledger says artifact ${record.artifactId} belongs to ${record.datasetId}, registry says ${found.entry.id}`,
      );
    }

    if (found.artifact.mutability !== 'locked') {
      collector.error(
        'LCK042',
        `records.${record.artifactId}`,
        `artifact ${record.artifactId} has an active lock but is registered as ${found.artifact.mutability}`,
      );
    }

    if (!checksumsEqual(found.artifact.checksum, record.checksum)) {
      collector.error(
        'LCK043',
        `records.${record.artifactId}.checksum`,
        `locked artifact ${record.artifactId} changed: ledger recorded ${record.checksum.value}, registry now declares ${found.artifact.checksum.value}. A locked artifact is immutable — supersede it with a new artifact id instead of editing it.`,
      );
    }

    if (record.recordCount !== null && found.artifact.recordCount !== record.recordCount) {
      collector.error(
        'LCK044',
        `records.${record.artifactId}.recordCount`,
        `locked artifact ${record.artifactId} changed size: ledger recorded ${record.recordCount} records, registry now declares ${String(found.artifact.recordCount)}`,
      );
    }
  }

  const activeIds = new Set(activeRecords.map((record) => record.artifactId));
  for (const { entry, artifact } of lockedArtifacts(registry)) {
    if (!activeIds.has(artifact.id)) {
      collector.error(
        'LCK050',
        `registry.${entry.id}.artifacts.${artifact.id}`,
        `artifact ${artifact.id} is registered as locked but has no active ledger record`,
      );
    }
  }

  for (const record of records) {
    if (record.state !== 'superseded') continue;
    const found = findArtifact(registry, record.artifactId);
    if (found !== null && found.artifact.mutability === 'locked') {
      collector.error(
        'LCK051',
        `records.${record.artifactId}`,
        `artifact ${record.artifactId} is superseded in the ledger but still registered as an active locked artifact`,
      );
    }
  }

  return collector.result();
}

export function parseLockedArtifactLedger(
  value: unknown,
  registry?: DatasetRegistry,
): { ledger: LockedArtifactLedger | null; result: ValidationResult } {
  const result = validateLockedArtifactLedger(value, registry);
  return { ledger: result.valid ? (value as LockedArtifactLedger) : null, result };
}
