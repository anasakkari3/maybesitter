/**
 * The feedback study's response store (Sprint 11, issue #47).
 *
 * ── A declined answer is a row, not a missing row ────────────────
 *
 * `ShadowStudyResponse` has two variants and this store keeps both. The
 * temptation is to write only the ratings and let "no row" mean "declined",
 * which loses the one signal a study gets about questions people refuse to
 * answer — and makes "nobody was asked" and "everybody refused" the same
 * number. `declinedCount` in the summary is the thing that would silently
 * become zero.
 *
 * ── Identity is the (participant, run, question) triple ──────────
 *
 * Answering the same question about the same run again *supersedes*: one
 * person's answer to one question about one run is one answer, and appending
 * would let a participant who tapped twice count twice in an aggregate. The
 * same question about a *different* run is a different answer, and a response
 * about the study rather than about a run carries `runId: null`, which is its
 * own key.
 *
 * ── Reports, never throws ────────────────────────────────────────
 *
 * `record` validates every field against the contract's vocabularies and
 * returns a named rejection. The store is reachable from an HTTP handler, so a
 * throw here is a 500 rather than something a client can fix.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  SHADOW_SAFE_CODE,
  SHADOW_STUDY_QUESTIONS,
  SHADOW_STUDY_RATING_SCALE,
  isInstant,
  type ShadowStudyQuestionId,
  type ShadowStudyResponse,
} from '../../src/contracts/v1/shadowPipelineContracts';

const RESPONSE_SUBDIR = 'shadow-study-responses';
const RESPONSE_FILE_EXT = '.study-responses.json';
const TEMP_FILE_EXT = '.tmp';
const RESPONSE_ID_PREFIX = 'ssr_';
/** ASCII unit separator, spelled as an escape so an editor cannot strip it. */
const UNIT_SEPARATOR = '\u001f';
export const SHADOW_STUDY_RESPONSE_SCHEMA_VERSION = 'shadow-study-responses-v1' as const;

export const SHADOW_STUDY_RECORD_REJECTIONS = Object.freeze([
  'unsafe_participant',
  'unknown_question',
  'unknown_status',
  'unsafe_run',
  'rating_out_of_scale',
  'declined_carries_rating',
  'malformed_instant',
] as const);

export type ShadowStudyRecordRejection = (typeof SHADOW_STUDY_RECORD_REJECTIONS)[number];

export type ShadowStudyRecordResult =
  | { readonly status: 'recorded'; readonly response: ShadowStudyResponse; readonly superseded: boolean }
  | { readonly status: 'rejected'; readonly reason: ShadowStudyRecordRejection; readonly detail: string };

export interface ShadowStudyResponseStore {
  record(response: ShadowStudyResponse): ShadowStudyRecordResult;
  /** Insertion order for this participant. Nothing here sorts anything. */
  list(participantId: string): readonly ShadowStudyResponse[];
  listAll(): readonly ShadowStudyResponse[];
  countFor(participantId: string): number;
  /** Removes every response for this participant. Verify by re-listing. */
  deleteParticipant(participantId: string): number;
}

export interface ShadowStudyResponseStoreOptions {
  readonly dataDir?: string;
}

interface StoredResponses {
  readonly version: typeof SHADOW_STUDY_RESPONSE_SCHEMA_VERSION;
  readonly participantId: string;
  readonly responses: readonly ShadowStudyResponse[];
}

function isSafeCode(value: unknown): value is string {
  return typeof value === 'string' && SHADOW_SAFE_CODE.test(value);
}

function isKnownQuestion(value: unknown): value is ShadowStudyQuestionId {
  return (SHADOW_STUDY_QUESTIONS as readonly unknown[]).includes(value);
}

function isRatingInScale(value: unknown): value is number {
  return (
    typeof value === 'number'
    && Number.isInteger(value)
    && value >= SHADOW_STUDY_RATING_SCALE.minimum
    && value <= SHADOW_STUDY_RATING_SCALE.maximum
  );
}

function reject(reason: ShadowStudyRecordRejection, detail: string): ShadowStudyRecordResult {
  return { status: 'rejected', reason, detail };
}

/**
 * Validates a response against every vocabulary the contract owns.
 *
 * Returns the response narrowed rather than a boolean, so the caller stores the
 * value this function judged rather than the one it was handed — the difference
 * matters for `declined`, whose `rating` is normalised to `null` here after the
 * check that it was not a number.
 */
function validate(response: ShadowStudyResponse): ShadowStudyRecordResult {
  if (response === null || typeof response !== 'object') {
    return reject('unknown_status', 'a response was recorded that is not a response-shaped object');
  }
  if (!isSafeCode(response.participantId)) {
    return reject('unsafe_participant', 'participantId is outside the safe-code pattern');
  }
  if (!isKnownQuestion(response.question)) {
    return reject('unknown_question', `not a study question: ${String(response.question)}`);
  }
  if (response.runId !== null && !isSafeCode(response.runId)) {
    return reject('unsafe_run', `runId must be null or a safe code: ${String(response.runId)}`);
  }
  if (!isInstant(response.respondedAt)) {
    return reject('malformed_instant', `respondedAt is not an ISO instant with an explicit offset: ${String(response.respondedAt)}`);
  }
  if (response.status === 'rated') {
    if (!isRatingInScale(response.rating)) {
      return reject(
        'rating_out_of_scale',
        `a rating must be a whole number in ${SHADOW_STUDY_RATING_SCALE.minimum}–${SHADOW_STUDY_RATING_SCALE.maximum}: ${String(response.rating)}`,
      );
    }
    return {
      status: 'recorded',
      superseded: false,
      response: {
        status: 'rated',
        participantId: response.participantId,
        runId: response.runId,
        question: response.question,
        rating: response.rating,
        respondedAt: response.respondedAt,
      },
    };
  }
  if (response.status === 'declined') {
    // Read through a record rather than off the narrowed variant: the type
    // already says `rating: null`, so the compiler narrows the check away —
    // and this check exists precisely for the value that arrived through
    // `JSON.parse` and does not honour the type.
    const rating = (response as unknown as Record<string, unknown>).rating;
    if (rating !== null && rating !== undefined) {
      // Refused rather than stripped: a body that says "declined" and carries a
      // number disagrees with itself, and picking one half for the caller is
      // guessing which half they meant.
      return reject('declined_carries_rating', 'a declined answer cannot carry a rating');
    }
    return {
      status: 'recorded',
      superseded: false,
      response: {
        status: 'declined',
        participantId: response.participantId,
        runId: response.runId,
        question: response.question,
        rating: null,
        respondedAt: response.respondedAt,
      },
    };
  }
  return reject('unknown_status', `not a study response status: ${String((response as { status?: unknown }).status)}`);
}

/**
 * The identity of one answer. U+001F is a unit separator, which no field of
 * the key can contain: `SHADOW_SAFE_CODE` and the question vocabulary are both
 * pattern-closed over printable characters.
 */
function responseKey(response: ShadowStudyResponse): string {
  return `${response.participantId}${UNIT_SEPARATOR}${response.runId ?? ''}${UNIT_SEPARATOR}${response.question}`;
}

interface ResponseRepository {
  readFor(participantId: string): readonly ShadowStudyResponse[];
  writeFor(participantId: string, responses: readonly ShadowStudyResponse[]): void;
  removeFor(participantId: string): void;
  listParticipants(): readonly string[];
}

function createStore(repository: ResponseRepository): ShadowStudyResponseStore {
  return {
    record(response): ShadowStudyRecordResult {
      const validated = validate(response);
      if (validated.status === 'rejected') return validated;

      const accepted = validated.response;
      const existing = repository.readFor(accepted.participantId);
      const key = responseKey(accepted);
      const index = existing.findIndex((held) => responseKey(held) === key);
      const next = index === -1
        ? [...existing, accepted]
        : existing.map((held, at) => (at === index ? accepted : held));
      repository.writeFor(accepted.participantId, next);
      return { status: 'recorded', response: accepted, superseded: index !== -1 };
    },

    list(participantId): readonly ShadowStudyResponse[] {
      if (!isSafeCode(participantId)) return [];
      return repository.readFor(participantId);
    },

    listAll(): readonly ShadowStudyResponse[] {
      const all: ShadowStudyResponse[] = [];
      for (const participantId of repository.listParticipants()) {
        all.push(...repository.readFor(participantId));
      }
      return all;
    },

    countFor(participantId): number {
      if (!isSafeCode(participantId)) return 0;
      return repository.readFor(participantId).length;
    },

    deleteParticipant(participantId): number {
      if (!isSafeCode(participantId)) return 0;
      const removed = repository.readFor(participantId).length;
      repository.removeFor(participantId);
      return removed;
    },
  };
}

function defaultDataDir(): string {
  const root = process.env.MAYBESITTER_DATA_DIR || path.join(process.cwd(), '.maybesitter');
  return path.join(root, RESPONSE_SUBDIR);
}

function responseFileId(participantId: string): string {
  return `${RESPONSE_ID_PREFIX}${createHash('sha256').update(participantId, 'utf8').digest('hex')}`;
}

function isStoredResponses(value: unknown): value is StoredResponses {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return (
    raw.version === SHADOW_STUDY_RESPONSE_SCHEMA_VERSION
    && isSafeCode(raw.participantId)
    && Array.isArray(raw.responses)
  );
}

function createFileRepository(resolveDataDir: () => string): ResponseRepository {
  function ensureDir(): string {
    const dataDir = resolveDataDir();
    mkdirSync(dataDir, { recursive: true });
    return dataDir;
  }

  function filePathFor(dataDir: string, participantId: string): string {
    return path.join(dataDir, `${responseFileId(participantId)}${RESPONSE_FILE_EXT}`);
  }

  function readFile(file: string): StoredResponses | null {
    if (!existsSync(file)) return null;
    try {
      const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (isStoredResponses(raw)) return raw;
    } catch {
      // Corrupt or truncated: no responses, which is the fail-closed reading.
    }
    return null;
  }

  return {
    readFor(participantId): readonly ShadowStudyResponse[] {
      const stored = readFile(filePathFor(ensureDir(), participantId));
      if (stored === null || stored.participantId !== participantId) return [];
      // Re-validated on the way out: a hand-edited file cannot put a rating on
      // a declined answer, or a question this version does not know, into an
      // aggregate.
      return stored.responses.filter((held) => validate(held).status === 'recorded');
    },

    writeFor(participantId, responses): void {
      const file = filePathFor(ensureDir(), participantId);
      const record: StoredResponses = {
        version: SHADOW_STUDY_RESPONSE_SCHEMA_VERSION,
        participantId,
        responses,
      };
      const temporary = `${file}.${process.pid}${TEMP_FILE_EXT}`;
      writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(temporary, file);
    },

    removeFor(participantId): void {
      const dataDir = ensureDir();
      const file = filePathFor(dataDir, participantId);
      if (existsSync(file)) unlinkSync(file);
      const tempPrefix = `${responseFileId(participantId)}${RESPONSE_FILE_EXT}`;
      for (const entry of readdirSync(dataDir)) {
        if (!entry.startsWith(tempPrefix) || !entry.endsWith(TEMP_FILE_EXT)) continue;
        unlinkSync(path.join(dataDir, entry));
      }
    },

    listParticipants(): readonly string[] {
      const dataDir = ensureDir();
      const ids: string[] = [];
      for (const entry of readdirSync(dataDir)) {
        if (!entry.endsWith(RESPONSE_FILE_EXT)) continue;
        const stored = readFile(path.join(dataDir, entry));
        if (stored !== null) ids.push(stored.participantId);
      }
      return ids;
    },
  };
}

function createMemoryRepository(): ResponseRepository {
  const records = new Map<string, readonly ShadowStudyResponse[]>();
  return {
    readFor: (participantId) => records.get(participantId) ?? [],
    writeFor: (participantId, responses) => {
      records.set(participantId, responses);
    },
    removeFor: (participantId) => {
      records.delete(participantId);
    },
    listParticipants: () => Array.from(records.keys()),
  };
}

export function createFileShadowStudyResponseStore(
  options?: ShadowStudyResponseStoreOptions,
): ShadowStudyResponseStore {
  return createStore(createFileRepository(() => options?.dataDir ?? defaultDataDir()));
}

export function createInMemoryShadowStudyResponseStore(): ShadowStudyResponseStore {
  return createStore(createMemoryRepository());
}
