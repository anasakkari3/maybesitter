/**
 * What MaybeSitter knows about you, as the phone reads and edits it
 * (UC-2.7a, #167).
 *
 * ── The scope check is the whole security boundary ───────────────
 *
 * `RuntimeMemoryStore.get`, `.supersede`, `.revoke` and `.deleteById` address a
 * record **by id alone** — a collection-group query, because that API predates
 * there being a user tree to put records in. That is fine for a server-side
 * caller that already knows whose record it holds. It is not fine for a route,
 * where the id arrives in the URL from whoever asked: without a check, knowing
 * a `mem_…` id would be enough to read, rewrite or delete a stranger's memory.
 *
 * So every function here resolves the record first and refuses unless
 * `record.scopeId === uid`, and it refuses with the *same* answer it gives for
 * an id that does not exist. A 403 would confirm the record is real and belongs
 * to somebody, which is itself the leak.
 *
 * ── Delete means the whole chain ─────────────────────────────────
 *
 * Superseding keeps history: editing "sleep 22:30" to "sleep 00:30" leaves the
 * first record behind, superseded, so the store can show how a fact changed.
 * Deleting has to take that history with it. If it removed only the record the
 * user tapped, the sentence they asked to erase would still be sitting in the
 * chain behind its replacement — technically not "active", and entirely still
 * there. `deleteChain` walks `supersedesId` back to the first record and
 * `supersededById` forward to the last, and removes all of them.
 */
import {
  USER_STATED_MEMORY_TTL_MS,
  type CreateMemoryInput,
  type MemoryLanguage,
  type MemoryProvenance,
  type RuntimeMemoryKind,
  type RuntimeMemoryRecord,
  type RuntimeMemoryStore,
} from '../../../src/contracts/v1/memoryContracts';
import { createPilotAuditEvent } from '../../pilot/closedPilotControls';
import { appendAudit } from '../../pilot/pilotTrustStore';
import { createStorageRuntimeMemoryStore } from '../../runtimeMemory/runtimeMemoryStore';
import { requireUserId, type StorageAdapter } from '../../storage';

/** The kinds a person may file something under by hand. */
export const MANUAL_MEMORY_KINDS: readonly RuntimeMemoryKind[] = ['fact', 'preference', 'goal'];

const MEMORY_LANGUAGES: readonly MemoryLanguage[] = ['ar', 'he', 'en', 'mixed'];

/**
 * A manual fact is a sentence, not an essay. 200 characters is the issue's
 * bound; it is enforced in code points rather than UTF-16 units so an Arabic
 * or Hebrew sentence gets the same allowance an English one does.
 */
export const MAX_MEMORY_CONTENT_LENGTH = 200;

export class MemoryNotFoundError extends Error {
  constructor() {
    super('memory not found');
    this.name = 'MemoryNotFoundError';
  }
}

export class MemoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryValidationError';
  }
}

export interface MemoryServiceOptions {
  storage?: StorageAdapter;
  memory?: RuntimeMemoryStore;
}

function storeOf(options: MemoryServiceOptions): RuntimeMemoryStore {
  return options.memory ?? createStorageRuntimeMemoryStore(undefined, options.storage);
}

/** What the phone receives. Deliberately not the stored record. */
export interface MemoryDto {
  id: string;
  kind: RuntimeMemoryKind;
  content: string;
  language: MemoryLanguage;
  source: RuntimeMemoryRecord['source'];
  confidence: number;
  createdAt: string;
  observedAt: string;
  provenance: MemoryProvenance | null;
}

/**
 * `scopeId`, `staleAfter`, `exportPolicy` and the supersession links are left
 * out on purpose: the first is the caller's own uid, and the rest are storage
 * mechanics the screen has no decision to make about. Sending them would make
 * them contract, and something would start depending on them.
 */
export function memoryToDto(record: RuntimeMemoryRecord): MemoryDto {
  return {
    id: record.id,
    kind: record.kind,
    content: record.content,
    language: record.language,
    source: record.source,
    confidence: record.confidence,
    createdAt: record.createdAt,
    observedAt: record.observedAt,
    provenance: record.provenance ? { ...record.provenance } : null,
  };
}

/**
 * Everything currently believed about this account, newest first.
 *
 * Uses `retrieve`, not `listAll`, so the screen shows exactly what the rest of
 * the product can actually see: active, in scope, and not stale. A screen that
 * listed a stale record would be telling the user MaybeSitter remembers
 * something no consumer of the store can any longer read.
 */
export async function listMemory(
  uid: string,
  now: string,
  options: MemoryServiceOptions = {},
): Promise<MemoryDto[]> {
  requireUserId(uid);
  const records = await storeOf(options).retrieve({ scopeId: uid, now });
  return records.map(memoryToDto);
}

export interface CreateManualMemoryInput {
  kind: unknown;
  content: unknown;
  language: unknown;
}

export async function createManualMemory(
  uid: string,
  input: CreateManualMemoryInput,
  at: string,
  options: MemoryServiceOptions = {},
): Promise<MemoryDto> {
  requireUserId(uid);
  const create: CreateMemoryInput = {
    scopeId: uid,
    kind: requireManualKind(input.kind),
    content: requireContent(input.content),
    language: requireLanguage(input.language),
    source: 'user_stated',
    confidence: 1,
    observedAt: at,
    ttlMs: USER_STATED_MEMORY_TTL_MS,
    provenance: { origin: 'manual' },
  };
  return memoryToDto(await storeOf(options).put(create, at));
}

/**
 * An edit is a supersession, never a rewrite.
 *
 * The replacement is `user_stated` whatever the original was, and that is the
 * point of the rule: once somebody has corrected a sentence the AI proposed,
 * the sentence is theirs. It also stops an edited model guess from keeping the
 * lower confidence that would let a later guess outrank it.
 */
export async function patchMemory(
  uid: string,
  id: string,
  content: unknown,
  at: string,
  options: MemoryServiceOptions = {},
): Promise<MemoryDto> {
  requireUserId(uid);
  const store = storeOf(options);
  const prior = await requireOwnedRecord(store, uid, id);
  const replacement: CreateMemoryInput = {
    scopeId: uid,
    kind: prior.kind,
    content: requireContent(content),
    language: prior.language,
    source: 'user_stated',
    confidence: 1,
    observedAt: at,
    ttlMs: USER_STATED_MEMORY_TTL_MS,
    provenance: {
      ...(prior.provenance ?? { origin: 'manual' as const }),
      // The path it originally arrived by is kept — an edited onboarding answer
      // is still an onboarding answer — but the model fields go, because the
      // sentence that is now stored is not the one any model produced.
      confirmedByUserAt: at,
      ...(prior.provenance?.model !== undefined ? { model: undefined } : {}),
    } as MemoryProvenance,
  };
  const cleaned: CreateMemoryInput = {
    ...replacement,
    provenance: stripUndefined(replacement.provenance!),
  };
  return memoryToDto(await store.supersede(prior.id, cleaned, at));
}

/** Removes one fact and the whole supersession chain it belongs to. */
export async function deleteMemory(
  uid: string,
  id: string,
  at: string,
  options: MemoryServiceOptions = {},
): Promise<number> {
  requireUserId(uid);
  const store = storeOf(options);
  const record = await requireOwnedRecord(store, uid, id, { allowSuperseded: true });
  const removed = await deleteChain(store, uid, record);
  await appendMemoryDeletion(uid, at, removed, 'memory_deleted_one');
  return removed;
}

/** Removes every record this account holds, whatever its status. */
export async function deleteAllMemory(
  uid: string,
  at: string,
  options: MemoryServiceOptions = {},
): Promise<number> {
  requireUserId(uid);
  const removed = await storeOf(options).deleteScope(uid);
  await appendMemoryDeletion(uid, at, removed, 'memory_deleted_all');
  return removed;
}

/**
 * The audit line carries a count and nothing else — never the id, and never a
 * word of what the record said. #167 asks for "the id only"; a count is
 * strictly less, and the id is of no use once the record it names is gone.
 */
async function appendMemoryDeletion(uid: string, at: string, removed: number, reasonCode: string): Promise<void> {
  await appendAudit(createPilotAuditEvent({
    version: 'v1',
    eventType: 'memory_deleted',
    participantId: uid,
    occurredAt: at,
    outcome: 'recorded',
    reasonCode: `${reasonCode}_${removed}`,
  }));
}

async function deleteChain(
  store: RuntimeMemoryStore,
  uid: string,
  record: RuntimeMemoryRecord,
): Promise<number> {
  const seen = new Set<string>();
  const queue: RuntimeMemoryRecord[] = [record];
  const chain: RuntimeMemoryRecord[] = [];

  while (queue.length > 0) {
    const current = queue.pop()!;
    if (seen.has(current.id)) continue;
    seen.add(current.id);
    // A link that somehow points out of the scope is followed no further. It
    // cannot happen through `supersede`, which refuses to cross scopes, and if
    // it ever did this must not become a way to delete somebody else's record.
    if (current.scopeId !== uid) continue;
    chain.push(current);
    for (const neighbour of [current.supersedesId, current.supersededById]) {
      if (!neighbour || seen.has(neighbour)) continue;
      const next = await store.get(neighbour);
      if (next) queue.push(next);
    }
  }

  let removed = 0;
  for (const entry of chain) {
    if (await store.deleteById(entry.id)) removed += 1;
  }
  return removed;
}

/**
 * The record, if it is this account's. Otherwise the same `MemoryNotFoundError`
 * an unknown id gets — see the header on why the two answers are identical.
 */
async function requireOwnedRecord(
  store: RuntimeMemoryStore,
  uid: string,
  id: string,
  options: { allowSuperseded?: boolean } = {},
): Promise<RuntimeMemoryRecord> {
  const record = typeof id === 'string' ? await store.get(id) : null;
  if (!record || record.scopeId !== uid) throw new MemoryNotFoundError();
  // Editing a record that has already been replaced would fork the chain, and
  // the store refuses it anyway; refusing here makes it a 404 rather than a 500.
  if (!options.allowSuperseded && record.status !== 'active') throw new MemoryNotFoundError();
  return record;
}

function requireManualKind(value: unknown): RuntimeMemoryKind {
  if (typeof value !== 'string' || !MANUAL_MEMORY_KINDS.includes(value as RuntimeMemoryKind)) {
    throw new MemoryValidationError(`kind must be one of ${MANUAL_MEMORY_KINDS.join(', ')}`);
  }
  return value as RuntimeMemoryKind;
}

function requireLanguage(value: unknown): MemoryLanguage {
  if (typeof value !== 'string' || !MEMORY_LANGUAGES.includes(value as MemoryLanguage)) {
    throw new MemoryValidationError(`language must be one of ${MEMORY_LANGUAGES.join(', ')}`);
  }
  return value as MemoryLanguage;
}

function requireContent(value: unknown): string {
  if (typeof value !== 'string') throw new MemoryValidationError('content must be a string');
  const trimmed = value.trim();
  if (trimmed === '') throw new MemoryValidationError('content must not be empty');
  // Code points, not UTF-16 units, so an emoji or a rare glyph does not eat two
  // of the user's 200 characters. `Array.from` rather than spread: the
  // repository's TS target does not down-level string iteration.
  if (Array.from(trimmed).length > MAX_MEMORY_CONTENT_LENGTH) {
    throw new MemoryValidationError(`content must be at most ${MAX_MEMORY_CONTENT_LENGTH} characters`);
  }
  return trimmed;
}

function stripUndefined(provenance: MemoryProvenance): MemoryProvenance {
  const entries = Object.entries(provenance).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries) as unknown as MemoryProvenance;
}
