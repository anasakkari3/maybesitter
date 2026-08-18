/**
 * Fine-tuning export guard (Sprint 02, issue #10).
 *
 * Every runtime memory record carries an exportPolicy, defaulting to
 * `personal_never_export` (see runtimeMemoryStore.ts). This module is the
 * choke point that turns that tag into an enforced boundary: any code path
 * that would move memory into training or fine-tuning data must call
 * assertNoPersonalMemory() first, and gets an exception rather than a filtered
 * list if it holds anything personal.
 *
 * Throwing rather than filtering is deliberate. Silently dropping personal
 * records would let an exporter ship a quietly truncated dataset and never
 * learn it had been holding data it should not have collected; a thrown error
 * forces the caller to fix the selection upstream.
 *
 * This is NOT the user's own data export. MemoryExport, produced by
 * RuntimeMemoryStore.export(), intentionally includes personal records because
 * that path exists to give users their own data. The two must not be confused.
 */
import type { ExportPolicy, RuntimeMemoryRecord } from '../../src/contracts/v1/memoryContracts';

/** The one policy value that may leave the user's scope. */
const FINE_TUNING_ALLOWED_POLICY: ExportPolicy = 'shareable_aggregate';

export class PersonalMemoryExportError extends Error {
  /** Ids of the offending records. Never their content — see below. */
  readonly recordIds: readonly string[];

  constructor(recordIds: readonly string[]) {
    super(
      `runtime memory: refusing fine-tuning export of ${recordIds.length} record(s) not marked `
      + `${FINE_TUNING_ALLOWED_POLICY} (personal_never_export or missing export policy): ${recordIds.join(', ')}`,
    );
    this.name = 'PersonalMemoryExportError';
    this.recordIds = recordIds;
  }
}

/**
 * Fails closed: only an explicit `shareable_aggregate` is exportable. A record
 * whose policy is missing, malformed, or from a newer schema counts as
 * personal, so the guard cannot be bypassed by stripping a field.
 */
export function isFineTuningExportable(record: RuntimeMemoryRecord | null | undefined): boolean {
  return Boolean(record) && record?.exportPolicy === FINE_TUNING_ALLOWED_POLICY;
}

/**
 * Throws unless every record is explicitly marked shareable. Status is
 * irrelevant — a revoked or superseded personal record is still personal.
 *
 * The error names record ids only. Putting content in the message would push
 * the very data this guard protects into logs and crash reports, which is the
 * leak it exists to prevent.
 */
export function assertNoPersonalMemory(records: readonly RuntimeMemoryRecord[]): void {
  if (!Array.isArray(records)) {
    throw new Error('runtime memory: assertNoPersonalMemory expects an array of records');
  }
  const blocked = records
    .map((record, index) => (isFineTuningExportable(record) ? null : record?.id ?? `<index ${index}, no id>`))
    .filter((id): id is string => id !== null);
  if (blocked.length > 0) throw new PersonalMemoryExportError(blocked);
}
