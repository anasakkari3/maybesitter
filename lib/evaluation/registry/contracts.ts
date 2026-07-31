export const DATASET_REGISTRY_CONTRACT_VERSION = '1.0.0';
export const LOCKED_ARTIFACT_LEDGER_CONTRACT_VERSION = '1.0.0';
export const EVALUATION_REPORT_CONTRACT_VERSION = '1.0.0';

export type ChecksumAlgorithm = 'sha256';

export interface Checksum {
  algorithm: ChecksumAlgorithm;
  value: string;
}

export type SplitRole = 'train' | 'valid' | 'test';

export type SupportRole =
  | 'review_queue'
  | 'annotation'
  | 'schema_snapshot'
  | 'training_config'
  | 'report'
  | 'benchmark'
  | 'provenance';

export type ArtifactRole = SplitRole | SupportRole;

export const SPLIT_ROLES: readonly SplitRole[] = ['train', 'valid', 'test'];

export const ARTIFACT_ROLES: readonly ArtifactRole[] = [
  'train',
  'valid',
  'test',
  'review_queue',
  'annotation',
  'schema_snapshot',
  'training_config',
  'report',
  'benchmark',
  'provenance',
];

export type Mutability = 'mutable' | 'append_only' | 'locked';

export const MUTABILITIES: readonly Mutability[] = ['mutable', 'append_only', 'locked'];

export type MediaType =
  | 'application/jsonl'
  | 'application/json'
  | 'application/yaml'
  | 'text/markdown';

export const MEDIA_TYPES: readonly MediaType[] = [
  'application/jsonl',
  'application/json',
  'application/yaml',
  'text/markdown',
];

/**
 * Artifacts do not live in this repository. They are produced in the Gemma
 * pipeline working copies, so an artifact is addressed by the repository that
 * owns it, the revision it was observed at, and the repository-relative path.
 */
export interface ArtifactLocation {
  repository: string;
  revision: string;
  path: string;
}

export interface DatasetArtifact {
  id: string;
  role: ArtifactRole;
  location: ArtifactLocation;
  mediaType: MediaType;
  /** Records in the artifact, or null when the artifact is not record-structured. */
  recordCount: number | null;
  byteSize: number | null;
  checksum: Checksum;
  mutability: Mutability;
  /** False when the registry declares an artifact that has not been built yet. */
  materialized: boolean;
  notes?: string;
}

export type ConsentBasis =
  | 'public_license'
  | 'project_owned_synthetic'
  | 'project_owned_authored'
  | 'user_consented_anonymized';

export const CONSENT_BASES: readonly ConsentBasis[] = [
  'public_license',
  'project_owned_synthetic',
  'project_owned_authored',
  'user_consented_anonymized',
];

export type PersonalDataHandling = 'none' | 'anonymized' | 'pseudonymized' | 'raw';

export const PERSONAL_DATA_HANDLINGS: readonly PersonalDataHandling[] = [
  'none',
  'anonymized',
  'pseudonymized',
  'raw',
];

export type RedistributionPolicy = 'allowed_with_attribution' | 'internal_only' | 'prohibited';

export const REDISTRIBUTION_POLICIES: readonly RedistributionPolicy[] = [
  'allowed_with_attribution',
  'internal_only',
  'prohibited',
];

export interface ConsentRecord {
  basis: ConsentBasis;
  containsPersonalData: boolean;
  personalDataHandling: PersonalDataHandling;
  redistribution: RedistributionPolicy;
  reviewedBy: string;
  reviewedAt: string;
  notes?: string;
}

export interface DatasetSource {
  name: string;
  url: string;
  /** Upstream revision, release tag, or generator seed identity. */
  revision: string;
  license: string;
  consent: ConsentRecord;
  declaredRecordCount: number | null;
}

export type DatasetPurpose =
  | 'training'
  | 'evaluation'
  | 'human_review'
  | 'calibration'
  | 'benchmark'
  | 'contract_snapshot';

export const DATASET_PURPOSES: readonly DatasetPurpose[] = [
  'training',
  'evaluation',
  'human_review',
  'calibration',
  'benchmark',
  'contract_snapshot',
];

export type EvaluationStatus =
  | 'draft'
  | 'in_review'
  | 'validated_partial'
  | 'validated'
  | 'frozen'
  | 'retired';

export const EVALUATION_STATUSES: readonly EvaluationStatus[] = [
  'draft',
  'in_review',
  'validated_partial',
  'validated',
  'frozen',
  'retired',
];

export interface DatasetProducer {
  script: string;
  version: string;
  /** Null only when the producing step is genuinely not seeded. */
  seed: number | null;
}

export interface DatasetLineage {
  /** Dataset ids in this registry, or `source:<source name>` for upstream roots. */
  derivedFrom: readonly string[];
  producedBy: DatasetProducer;
  transformationNotes?: string;
}

export interface DatasetEntry {
  id: string;
  title: string;
  version: string;
  purpose: DatasetPurpose;
  status: EvaluationStatus;
  /** Track accountable for writes to this dataset. */
  owner: string;
  sources: readonly DatasetSource[];
  lineage: DatasetLineage;
  artifacts: readonly DatasetArtifact[];
  /** Repository-relative path to the dataset card, when one exists. */
  card: string | null;
  supersededBy: string | null;
  /** Issue or gate references that authorize this dataset's current status. */
  gates?: readonly string[];
}

export interface DatasetRegistry {
  contractVersion: string;
  registryVersion: string;
  generatedAt: string;
  entries: readonly DatasetEntry[];
}

export type LockState = 'active' | 'superseded';

export const LOCK_STATES: readonly LockState[] = ['active', 'superseded'];

/**
 * One append-only ledger row per locked artifact. A locked artifact is never
 * edited in place: it is superseded by a new artifact id with its own row.
 */
export interface LockedArtifactRecord {
  artifactId: string;
  datasetId: string;
  checksum: Checksum;
  recordCount: number | null;
  lockedAt: string;
  lockedBy: string;
  authorizingIssue: string;
  state: LockState;
  supersededBy: string | null;
  supersessionIssue: string | null;
  supersessionReason: string | null;
  /** Commits to this row and every row before it. See lockChain.ts. */
  chainChecksum: Checksum;
}

export interface LockedArtifactLedger {
  contractVersion: string;
  records: readonly LockedArtifactRecord[];
}

export interface ModelFingerprint {
  id: string;
  runtime: string;
  /** Weight checksum when weights are co-located, otherwise the model build/config checksum. */
  checksum: Checksum;
  adapter: AdapterFingerprint | null;
  promptChecksum: Checksum;
}

export interface AdapterFingerprint {
  id: string;
  checksum: Checksum;
}

export interface ConfigFingerprint {
  /** Checksum over the canonical JSON form of the full evaluation config. */
  checksum: Checksum;
  seed: number;
  maxTokens: number;
  decoding: Readonly<Record<string, number | string | boolean | null>>;
  repairEnabled: boolean;
  limit: number | null;
}

export interface EvaluatedDatasetRef {
  datasetId: string;
  datasetVersion: string;
  artifactId: string;
  checksum: Checksum;
}

/** The output-contract snapshot the run was scored against. */
export interface ContractSnapshotRef {
  artifactId: string;
  checksum: Checksum;
}

export interface EvaluationReport {
  contractVersion: string;
  reportId: string;
  createdAt: string;
  dataset: EvaluatedDatasetRef;
  model: ModelFingerprint;
  config: ConfigFingerprint;
  contractSnapshot: ContractSnapshotRef | null;
  metrics: Readonly<Record<string, number | null>>;
  /** Optional per-slice metric groups, e.g. per language or per category. */
  slices?: Readonly<Record<string, Readonly<Record<string, number | null>>>>;
  notes?: string;
}

export type IssueSeverity = 'error' | 'warning';

export interface ValidationIssue {
  code: string;
  severity: IssueSeverity;
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: readonly ValidationIssue[];
}
