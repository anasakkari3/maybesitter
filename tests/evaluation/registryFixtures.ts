import type {
  Checksum,
  ConsentRecord,
  DatasetArtifact,
  DatasetEntry,
  DatasetRegistry,
  DatasetSource,
  EvaluationReport,
  LockedArtifactLedger,
  LockedArtifactRecord,
} from '../../lib/evaluation/registry/contracts.ts';
import { computeChain } from '../../lib/evaluation/registry/lockChain.ts';

export function checksum(seed: string): Checksum {
  const base = seed.replace(/[^0-9a-f]/g, '');
  return { algorithm: 'sha256', value: (base + '0'.repeat(64)).slice(0, 64) };
}

export const CLEAN_CONSENT: ConsentRecord = {
  basis: 'project_owned_synthetic',
  containsPersonalData: false,
  personalDataHandling: 'none',
  redistribution: 'internal_only',
  reviewedBy: 'model-data track',
  reviewedAt: '2026-07-31T00:00:00.000Z',
};

export function source(overrides: Partial<DatasetSource> = {}): DatasetSource {
  return {
    name: 'synthetic generator',
    url: 'scripts/generate.py',
    revision: 'generator-v1',
    license: 'Project-owned',
    declaredRecordCount: 10,
    consent: CLEAN_CONSENT,
    ...overrides,
  };
}

export function artifact(overrides: Partial<DatasetArtifact> = {}): DatasetArtifact {
  const id = overrides.id ?? 'sample-artifact';
  return {
    id,
    role: 'test',
    location: { repository: 'fixture-repo', revision: 'abc123', path: `data/${id}.jsonl` },
    mediaType: 'application/jsonl',
    recordCount: 10,
    byteSize: 100,
    checksum: checksum(id),
    mutability: 'locked',
    materialized: true,
    ...overrides,
  };
}

export function entry(overrides: Partial<DatasetEntry> = {}): DatasetEntry {
  return {
    id: 'sample-dataset',
    title: 'Sample dataset',
    version: '1.0.0',
    purpose: 'evaluation',
    status: 'frozen',
    owner: 'model-data',
    card: null,
    supersededBy: null,
    sources: [source()],
    lineage: {
      derivedFrom: ['source:synthetic generator'],
      producedBy: { script: 'scripts/generate.py', version: 'generator-v1', seed: 42 },
    },
    artifacts: [artifact()],
    ...overrides,
  };
}

export function registry(overrides: Partial<DatasetRegistry> = {}): DatasetRegistry {
  return {
    contractVersion: '1.0.0',
    registryVersion: '1.0.0',
    generatedAt: '2026-07-31T00:00:00.000Z',
    entries: [entry()],
    ...overrides,
  };
}

export function lockRecord(overrides: Partial<LockedArtifactRecord> = {}): LockedArtifactRecord {
  return {
    artifactId: 'sample-artifact',
    datasetId: 'sample-dataset',
    checksum: checksum('sample-artifact'),
    recordCount: 10,
    lockedAt: '2026-07-31T00:00:00.000Z',
    lockedBy: 'model-data track',
    authorizingIssue: 'https://github.com/anasakkari3/maybesitter/issues/2',
    state: 'active',
    supersededBy: null,
    supersessionIssue: null,
    supersessionReason: null,
    chainChecksum: checksum('0'),
    ...overrides,
  };
}

/** Applies the append-only chain, the way scripts/seal-lock-ledger.mjs does. */
export function seal(candidate: LockedArtifactLedger): LockedArtifactLedger {
  const chain = computeChain(candidate.records);
  return {
    ...candidate,
    records: candidate.records.map((record, index) => ({ ...record, chainChecksum: chain[index] })),
  };
}

export function ledger(overrides: Partial<LockedArtifactLedger> = {}): LockedArtifactLedger {
  return seal({
    contractVersion: '1.0.0',
    records: [lockRecord()],
    ...overrides,
  });
}

export function evaluationReport(overrides: Partial<EvaluationReport> = {}): EvaluationReport {
  return {
    contractVersion: '1.0.0',
    reportId: 'sample-run',
    createdAt: '2026-07-31T00:00:00.000Z',
    dataset: {
      datasetId: 'sample-dataset',
      datasetVersion: '1.0.0',
      artifactId: 'sample-artifact',
      checksum: checksum('sample-artifact'),
    },
    model: {
      id: 'models/mlx/gemma-3-4b-it-4bit',
      runtime: 'mlx',
      checksum: checksum('b2'),
      adapter: null,
      promptChecksum: checksum('c3'),
    },
    config: {
      checksum: checksum('d4'),
      seed: 42,
      maxTokens: 384,
      decoding: {},
      repairEnabled: true,
      limit: null,
    },
    contractSnapshot: null,
    metrics: { exactMatchPercent: 12.5, intentAccuracyPercent: null },
    ...overrides,
  };
}

/** Returns a deep clone so a test can mutate fixture data without leaking state. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
