/**
 * User-stated preference corrections (Sprint 10, issue #42).
 *
 * ── The representation decision ──────────────────────────────────────────
 *
 * A correction is a **runtime memory `preference` record** with
 * `source: 'user_stated'` and a canonical content spelling:
 *
 *     personalization:<dimension>=<level>
 *
 * both halves drawn from the contract's closed vocabularies. Why this and not
 * a fifth store:
 *
 *   - The contract already frames the split: "a runtime memory `preference`
 *     record is something the user *said* … the store is the system of record
 *     for statements." A correction is precisely a statement.
 *   - The store's existing machinery is the machinery corrections need:
 *     `supersede()` keeps the chain of changed minds inspectable, `revoke()`
 *     is "withdraw my correction" with an audit trail, `export()` includes it
 *     in the user's own data, `deleteScope()` erases it, and
 *     `personal_never_export` (the default) keeps it out of fine-tuning.
 *   - The canonical spelling keeps the *value* closed-vocabulary even though
 *     the field is free text: `parseCorrectionContent` accepts only known
 *     dimension/level pairs, so a correction can never smuggle raw personal
 *     text into a preference level.
 *
 * The deriver never reads these records — v1 of the contract explicitly
 * excludes `user_stated` memories from `PersonalizationDerivationInput`. The
 * override therefore happens on the consumer side of the seam:
 * `effectiveLevelFor` (in inventory.ts) ranks user correction above operative
 * derivation above product baseline. A correction outranks derivation by
 * construction, because it is consulted first, not because it is fed back in.
 *
 * No function here reads a clock; every instant is the caller's.
 */
import type { RuntimeMemoryRecord, RuntimeMemoryStore } from '../../src/contracts/v1/memoryContracts';
import {
  PREFERENCE_DIMENSIONS,
  PREFERENCE_LEVEL_VOCABULARY,
  type PreferenceDimension,
  type PreferenceLevel,
} from '../../src/contracts/v1/personalizationContracts';

export const CORRECTION_CONTENT_PREFIX = 'personalization:';

export interface CorrectionEntry {
  readonly level: string;
  readonly recordId: string;
  /** When the user stated it — the record's observedAt. */
  readonly statedAt: string;
}

/** One slot per dimension; null where the user has stated nothing. */
export type CorrectionsByDimension = {
  readonly [D in PreferenceDimension]: CorrectionEntry | null;
};

export type ApplyCorrectionResult =
  | { readonly ok: true; readonly record: RuntimeMemoryRecord }
  | { readonly ok: false; readonly reason: 'unknown_dimension' | 'unknown_level' | 'store_rejected' };

function isKnownDimension(value: unknown): value is PreferenceDimension {
  return (PREFERENCE_DIMENSIONS as readonly unknown[]).includes(value);
}

function isKnownLevel(dimension: PreferenceDimension, value: unknown): boolean {
  return (PREFERENCE_LEVEL_VOCABULARY[dimension] as readonly string[]).includes(value as string);
}

export function formatCorrectionContent(dimension: PreferenceDimension, level: PreferenceLevel): string {
  return `${CORRECTION_CONTENT_PREFIX}${dimension}=${level}`;
}

/**
 * Strict on both halves: only a known dimension paired with a level from that
 * dimension's own vocabulary parses. Everything else — free text, unknown
 * levels, a level borrowed from a different dimension — is null, and null
 * means "not a correction", never an error.
 */
export function parseCorrectionContent(
  content: unknown,
): { dimension: PreferenceDimension; level: string } | null {
  if (typeof content !== 'string' || !content.startsWith(CORRECTION_CONTENT_PREFIX)) return null;
  const rest = content.slice(CORRECTION_CONTENT_PREFIX.length);
  const separator = rest.indexOf('=');
  if (separator < 0) return null;
  const dimension = rest.slice(0, separator);
  const level = rest.slice(separator + 1);
  if (!isKnownDimension(dimension)) return null;
  if (!isKnownLevel(dimension, level)) return null;
  return { dimension, level };
}

/**
 * The active correction records for a scope, newest stated first, exactly as
 * `retrieve()` orders them. Only records that are simultaneously (a) active
 * and fresh, (b) `user_stated`, and (c) canonically spelled count — a
 * model-inferred record that mimics the spelling is not the user's statement,
 * and reading it as one would launder an inference into an override.
 */
function activeCorrectionRecords(
  memory: RuntimeMemoryStore,
  scopeId: string,
  now: string,
): readonly (RuntimeMemoryRecord & { readonly parsed: { dimension: PreferenceDimension; level: string } })[] {
  return memory
    .retrieve({ scopeId, kind: 'preference', now })
    .flatMap((record) => {
      if (record.source !== 'user_stated') return [];
      const parsed = parseCorrectionContent(record.content);
      return parsed === null ? [] : [Object.assign(Object.create(null), record, { parsed })];
    });
}

export function readCorrections(
  memory: RuntimeMemoryStore,
  scopeId: string,
  now: string,
): CorrectionsByDimension {
  const entries = Object.fromEntries(
    PREFERENCE_DIMENSIONS.map((dimension) => [dimension, null]),
  ) as Record<PreferenceDimension, CorrectionEntry | null>;

  for (const record of activeCorrectionRecords(memory, scopeId, now)) {
    // retrieve() is newest-observed-first; the first record seen per dimension
    // is the user's latest statement and the ones behind it are ignored.
    if (entries[record.parsed.dimension] !== null) continue;
    entries[record.parsed.dimension] = {
      level: record.parsed.level,
      recordId: record.id,
      statedAt: record.observedAt,
    };
  }
  return entries as CorrectionsByDimension;
}

/**
 * Records the user's stated level for one dimension. A prior active statement
 * on the same dimension is superseded — the chain stays inspectable — and an
 * absent one means a fresh record. Unknown vocabulary is reported, not
 * written: a correction that is not expressible in the contract's closed sets
 * is not a correction, whatever else it may be.
 */
export function applyCorrection(
  memory: RuntimeMemoryStore,
  scopeId: string,
  dimension: PreferenceDimension,
  level: PreferenceLevel,
  now: string,
): ApplyCorrectionResult {
  if (!isKnownDimension(dimension)) return { ok: false, reason: 'unknown_dimension' };
  if (!isKnownLevel(dimension, level)) return { ok: false, reason: 'unknown_level' };

  const input = {
    scopeId,
    kind: 'preference' as const,
    content: formatCorrectionContent(dimension, level),
    language: 'en' as const,
    source: 'user_stated' as const,
    confidence: 1,
    observedAt: now,
  };

  const existing = activeCorrectionRecords(memory, scopeId, now)
    .find((record) => record.parsed.dimension === dimension);

  try {
    const record = existing === undefined
      ? memory.put(input, now)
      : memory.supersede(existing.id, input, now);
    return { ok: true, record };
  } catch {
    // The store refusing a write (e.g. a race superseded the head first) is
    // reported to the caller rather than thrown through a route.
    return { ok: false, reason: 'store_rejected' };
  }
}

/**
 * Withdraws the user's statement for one dimension by revoking it — hidden
 * from every future read, kept for audit, exactly the store's revocation
 * semantics. Returns false when there was nothing to clear.
 */
export function clearCorrection(
  memory: RuntimeMemoryStore,
  scopeId: string,
  dimension: PreferenceDimension,
  at: string,
): boolean {
  const existing = activeCorrectionRecords(memory, scopeId, at)
    .find((record) => record.parsed.dimension === dimension);
  if (existing === undefined) return false;
  return memory.revoke(existing.id, at);
}
