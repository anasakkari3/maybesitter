/**
 * The feedback study's response store, on durable storage (UC-1.0c, #142).
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
 * would let a participant who tapped twice count twice in an aggregate. That
 * identity is now the **document id** — `sha256` of the triple — so
 * superseding is an overwrite of one document rather than a rewrite of a
 * per-participant array, and two concurrent answers cannot lose each other.
 * The same question about a *different* run is a different answer, and a
 * response about the study rather than about a run carries `runId: null`,
 * which is its own key.
 *
 * ── Ordering is explicit, not the backend's ──────────────────────
 *
 * The file store returned array order. One document per response has no such
 * order, and the two adapters disagree about the natural order of a group read
 * anyway, so `list` sorts by `(respondedAt, question, runId)`. That is
 * deterministic on either backend, where "whatever order the store iterated"
 * was not.
 */
import {
  SHADOW_SAFE_CODE,
  SHADOW_STUDY_QUESTIONS,
  SHADOW_STUDY_RATING_SCALE,
  isInstant,
  type ShadowStudyQuestionId,
  type ShadowStudyResponse,
} from '../../src/contracts/v1/shadowPipelineContracts';
import {
  STUDY_RESPONSES,
  createMemoryStorage,
  docIdForKey,
  getStorage,
  userCol,
  userIdForKey,
  type StorageAdapter,
} from '../storage';

/** ASCII unit separator, spelled as an escape so an editor cannot strip it. */
const UNIT_SEPARATOR = '';
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

/** Async since UC-1.0c (#142): every method is a storage round trip. */
export interface ShadowStudyResponseStore {
  record(response: ShadowStudyResponse): Promise<ShadowStudyRecordResult>;
  list(participantId: string): Promise<readonly ShadowStudyResponse[]>;
  listAll(): Promise<readonly ShadowStudyResponse[]>;
  countFor(participantId: string): Promise<number>;
  /** Removes every response for this participant. Verify by re-listing. */
  deleteParticipant(participantId: string): Promise<number>;
}

/** The response plus the schema tag, so a group read can filter to this store. */
interface StoredResponse {
  readonly version: typeof SHADOW_STUDY_RESPONSE_SCHEMA_VERSION;
  readonly response: ShadowStudyResponse;
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
      // Refused rather than stripped: a body that says "declined" and carries
      // a number disagrees with itself, and picking one half for the caller is
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
 * The identity of one answer, and now the document id. U+001F is a unit
 * separator, which no field of the key can contain: `SHADOW_SAFE_CODE` and the
 * question vocabulary are both pattern-closed over printable characters.
 */
function responseKey(response: ShadowStudyResponse): string {
  return `${response.participantId}${UNIT_SEPARATOR}${response.runId ?? ''}${UNIT_SEPARATOR}${response.question}`;
}

function collectionFor(participantId: string): string {
  return userCol(userIdForKey(participantId), STUDY_RESPONSES);
}

function documentPath(response: ShadowStudyResponse): string {
  return `${collectionFor(response.participantId)}/${docIdForKey(responseKey(response))}`;
}

/** Deterministic on either backend; see the header. */
function byAnswerOrder(a: ShadowStudyResponse, b: ShadowStudyResponse): number {
  if (a.respondedAt !== b.respondedAt) return a.respondedAt < b.respondedAt ? -1 : 1;
  if (a.question !== b.question) return a.question < b.question ? -1 : 1;
  const left = a.runId ?? '';
  const right = b.runId ?? '';
  return left < right ? -1 : left > right ? 1 : 0;
}

function isStoredResponse(value: unknown): value is StoredResponse {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Partial<StoredResponse>;
  return raw.version === SHADOW_STUDY_RESPONSE_SCHEMA_VERSION && Boolean(raw.response);
}

export class StorageShadowStudyResponseStore implements ShadowStudyResponseStore {
  constructor(private readonly injected?: StorageAdapter) {}

  /** Resolved per call so a test may swap the adapter after construction. */
  private get storage(): StorageAdapter {
    return this.injected ?? getStorage();
  }

  /**
   * Re-validated on the way out, as the file store did: a hand-edited record
   * cannot put a rating on a declined answer, or a question this version does
   * not know, into an aggregate.
   */
  private usable(rows: Array<{ data: StoredResponse }>): ShadowStudyResponse[] {
    return rows
      .filter((row) => isStoredResponse(row.data))
      .map((row) => row.data.response)
      .filter((response) => validate(response).status === 'recorded')
      .sort(byAnswerOrder);
  }

  async record(response: ShadowStudyResponse): Promise<ShadowStudyRecordResult> {
    const validated = validate(response);
    if (validated.status === 'rejected') return validated;
    const accepted = validated.response;
    const path = documentPath(accepted);

    // Read and write in one transaction so `superseded` reports what actually
    // happened rather than what was true a moment before the write.
    return this.storage.runTransaction(async (tx) => {
      const existing = await tx.get<StoredResponse>(path);
      tx.set<StoredResponse>(path, { version: SHADOW_STUDY_RESPONSE_SCHEMA_VERSION, response: accepted });
      return { status: 'recorded' as const, response: accepted, superseded: existing !== null };
    });
  }

  async list(participantId: string): Promise<readonly ShadowStudyResponse[]> {
    if (!isSafeCode(participantId)) return [];
    return this.usable(await this.storage.list<StoredResponse>(collectionFor(participantId)));
  }

  async listAll(): Promise<readonly ShadowStudyResponse[]> {
    return this.usable(await this.storage.listGroup<StoredResponse>(STUDY_RESPONSES));
  }

  async countFor(participantId: string): Promise<number> {
    return (await this.list(participantId)).length;
  }

  async deleteParticipant(participantId: string): Promise<number> {
    if (!isSafeCode(participantId)) return 0;
    const collection = collectionFor(participantId);
    const rows = await this.storage.list<StoredResponse>(collection);
    for (const row of rows) await this.storage.delete(`${collection}/${row.id}`);
    return rows.length;
  }
}

/**
 * The same implementation over a private in-memory adapter, so a test cannot
 * exercise semantics production does not have.
 */
export class MemoryShadowStudyResponseStore extends StorageShadowStudyResponseStore {
  constructor() {
    super(createMemoryStorage());
  }
}

export function createStorageShadowStudyResponseStore(storage?: StorageAdapter): ShadowStudyResponseStore {
  return new StorageShadowStudyResponseStore(storage);
}

export function createInMemoryShadowStudyResponseStore(): ShadowStudyResponseStore {
  return new MemoryShadowStudyResponseStore();
}
