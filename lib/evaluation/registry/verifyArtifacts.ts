import type { Checksum, DatasetRegistry, ValidationResult } from './contracts';
import { IssueCollector, checksumsEqual } from './validationPrimitives';

export interface ObservedArtifact {
  checksum: Checksum;
  recordCount: number | null;
  byteSize: number | null;
}

/**
 * Resolves an artifact location to what is actually on disk. Returning null
 * means "not found". Keeping this a port rather than a direct fs call is what
 * lets the governance rules be tested without fixture files, and lets the CLI
 * verify a checkout that lives outside this repository.
 */
export type ArtifactReader = (
  repository: string,
  revision: string,
  path: string,
) => ObservedArtifact | null;

export interface VerifyArtifactsOptions {
  /** Repositories to verify. Artifacts in other repositories are skipped. */
  repositories?: readonly string[];
}

/**
 * Compares every registered artifact against the bytes actually present.
 * A locked artifact whose bytes changed fails here even if the registry and
 * the ledger still agree with each other.
 */
export function verifyRegistryArtifacts(
  registry: DatasetRegistry,
  read: ArtifactReader,
  options: VerifyArtifactsOptions = {},
): ValidationResult {
  const collector = new IssueCollector();
  const scope = options.repositories;

  for (const entry of registry.entries) {
    for (const artifact of entry.artifacts) {
      const path = `${entry.id}.artifacts.${artifact.id}`;

      if (scope !== undefined && !scope.includes(artifact.location.repository)) {
        continue;
      }

      const observed = read(
        artifact.location.repository,
        artifact.location.revision,
        artifact.location.path,
      );

      if (observed === null) {
        if (artifact.materialized) {
          collector.error(
            'VER001',
            path,
            `${artifact.location.path} is registered as materialized but was not found in ${artifact.location.repository}`,
          );
        }
        continue;
      }

      if (!artifact.materialized) {
        collector.warn(
          'VER002',
          path,
          `${artifact.location.path} exists but is registered as not materialized`,
        );
      }

      if (!checksumsEqual(artifact.checksum, observed.checksum)) {
        const severity = artifact.mutability === 'locked' ? 'error' : 'warning';
        collector.add(
          severity,
          artifact.mutability === 'locked' ? 'VER010' : 'VER011',
          path,
          `${artifact.location.path} checksum drifted: registry declares ${artifact.checksum.value}, disk has ${observed.checksum.value}` +
            (artifact.mutability === 'locked'
              ? '. Locked artifacts are immutable — restore the file or supersede the lock.'
              : '. Re-register the artifact before using it in an evaluation.'),
        );
      }

      if (
        artifact.recordCount !== null &&
        observed.recordCount !== null &&
        artifact.recordCount !== observed.recordCount
      ) {
        collector.add(
          artifact.mutability === 'locked' ? 'error' : 'warning',
          'VER020',
          path,
          `${artifact.location.path} record count drifted: registry declares ${artifact.recordCount}, disk has ${observed.recordCount}`,
        );
      }
    }
  }

  return collector.result();
}
