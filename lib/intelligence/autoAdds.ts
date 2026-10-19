import { createHash } from 'node:crypto';
import { applyCommand, type Commitment, type DomainEvent } from '../../src/domain/stateMachine';
import {
  getStorage,
  INTELLIGENCE_AUTO_ADDS,
  INTELLIGENCE_OBSERVATIONS,
  userCol,
  userDoc,
  type StorageAdapter,
  type StorageReader,
} from '../storage';
import { loadDomainState, writeDomainDiff } from '../services/mobile/participantState';
import type { StoredObservation } from './observationStore';

export interface AutoAddRecord {
  readonly autoAddId: string;
  readonly providerAccountId: string;
  readonly commitmentId: string;
  readonly observationIds: readonly string[];
  readonly evidence: string;
  readonly baseline: string;
  readonly at: string;
  readonly removedAt: string | null;
}

const EDITABLE_BASELINE_FIELDS = [
  'kind', 'title', 'description', 'person', 'status', 'priority', 'category',
  'categorySource', 'timeSpec', 'locationTrigger', 'currentAckState', 'postponedUntil',
] as const satisfies readonly (keyof Commitment)[];

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function normalizedAck(value: Commitment['currentAckState']): string {
  return value === 'not_seen' || value === 'seen' || value === 'ignored' ? 'system_unacknowledged' : value;
}

/** Fingerprint every person-editable field; system reminder acknowledgements normalize away. */
export function commitmentBaselineFingerprint(commitment: Commitment): string {
  const fields = Object.fromEntries(EDITABLE_BASELINE_FIELDS.map((field) => [
    field,
    field === 'currentAckState' ? normalizedAck(commitment.currentAckState) : commitment[field],
  ]));
  return createHash('sha256').update(JSON.stringify(canonical(fields))).digest('hex');
}

export function autoAddPath(uid: string, autoAddId: string): string {
  if (!/^[a-f0-9]{64}$/.test(autoAddId)) throw new Error('invalid auto-add id');
  return `${userCol(uid, INTELLIGENCE_AUTO_ADDS)}/${autoAddId}`;
}

function statusOf(commitment: Commitment): 'open' | 'done' | 'dropped' | 'archived' {
  if (commitment.status === 'completed') return 'done';
  if (commitment.status === 'dropped') return 'dropped';
  if (commitment.status === 'archived') return 'archived';
  return 'open';
}

function cursorOf(record: AutoAddRecord): string {
  return Buffer.from(JSON.stringify([record.at, record.autoAddId]), 'utf8').toString('base64url');
}

function decodeCursor(value: string | null): [string, string] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    return Array.isArray(parsed) && parsed.length === 2 && parsed.every(item => typeof item === 'string')
      ? [parsed[0] as string, parsed[1] as string] : null;
  } catch { return null; }
}

export async function listAutoAdds(
  uid: string,
  options: { cursor?: string | null; limit?: number } = {},
  storage: StorageAdapter = getStorage(),
): Promise<{ items: Array<Record<string, unknown>>; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(20, Math.floor(options.limit ?? 20)));
  const cursor = decodeCursor(options.cursor ?? null);
  const records = (await storage.list<AutoAddRecord>(userCol(uid, INTELLIGENCE_AUTO_ADDS)))
    .map(row => row.data)
    .filter(record => record.removedAt === null)
    .sort((a, b) => b.at.localeCompare(a.at) || b.autoAddId.localeCompare(a.autoAddId))
    .filter(record => !cursor || record.at < cursor[0] || (record.at === cursor[0] && record.autoAddId < cursor[1]));
  const page = records.slice(0, limit);
  const state = await loadDomainState(storage, uid);
  const items = page.flatMap(record => {
    const commitment = state.commitments[record.commitmentId];
    if (!commitment) return [];
    const status = statusOf(commitment);
    return [{
      autoAddId: record.autoAddId,
      commitmentId: record.commitmentId,
      title: commitment.title,
      startsAt: commitment.timeSpec.dueAt,
      evidence: record.evidence,
      at: record.at,
      status,
      removable: status === 'open' && commitmentBaselineFingerprint(commitment) === record.baseline,
    }];
  });
  return { items, nextCursor: records.length > limit && page.length ? cursorOf(page[page.length - 1]!) : null };
}

export class AutoAddEditedError extends Error {
  constructor() { super('edited'); }
}

export async function removeAutoAdd(
  uid: string,
  autoAddId: string,
  now: string,
  storage: StorageAdapter = getStorage(),
): Promise<'removed' | 'missing'> {
  return storage.runTransaction(async tx => {
    const [record, state, user, observations] = await Promise.all([
      tx.get<AutoAddRecord>(autoAddPath(uid, autoAddId)),
      loadDomainState(tx, uid),
      tx.get<Record<string, unknown>>(userDoc(uid)),
      tx.list<StoredObservation>(userCol(uid, INTELLIGENCE_OBSERVATIONS)),
    ]);
    if (!record) return 'missing';
    const commitment = state.commitments[record.commitmentId];
    if (!commitment) return 'missing';
    if (record.removedAt !== null && commitment.status === 'dropped') return 'removed';
    if (commitment.status !== 'active' || commitmentBaselineFingerprint(commitment) !== record.baseline) {
      throw new AutoAddEditedError();
    }
    const transition = applyCommand(state, { type: 'Drop', commitmentId: commitment.id, now });
    writeDomainDiff(tx, uid, state, transition.newState, transition.events as DomainEvent[], user as never, now);
    tx.set(autoAddPath(uid, autoAddId), { ...record, removedAt: now });
    const supporting = new Set(record.observationIds);
    for (const row of observations) {
      if (supporting.has(row.data.id)) tx.set(`${userCol(uid, INTELLIGENCE_OBSERVATIONS)}/${row.id}`, {
        ...row.data, review: 'dismissed', reviewedAt: now,
      });
    }
    return 'removed';
  });
}

export async function hydrateAddedFrom<T extends Commitment>(
  uid: string,
  commitments: readonly T[],
  reader: StorageReader = getStorage(),
): Promise<Array<Omit<T, 'addedFrom'> & { addedFrom?: { kind: 'email_self_reply'; evidence: string } }>> {
  const ids = Array.from(new Set(commitments.flatMap(item => item.addedFrom?.autoAddId ? [item.addedFrom.autoAddId] : [])));
  const records = new Map<string, AutoAddRecord>();
  await Promise.all(ids.map(async id => {
    const record = await reader.get<AutoAddRecord>(autoAddPath(uid, id));
    if (record) records.set(id, record);
  }));
  return commitments.map(commitment => {
    const pointer = commitment.addedFrom;
    const record = pointer ? records.get(pointer.autoAddId) : null;
    const { addedFrom: _internal, ...plain } = commitment;
    return record && record.removedAt === null
      ? { ...plain, addedFrom: { kind: 'email_self_reply' as const, evidence: record.evidence } }
      : plain;
  });
}

export async function addedFromByCommitment(
  uid: string,
  commitments: readonly Commitment[],
  reader: StorageReader = getStorage(),
): Promise<Map<string, { kind: 'email_self_reply'; evidence: string }>> {
  const hydrated = await hydrateAddedFrom(uid, commitments, reader);
  const out = new Map<string, { kind: 'email_self_reply'; evidence: string }>();
  hydrated.forEach((item, index) => { if (item.addedFrom) out.set(commitments[index]!.id, item.addedFrom); });
  return out;
}
