import {
  ARTIFACT_ROLES,
  CONSENT_BASES,
  DATASET_PURPOSES,
  DATASET_REGISTRY_CONTRACT_VERSION,
  EVALUATION_STATUSES,
  MEDIA_TYPES,
  MUTABILITIES,
  PERSONAL_DATA_HANDLINGS,
  REDISTRIBUTION_POLICIES,
  SPLIT_ROLES,
} from './contracts';
import type {
  ArtifactRole,
  DatasetArtifact,
  DatasetEntry,
  DatasetRegistry,
  SplitRole,
  ValidationResult,
} from './contracts';
import {
  IssueCollector,
  isIsoTimestamp,
  isNonEmptyString,
  isPlainObject,
  isRelativePath,
  isSemver,
  isSlug,
  isValidChecksum,
} from './validationPrimitives';

const SUPPORTED_CONTRACT_MAJOR = DATASET_REGISTRY_CONTRACT_VERSION.split('.')[0];

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function locationKey(artifact: DatasetArtifact): string {
  return `${artifact.location.repository}@${artifact.location.revision}:${artifact.location.path}`;
}

function validateConsent(collector: IssueCollector, path: string, value: unknown): void {
  if (!isPlainObject(value)) {
    collector.error('SRC010', path, 'consent record is missing or not an object');
    return;
  }

  if (!includes(CONSENT_BASES, value.basis)) {
    collector.error('SRC011', `${path}.basis`, `unknown consent basis ${String(value.basis)}`);
  }
  if (typeof value.containsPersonalData !== 'boolean') {
    collector.error('SRC012', `${path}.containsPersonalData`, 'containsPersonalData must be a boolean');
  }
  if (!includes(PERSONAL_DATA_HANDLINGS, value.personalDataHandling)) {
    collector.error(
      'SRC013',
      `${path}.personalDataHandling`,
      `unknown personal data handling ${String(value.personalDataHandling)}`,
    );
  }
  if (!includes(REDISTRIBUTION_POLICIES, value.redistribution)) {
    collector.error(
      'SRC014',
      `${path}.redistribution`,
      `unknown redistribution policy ${String(value.redistribution)}`,
    );
  }
  if (!isNonEmptyString(value.reviewedBy)) {
    collector.error('SRC015', `${path}.reviewedBy`, 'consent must name the reviewer');
  }
  if (!isIsoTimestamp(value.reviewedAt)) {
    collector.error('SRC016', `${path}.reviewedAt`, 'consent must carry an ISO review timestamp');
  }

  if (value.containsPersonalData === true) {
    if (value.personalDataHandling === 'raw') {
      collector.error(
        'SRC020',
        `${path}.personalDataHandling`,
        'personal data may not be registered in raw form; anonymize or pseudonymize before registration',
      );
    }
    if (value.personalDataHandling === 'none') {
      collector.error(
        'SRC021',
        `${path}.personalDataHandling`,
        'containsPersonalData is true, so a handling other than "none" is required',
      );
    }
    if (value.redistribution === 'allowed_with_attribution') {
      collector.error(
        'SRC022',
        `${path}.redistribution`,
        'sources containing personal data may not be marked freely redistributable',
      );
    }
  }

  if (
    value.basis === 'user_consented_anonymized' &&
    value.personalDataHandling !== 'anonymized' &&
    value.personalDataHandling !== 'pseudonymized'
  ) {
    collector.error(
      'SRC023',
      `${path}.personalDataHandling`,
      'user-consented data must be anonymized or pseudonymized',
    );
  }
}

function validateSources(collector: IssueCollector, entryPath: string, entry: Record<string, unknown>): void {
  const sources = entry.sources;
  if (!Array.isArray(sources) || sources.length === 0) {
    collector.error('SRC001', `${entryPath}.sources`, 'every dataset must declare at least one source');
    return;
  }

  sources.forEach((source, index) => {
    const path = `${entryPath}.sources[${index}]`;
    if (!isPlainObject(source)) {
      collector.error('SRC002', path, 'source must be an object');
      return;
    }
    if (!isNonEmptyString(source.name)) {
      collector.error('SRC003', `${path}.name`, 'source name is required');
    }
    if (!isNonEmptyString(source.url)) {
      collector.error('SRC004', `${path}.url`, 'source url or local generator path is required');
    }
    if (!isNonEmptyString(source.revision)) {
      collector.error('SRC005', `${path}.revision`, 'source revision, tag, or generator identity is required');
    }
    if (!isNonEmptyString(source.license)) {
      collector.error('SRC006', `${path}.license`, 'source license is required');
    }
    if (
      source.declaredRecordCount !== null &&
      (typeof source.declaredRecordCount !== 'number' ||
        !Number.isInteger(source.declaredRecordCount) ||
        source.declaredRecordCount < 0)
    ) {
      collector.error(
        'SRC007',
        `${path}.declaredRecordCount`,
        'declaredRecordCount must be a non-negative integer or null',
      );
    }
    validateConsent(collector, `${path}.consent`, source.consent);
  });
}

function validateArtifact(
  collector: IssueCollector,
  path: string,
  artifact: unknown,
): DatasetArtifact | null {
  if (!isPlainObject(artifact)) {
    collector.error('ART001', path, 'artifact must be an object');
    return null;
  }

  let structurallyValid = true;

  if (!isSlug(artifact.id)) {
    collector.error('ART002', `${path}.id`, 'artifact id must be a kebab-case slug');
    structurallyValid = false;
  }
  if (!includes(ARTIFACT_ROLES, artifact.role)) {
    collector.error('ART003', `${path}.role`, `unknown artifact role ${String(artifact.role)}`);
    structurallyValid = false;
  }
  if (!includes(MEDIA_TYPES, artifact.mediaType)) {
    collector.error('ART004', `${path}.mediaType`, `unknown media type ${String(artifact.mediaType)}`);
  }
  if (!includes(MUTABILITIES, artifact.mutability)) {
    collector.error('ART005', `${path}.mutability`, `unknown mutability ${String(artifact.mutability)}`);
    structurallyValid = false;
  }
  if (!isValidChecksum(artifact.checksum)) {
    collector.error('ART006', `${path}.checksum`, 'checksum must be {algorithm:"sha256", value:<64 hex chars>}');
    structurallyValid = false;
  }
  if (typeof artifact.materialized !== 'boolean') {
    collector.error('ART007', `${path}.materialized`, 'materialized must be a boolean');
  }
  if (
    artifact.recordCount !== null &&
    (typeof artifact.recordCount !== 'number' ||
      !Number.isInteger(artifact.recordCount) ||
      artifact.recordCount < 0)
  ) {
    collector.error('ART008', `${path}.recordCount`, 'recordCount must be a non-negative integer or null');
  }
  if (
    artifact.byteSize !== null &&
    (typeof artifact.byteSize !== 'number' || !Number.isInteger(artifact.byteSize) || artifact.byteSize < 0)
  ) {
    collector.error('ART009', `${path}.byteSize`, 'byteSize must be a non-negative integer or null');
  }

  const location = artifact.location;
  if (!isPlainObject(location)) {
    collector.error('ART010', `${path}.location`, 'artifact location is required');
    structurallyValid = false;
  } else {
    if (!isNonEmptyString(location.repository)) {
      collector.error('ART011', `${path}.location.repository`, 'owning repository is required');
      structurallyValid = false;
    }
    if (!isNonEmptyString(location.revision)) {
      collector.error('ART012', `${path}.location.revision`, 'observed revision is required');
      structurallyValid = false;
    }
    if (!isRelativePath(location.path)) {
      collector.error(
        'ART013',
        `${path}.location.path`,
        'path must be repository-relative and must not escape the repository root',
      );
      structurallyValid = false;
    }
  }

  return structurallyValid ? (artifact as unknown as DatasetArtifact) : null;
}

function validateLineage(collector: IssueCollector, entryPath: string, entry: Record<string, unknown>): void {
  const lineage = entry.lineage;
  if (!isPlainObject(lineage)) {
    collector.error('LIN001', `${entryPath}.lineage`, 'lineage is required');
    return;
  }

  if (!Array.isArray(lineage.derivedFrom)) {
    collector.error('LIN002', `${entryPath}.lineage.derivedFrom`, 'derivedFrom must be an array');
  } else if (lineage.derivedFrom.some((value) => !isNonEmptyString(value))) {
    collector.error(
      'LIN003',
      `${entryPath}.lineage.derivedFrom`,
      'derivedFrom entries must be dataset ids or "source:<name>" references',
    );
  }

  const producedBy = lineage.producedBy;
  if (!isPlainObject(producedBy)) {
    collector.error('LIN004', `${entryPath}.lineage.producedBy`, 'producedBy is required');
    return;
  }
  if (!isNonEmptyString(producedBy.script)) {
    collector.error('LIN005', `${entryPath}.lineage.producedBy.script`, 'producing script is required');
  }
  if (!isNonEmptyString(producedBy.version)) {
    collector.error('LIN006', `${entryPath}.lineage.producedBy.version`, 'producing script version is required');
  }
  if (producedBy.seed !== null && !Number.isInteger(producedBy.seed)) {
    collector.error('LIN007', `${entryPath}.lineage.producedBy.seed`, 'seed must be an integer or null');
  }
}

function validateEntryShape(
  collector: IssueCollector,
  path: string,
  entry: unknown,
): DatasetEntry | null {
  if (!isPlainObject(entry)) {
    collector.error('DS001', path, 'dataset entry must be an object');
    return null;
  }

  let structurallyValid = true;

  if (!isSlug(entry.id)) {
    collector.error('DS002', `${path}.id`, 'dataset id must be a kebab-case slug');
    structurallyValid = false;
  }
  if (!isNonEmptyString(entry.title)) {
    collector.error('DS003', `${path}.title`, 'dataset title is required');
  }
  if (!isSemver(entry.version)) {
    collector.error('DS004', `${path}.version`, 'dataset version must be semver');
  }
  if (!includes(DATASET_PURPOSES, entry.purpose)) {
    collector.error('DS005', `${path}.purpose`, `unknown dataset purpose ${String(entry.purpose)}`);
    structurallyValid = false;
  }
  if (!includes(EVALUATION_STATUSES, entry.status)) {
    collector.error('DS006', `${path}.status`, `unknown evaluation status ${String(entry.status)}`);
    structurallyValid = false;
  }
  if (!isNonEmptyString(entry.owner)) {
    collector.error('DS007', `${path}.owner`, 'dataset owner track is required');
  }
  if (entry.card !== null && !isRelativePath(entry.card)) {
    collector.error('DS008', `${path}.card`, 'card must be a repository-relative path or null');
  }
  if (entry.supersededBy !== null && !isSlug(entry.supersededBy)) {
    collector.error('DS009', `${path}.supersededBy`, 'supersededBy must be a dataset id or null');
  }
  if (entry.gates !== undefined && (!Array.isArray(entry.gates) || entry.gates.some((g) => !isNonEmptyString(g)))) {
    collector.error('DS010', `${path}.gates`, 'gates must be an array of non-empty references');
  }

  validateSources(collector, path, entry);
  validateLineage(collector, path, entry);

  if (!Array.isArray(entry.artifacts) || entry.artifacts.length === 0) {
    collector.error('ART000', `${path}.artifacts`, 'every dataset must declare at least one artifact');
    structurallyValid = false;
  } else {
    entry.artifacts.forEach((artifact, index) => {
      if (validateArtifact(collector, `${path}.artifacts[${index}]`, artifact) === null) {
        structurallyValid = false;
      }
    });
  }

  return structurallyValid ? (entry as unknown as DatasetEntry) : null;
}

function validateSplitOwnership(collector: IssueCollector, path: string, entry: DatasetEntry): void {
  const byRole = new Map<SplitRole, DatasetArtifact[]>();
  for (const role of SPLIT_ROLES) {
    byRole.set(role, []);
  }
  for (const artifact of entry.artifacts) {
    const bucket = byRole.get(artifact.role as SplitRole);
    if (bucket) bucket.push(artifact);
  }

  for (const role of SPLIT_ROLES) {
    const artifacts = byRole.get(role) ?? [];
    if (artifacts.length > 1) {
      collector.error(
        'SPL001',
        `${path}.artifacts`,
        `role "${role}" is claimed by ${artifacts.length} artifacts; each split role must have exactly one owning artifact`,
      );
    }
  }

  if (entry.purpose === 'training') {
    for (const role of SPLIT_ROLES) {
      if ((byRole.get(role) ?? []).length === 0) {
        collector.error(
          'SPL002',
          `${path}.artifacts`,
          `training datasets must declare a "${role}" artifact so train/valid/test ownership is explicit`,
        );
      }
    }
  }

  const requiresLockedTest = entry.status === 'validated' || entry.status === 'frozen';

  for (const artifact of entry.artifacts) {
    if (artifact.role === 'test') {
      if (artifact.mutability === 'mutable') {
        collector.error(
          'SPL003',
          `${path}.artifacts.${artifact.id}`,
          'a test artifact may never be mutable; use append_only while it is being built and locked once it is final',
        );
      } else if (artifact.mutability !== 'locked') {
        if (requiresLockedTest) {
          collector.error(
            'SPL005',
            `${path}.artifacts.${artifact.id}`,
            `a ${entry.status} dataset must have a locked test artifact; an unlocked test split cannot back a release gate`,
          );
        } else {
          collector.warn(
            'SPL006',
            `${path}.artifacts.${artifact.id}`,
            'test artifact is not locked yet, so no evaluation against it can back a release gate',
          );
        }
      }
    }

    if ((artifact.role === 'train' || artifact.role === 'valid') && artifact.mutability === 'locked') {
      collector.warn(
        'SPL004',
        `${path}.artifacts.${artifact.id}`,
        'locking a train or valid artifact freezes the corpus; confirm this is intended',
      );
    }
  }
}

function validateStatusRules(collector: IssueCollector, path: string, entry: DatasetEntry): void {
  if (entry.status === 'retired') {
    if (entry.supersededBy === null) {
      collector.error('STA001', `${path}.supersededBy`, 'retired datasets must name their successor');
    }
  } else if (entry.supersededBy !== null) {
    collector.error(
      'STA002',
      `${path}.supersededBy`,
      'only retired datasets may declare supersededBy',
    );
  }

  if (entry.status === 'frozen') {
    const mutable = entry.artifacts.filter((artifact) => artifact.mutability === 'mutable');
    if (mutable.length > 0) {
      collector.error(
        'STA003',
        `${path}.artifacts`,
        `frozen datasets may not contain mutable artifacts (${mutable.map((a) => a.id).join(', ')})`,
      );
    }
  }

  if (entry.status === 'validated' || entry.status === 'frozen') {
    const unmaterialized = entry.artifacts.filter(
      (artifact) => !artifact.materialized && (SPLIT_ROLES as readonly ArtifactRole[]).includes(artifact.role),
    );
    if (unmaterialized.length > 0) {
      collector.error(
        'STA004',
        `${path}.artifacts`,
        `${entry.status} datasets must have materialized splits (${unmaterialized.map((a) => a.id).join(', ')})`,
      );
    }
  }
}

function validateCrossEntryRules(collector: IssueCollector, entries: readonly DatasetEntry[]): void {
  const seenDatasetIds = new Set<string>();
  const seenArtifactIds = new Map<string, string>();
  const seenLocations = new Map<string, string>();

  entries.forEach((entry, index) => {
    const path = `entries[${index}]`;
    if (seenDatasetIds.has(entry.id)) {
      collector.error('REG010', `${path}.id`, `duplicate dataset id ${entry.id}`);
    }
    seenDatasetIds.add(entry.id);

    for (const artifact of entry.artifacts) {
      const previousOwner = seenArtifactIds.get(artifact.id);
      if (previousOwner !== undefined) {
        collector.error(
          'ART020',
          `${path}.artifacts.${artifact.id}`,
          `artifact id ${artifact.id} is already declared by dataset ${previousOwner}`,
        );
      } else {
        seenArtifactIds.set(artifact.id, entry.id);
      }

      const key = locationKey(artifact);
      const previousClaim = seenLocations.get(key);
      if (previousClaim !== undefined) {
        collector.error(
          'ART021',
          `${path}.artifacts.${artifact.id}`,
          `${key} is already owned by artifact ${previousClaim}; one file may not be owned by two artifacts`,
        );
      } else {
        seenLocations.set(key, artifact.id);
      }
    }
  });

  for (const entry of entries) {
    if (entry.supersededBy !== null && !seenDatasetIds.has(entry.supersededBy)) {
      collector.error(
        'STA005',
        `entries.${entry.id}.supersededBy`,
        `successor dataset ${entry.supersededBy} is not registered`,
      );
    }

    const sourceRefs = new Set(entry.sources.map((source) => `source:${source.name}`));
    for (const reference of entry.lineage.derivedFrom) {
      if (reference.startsWith('source:')) {
        if (!sourceRefs.has(reference)) {
          collector.error(
            'LIN010',
            `entries.${entry.id}.lineage.derivedFrom`,
            `${reference} is not declared in this dataset's sources`,
          );
        }
      } else if (!seenDatasetIds.has(reference)) {
        collector.error(
          'LIN011',
          `entries.${entry.id}.lineage.derivedFrom`,
          `${reference} is not a registered dataset id`,
        );
      } else if (reference === entry.id) {
        collector.error(
          'LIN012',
          `entries.${entry.id}.lineage.derivedFrom`,
          'a dataset may not be derived from itself',
        );
      }
    }
  }

  detectLineageCycles(collector, entries);
}

function detectLineageCycles(collector: IssueCollector, entries: readonly DatasetEntry[]): void {
  const parents = new Map<string, readonly string[]>();
  for (const entry of entries) {
    parents.set(
      entry.id,
      entry.lineage.derivedFrom.filter((reference) => !reference.startsWith('source:')),
    );
  }

  const state = new Map<string, 'visiting' | 'done'>();
  const reported = new Set<string>();

  const visit = (id: string, trail: readonly string[]): void => {
    const current = state.get(id);
    if (current === 'done') return;
    if (current === 'visiting') {
      const cycle = [...trail.slice(trail.indexOf(id)), id].join(' -> ');
      if (!reported.has(cycle)) {
        reported.add(cycle);
        collector.error('LIN013', `entries.${id}.lineage.derivedFrom`, `lineage cycle detected: ${cycle}`);
      }
      return;
    }

    state.set(id, 'visiting');
    for (const parent of parents.get(id) ?? []) {
      if (parents.has(parent)) {
        visit(parent, [...trail, id]);
      }
    }
    state.set(id, 'done');
  };

  for (const entry of entries) {
    visit(entry.id, []);
  }
}

export function validateDatasetRegistry(value: unknown): ValidationResult {
  const collector = new IssueCollector();

  if (!isPlainObject(value)) {
    collector.error('REG001', 'registry', 'registry must be an object');
    return collector.result();
  }

  if (!isSemver(value.contractVersion)) {
    collector.error('REG002', 'registry.contractVersion', 'contractVersion must be semver');
  } else if (String(value.contractVersion).split('.')[0] !== SUPPORTED_CONTRACT_MAJOR) {
    collector.error(
      'REG003',
      'registry.contractVersion',
      `unsupported contract major version ${String(value.contractVersion)}; this build understands ${DATASET_REGISTRY_CONTRACT_VERSION}`,
    );
  }
  if (!isSemver(value.registryVersion)) {
    collector.error('REG004', 'registry.registryVersion', 'registryVersion must be semver');
  }
  if (!isIsoTimestamp(value.generatedAt)) {
    collector.error('REG005', 'registry.generatedAt', 'generatedAt must be an ISO timestamp');
  }

  if (!Array.isArray(value.entries)) {
    collector.error('REG006', 'registry.entries', 'entries must be an array');
    return collector.result();
  }

  const parsedEntries: DatasetEntry[] = [];
  value.entries.forEach((entry, index) => {
    const parsed = validateEntryShape(collector, `entries[${index}]`, entry);
    if (parsed !== null) {
      parsedEntries.push(parsed);
      validateSplitOwnership(collector, `entries[${index}]`, parsed);
      validateStatusRules(collector, `entries[${index}]`, parsed);
    }
  });

  validateCrossEntryRules(collector, parsedEntries);

  return collector.result();
}

/**
 * Returns the registry only when it validates. Callers that need a typed
 * registry should use this rather than casting parsed JSON.
 */
export function parseDatasetRegistry(value: unknown): {
  registry: DatasetRegistry | null;
  result: ValidationResult;
} {
  const result = validateDatasetRegistry(value);
  return { registry: result.valid ? (value as DatasetRegistry) : null, result };
}

export function findArtifact(
  registry: DatasetRegistry,
  artifactId: string,
): { entry: DatasetEntry; artifact: DatasetArtifact } | null {
  for (const entry of registry.entries) {
    for (const artifact of entry.artifacts) {
      if (artifact.id === artifactId) return { entry, artifact };
    }
  }
  return null;
}

export function lockedArtifacts(
  registry: DatasetRegistry,
): readonly { entry: DatasetEntry; artifact: DatasetArtifact }[] {
  const found: { entry: DatasetEntry; artifact: DatasetArtifact }[] = [];
  for (const entry of registry.entries) {
    for (const artifact of entry.artifacts) {
      if (artifact.mutability === 'locked') found.push({ entry, artifact });
    }
  }
  return found;
}
