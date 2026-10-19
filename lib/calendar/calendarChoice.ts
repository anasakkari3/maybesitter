import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { getStorage } from '../storage';
import type { StorageAdapter, StorageTransaction } from '../storage/storageAdapter';
import {
  BUSY_SOURCE_FENCES,
  CALENDAR_CHOICE,
  CALENDAR_SOURCES,
  REGISTERED_DEVICE_SOURCES,
  RETIRED_DEVICE_SOURCES,
  docIdForKey,
  userCol,
  userSubDoc,
} from '../storage/paths';
import { deleteBusySource, listBusyBlocksOfSource, listBusySourceIdsByKind, sourceKindOf, type CalendarSource } from './busyBlocks';
import { M5A_CONTROLS_PATH, parseM5aControls, resolveM5aCapabilities } from '../release/m5aControls';

export const CALENDAR_CHOICE_VERSION = 1;
export const SOURCE_SECRET_HEADER = 'x-maybesitter-source-secret';
const PHONE_LIMIT = 20;
const LEASE_MS = 120_000;

export interface CalendarChoiceState {
  readonly v: 1;
  readonly generation: number;
  readonly state: 'purging' | 'active';
  readonly enrolledAt: string;
  readonly purge: { owner: string; leaseUntil: string; cursor: string | null; version: number } | null;
}

export interface DeviceRegistration {
  readonly sourceId: string;
  readonly sourceInstallationId: string;
  readonly secretHash: string;
  readonly secretVersion: 1;
  readonly state: 'active' | 'retiring';
  readonly registeredAt: string;
}

interface SelectionFence {
  readonly generation: number;
  readonly currentEpoch: number;
  readonly intentId: string;
  readonly opId: string;
  readonly operation: 'upload' | 'clear' | 'retire';
  readonly selectionDigest: string;
  readonly leaseUntil: string;
}

type SourceRow = CalendarSource & {
  status?: 'uploading' | 'active' | 'clearing' | 'retiring';
  choiceGeneration?: number;
  lastUploadAt?: string | null;
};

export class CalendarChoiceError extends Error {
  constructor(
    readonly code: 'calendar_choice_required' | 'calendar_choice_purging' | 'calendar_choice_unavailable'
      | 'source_revoked' | 'source_unregistered' | 'source_forbidden' | 'source_secret_invalid'
      | 'too_many_phones' | 'selection_stale' | 'invalid_request' | 'epoch_exhausted',
    readonly currentEpoch?: number,
  ) { super(code); this.name = 'CalendarChoiceError'; }
}

function choicePath(uid: string): string { return userSubDoc(uid, CALENDAR_CHOICE, 'state'); }
function registrationPath(uid: string, sourceId: string): string {
  return userSubDoc(uid, REGISTERED_DEVICE_SOURCES, docIdForKey(sourceId));
}
function retiredPath(uid: string, installationId: string): string {
  return userSubDoc(uid, RETIRED_DEVICE_SOURCES, docIdForKey(installationId));
}
function fencePath(uid: string, sourceId: string): string {
  return userSubDoc(uid, BUSY_SOURCE_FENCES, docIdForKey(sourceId));
}
function sourcePath(uid: string, sourceId: string): string {
  return userSubDoc(uid, CALENDAR_SOURCES, docIdForKey(sourceId));
}
function sha(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function safeSecretMatch(stored: string, presented: string): boolean {
  const actual = Buffer.from(sha(presented));
  const expected = Buffer.from(stored);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function nonEmpty(value: unknown, max = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function activeChoice(value: CalendarChoiceState | null): value is CalendarChoiceState & { state: 'active' } {
  return value?.v === 1 && value.state === 'active' && Number.isSafeInteger(value.generation) && value.generation >= 1;
}

export async function readCalendarChoice(uid: string, storage: StorageAdapter = getStorage()): Promise<CalendarChoiceState | null> {
  const value = await storage.get<CalendarChoiceState>(choicePath(uid));
  if (!value || value.v !== 1 || !Number.isSafeInteger(value.generation) || value.generation < 1) return null;
  if (value.state !== 'active' && value.state !== 'purging') return null;
  return value;
}

/** First enrollment is a durable purging barrier; retries finish the same generation. */
export async function enrollCalendarChoice(uid: string, storage: StorageAdapter = getStorage()): Promise<CalendarChoiceState> {
  const resolved = await resolveM5aCapabilities({ storage });
  if (!resolved.calendarChoice || !resolved.controls) throw new CalendarChoiceError('calendar_choice_unavailable');
  const calendarEpoch = resolved.controls.calendar.epoch;
  const now = new Date();
  const owner = randomUUID();
  let state = await storage.runTransaction(async (tx) => {
    const existing = await tx.get<CalendarChoiceState>(choicePath(uid));
    if (activeChoice(existing)) return existing;
    const controls = parseM5aControls(await tx.get(M5A_CONTROLS_PATH));
    if (!controls?.calendar.enabled || controls.calendar.epoch !== calendarEpoch) throw new CalendarChoiceError('calendar_choice_unavailable');
    if (existing?.state === 'purging') {
      if (Date.parse(existing.purge?.leaseUntil ?? '') > now.getTime()) return existing;
      const taken: CalendarChoiceState = {
        ...existing,
        purge: { owner, leaseUntil: new Date(now.getTime() + LEASE_MS).toISOString(), cursor: existing.purge?.cursor ?? null, version: (existing.purge?.version ?? 0) + 1 },
      };
      tx.set(choicePath(uid), taken);
      return taken;
    }
    const created: CalendarChoiceState = {
      v: 1, generation: 1, state: 'purging', enrolledAt: now.toISOString(),
      purge: { owner, leaseUntil: new Date(now.getTime() + LEASE_MS).toISOString(), cursor: null, version: 1 },
    };
    tx.create(choicePath(uid), created);
    return created;
  });
  if (state.state === 'active') return state;
  // An unexpired owner may be another request. Its retry will finish; report the durable state.
  if (state.purge?.owner !== owner && Date.parse(state.purge?.leaseUntil ?? '') > now.getTime()) return state;

  const sources = await storage.list<SourceRow>(userCol(uid, CALENDAR_SOURCES));
  for (const row of sources) if (row.data.sourceId.startsWith('device:')) await deleteBusySource(uid, row.data.sourceId, { storage, now });
  // A crashed pre-enrolment upload may have blocks but no source document.
  const deviceSourceIds = await listBusySourceIdsByKind(uid, 'device', { storage });
  for (const sourceId of deviceSourceIds) {
    if (!sources.some((row) => row.data.sourceId === sourceId)) await deleteBusySource(uid, sourceId, { storage, now });
  }

  state = await storage.runTransaction(async (tx) => {
    const current = await tx.get<CalendarChoiceState>(choicePath(uid));
    const controls = parseM5aControls(await tx.get(M5A_CONTROLS_PATH));
    if (!controls?.calendar.enabled || controls.calendar.epoch !== calendarEpoch) throw new CalendarChoiceError('calendar_choice_unavailable');
    if (!current || current.generation !== state.generation || current.state !== 'purging' || current.purge?.owner !== owner) {
      if (activeChoice(current)) return current;
      throw new CalendarChoiceError('calendar_choice_purging');
    }
    const active: CalendarChoiceState = { ...current, state: 'active', purge: null };
    tx.set(choicePath(uid), active);
    return active;
  });
  return state;
}

async function findRegistrationByInstallation(
  tx: StorageTransaction,
  uid: string,
  sourceInstallationId: string,
): Promise<DeviceRegistration | null> {
  const rows = await tx.list<DeviceRegistration>(userCol(uid, REGISTERED_DEVICE_SOURCES), { limit: PHONE_LIMIT + 1 });
  return rows.find((row) => row.data.sourceInstallationId === sourceInstallationId)?.data ?? null;
}

export async function registerDeviceSource(
  uid: string,
  input: { sourceInstallationId: unknown; sourceSecret: unknown; registrationId: unknown },
  storage: StorageAdapter = getStorage(),
): Promise<string> {
  if (!nonEmpty(input.sourceInstallationId, 200) || !nonEmpty(input.sourceSecret, 1024) || input.sourceSecret.length < 24
    || !nonEmpty(input.registrationId, 200)) throw new CalendarChoiceError('invalid_request');
  const sourceInstallationId = input.sourceInstallationId;
  const sourceSecret = input.sourceSecret;
  const now = new Date().toISOString();
  return storage.runTransaction(async (tx) => {
    const choice = await tx.get<CalendarChoiceState>(choicePath(uid));
    const retired = await tx.get<{ sourceId: string }>(retiredPath(uid, sourceInstallationId));
    if (retired) throw new CalendarChoiceError('source_revoked');
    if (!activeChoice(choice)) throw new CalendarChoiceError(choice?.state === 'purging' ? 'calendar_choice_purging' : 'calendar_choice_required');
    const existing = await findRegistrationByInstallation(tx, uid, sourceInstallationId);
    if (existing) {
      if (existing.state !== 'active') throw new CalendarChoiceError('source_revoked');
      if (!safeSecretMatch(existing.secretHash, sourceSecret)) throw new CalendarChoiceError('source_secret_invalid');
      return existing.sourceId;
    }
    const registrations = await tx.list<DeviceRegistration>(userCol(uid, REGISTERED_DEVICE_SOURCES), { limit: PHONE_LIMIT + 1 });
    if (registrations.length >= PHONE_LIMIT) throw new CalendarChoiceError('too_many_phones');
    const sourceId = `device:${randomUUID()}`;
    const registration: DeviceRegistration = {
      sourceId, sourceInstallationId, secretHash: sha(sourceSecret),
      secretVersion: 1, state: 'active', registeredAt: now,
    };
    tx.create(registrationPath(uid, sourceId), registration);
    return sourceId;
  });
}

async function retiredSource(tx: StorageTransaction, uid: string, sourceId: string): Promise<boolean> {
  const rows = await tx.list<{ sourceId: string }>(userCol(uid, RETIRED_DEVICE_SOURCES), { limit: PHONE_LIMIT + 1 });
  return rows.some((row) => row.data.sourceId === sourceId);
}

async function authorizeRegistration(tx: StorageTransaction, uid: string, sourceId: string, secret: string): Promise<DeviceRegistration> {
  if (sourceKindOf(sourceId) !== 'device') throw new CalendarChoiceError('source_forbidden');
  const registration = await tx.get<DeviceRegistration>(registrationPath(uid, sourceId));
  if (!registration) {
    if (await retiredSource(tx, uid, sourceId)) throw new CalendarChoiceError('source_revoked');
    throw new CalendarChoiceError('source_unregistered');
  }
  if (registration.state !== 'active') throw new CalendarChoiceError('source_revoked');
  if (!safeSecretMatch(registration.secretHash, secret)) throw new CalendarChoiceError('source_secret_invalid');
  return registration;
}

export async function startSelectionIntent(
  uid: string,
  input: { sourceId: unknown; intentId: unknown; operation: unknown; selectionDigest: unknown; choiceVersion: unknown },
  secret: string,
  storage: StorageAdapter = getStorage(),
): Promise<{ opId: string; epoch: number; intentId: string }> {
  if (!nonEmpty(input.sourceId, 200) || !nonEmpty(input.intentId, 200) || !nonEmpty(input.selectionDigest, 128)
    || (input.operation !== 'upload' && input.operation !== 'clear') || input.choiceVersion !== 1 || !nonEmpty(secret, 1024)) {
    throw new CalendarChoiceError('invalid_request');
  }
  const sourceId = input.sourceId;
  const intentId = input.intentId;
  const selectionDigest = input.selectionDigest;
  const operation = input.operation;
  const now = new Date();
  return storage.runTransaction(async (tx) => {
    const choice = await tx.get<CalendarChoiceState>(choicePath(uid));
    if (!activeChoice(choice)) throw new CalendarChoiceError(choice?.state === 'purging' ? 'calendar_choice_purging' : 'calendar_choice_required');
    await authorizeRegistration(tx, uid, sourceId, secret);
    const prior = await tx.get<SelectionFence>(fencePath(uid, sourceId));
    if (prior && prior.intentId === intentId) return { opId: prior.opId, epoch: prior.currentEpoch, intentId: prior.intentId };
    const epoch = (prior?.currentEpoch ?? 0) + 1;
    if (!Number.isSafeInteger(epoch)) throw new CalendarChoiceError('epoch_exhausted');
    const opId = randomUUID();
    const fence: SelectionFence = {
      generation: choice.generation, currentEpoch: epoch, intentId, opId,
      operation, selectionDigest,
      leaseUntil: new Date(now.getTime() + LEASE_MS).toISOString(),
    };
    const source = await tx.get<SourceRow>(sourcePath(uid, sourceId));
    if (operation === 'upload' && !source) {
      tx.set(sourcePath(uid, sourceId), {
        sourceId, kind: 'device', platform: null,
        lastSyncedAt: now.toISOString(), windowStart: now.toISOString(), windowEnd: now.toISOString(),
        status: 'uploading', choiceGeneration: choice.generation, lastUploadAt: null,
      } satisfies SourceRow);
    } else if (operation === 'clear' && source) {
      tx.set(sourcePath(uid, sourceId), { ...source, status: 'clearing' });
    }
    tx.set(fencePath(uid, sourceId), fence);
    return { opId, epoch, intentId };
  });
}

export async function validateSelectionContinuation(
  uid: string,
  sourceId: string,
  secret: string,
  operation: 'upload' | 'clear',
  opId: unknown,
  epoch: unknown,
  storage: StorageAdapter = getStorage(),
): Promise<{ choice: CalendarChoiceState; fence: SelectionFence }> {
  if (!nonEmpty(opId, 200) || !Number.isSafeInteger(epoch) || (epoch as number) < 1 || !nonEmpty(secret, 1024)) {
    throw new CalendarChoiceError('invalid_request');
  }
  return storage.runTransaction(async (tx) => {
    const choice = await tx.get<CalendarChoiceState>(choicePath(uid));
    if (!activeChoice(choice)) throw new CalendarChoiceError(choice?.state === 'purging' ? 'calendar_choice_purging' : 'calendar_choice_required');
    await authorizeRegistration(tx, uid, sourceId, secret);
    const fence = await tx.get<SelectionFence>(fencePath(uid, sourceId));
    if (!fence || fence.currentEpoch !== epoch || fence.opId !== opId || fence.operation !== operation || fence.generation !== choice.generation) {
      throw new CalendarChoiceError('selection_stale', fence?.currentEpoch ?? 0);
    }
    return { choice, fence };
  });
}

export async function finishDeviceUpload(
  uid: string, sourceId: string, secret: string, opId: string, epoch: number,
  source: CalendarSource, storage: StorageAdapter = getStorage(),
): Promise<void> {
  await storage.runTransaction(async (tx) => {
    const { choice } = await validateSelectionContinuationInTransaction(tx, uid, sourceId, secret, 'upload', opId, epoch);
    tx.set(sourcePath(uid, sourceId), { ...source, status: 'active', choiceGeneration: choice.generation, lastUploadAt: source.lastSyncedAt } satisfies SourceRow);
  });
}

export async function validateSelectionContinuationInTransaction(
  tx: StorageTransaction, uid: string, sourceId: string, secret: string,
  operation: 'upload' | 'clear', opId: string, epoch: number,
): Promise<{ choice: CalendarChoiceState; fence: SelectionFence }> {
  const choice = await tx.get<CalendarChoiceState>(choicePath(uid));
  if (!activeChoice(choice)) throw new CalendarChoiceError(choice?.state === 'purging' ? 'calendar_choice_purging' : 'calendar_choice_required');
  await authorizeRegistration(tx, uid, sourceId, secret);
  const fence = await tx.get<SelectionFence>(fencePath(uid, sourceId));
  if (!fence || fence.currentEpoch !== epoch || fence.opId !== opId || fence.operation !== operation || fence.generation !== choice.generation) {
    throw new CalendarChoiceError('selection_stale', fence?.currentEpoch ?? 0);
  }
  return { choice, fence };
}

export async function finishDeviceClear(
  uid: string, sourceId: string, secret: string, opId: string, epoch: number,
  storage: StorageAdapter = getStorage(),
): Promise<void> {
  await storage.runTransaction(async (tx) => { await validateSelectionContinuationInTransaction(tx, uid, sourceId, secret, 'clear', opId, epoch); });
  await deleteBusySource(uid, sourceId, {
    storage,
    transactionGuard: async (tx) => {
      await validateSelectionContinuationInTransaction(tx, uid, sourceId, secret, 'clear', opId, epoch);
    },
  });
  // Re-check after the multi-row delete so a newer intent cannot be settled by this runner.
  await storage.runTransaction(async (tx) => { await validateSelectionContinuationInTransaction(tx, uid, sourceId, secret, 'clear', opId, epoch); });
}

export async function listRegisteredDeviceSources(uid: string, storage: StorageAdapter = getStorage()) {
  const choice = await readCalendarChoice(uid, storage);
  if (!choice) throw new CalendarChoiceError('calendar_choice_required');
  const registrations = await storage.list<DeviceRegistration>(userCol(uid, REGISTERED_DEVICE_SOURCES), { limit: PHONE_LIMIT + 1 });
  return Promise.all(registrations.map(async ({ data: registration }) => {
    const source = await storage.get<SourceRow>(sourcePath(uid, registration.sourceId));
    const count = (await listBusyBlocksOfSource(uid, registration.sourceId, { storage })).length;
    return {
      sourceId: registration.sourceId,
      status: registration.state === 'retiring' ? 'retiring' : source?.status ?? (source ? 'active' : 'registered'),
      platform: source?.platform === 'ios' || source?.platform === 'android' ? source.platform : null,
      lastUploadAt: source?.lastUploadAt ?? (source?.status === 'active' ? source.lastSyncedAt : null),
      blockCount: count,
    };
  }));
}

export async function retireDeviceSource(uid: string, sourceId: string, storage: StorageAdapter = getStorage()): Promise<number> {
  if (sourceKindOf(sourceId) !== 'device') throw new CalendarChoiceError('source_forbidden');
  const now = new Date().toISOString();
  const registration = await storage.runTransaction(async (tx) => {
    const choice = await tx.get<CalendarChoiceState>(choicePath(uid));
    if (!choice) throw new CalendarChoiceError('calendar_choice_required');
    const found = await tx.get<DeviceRegistration>(registrationPath(uid, sourceId));
    if (!found) {
      if (await retiredSource(tx, uid, sourceId)) return null;
      throw new CalendarChoiceError('source_unregistered');
    }
    const prior = await tx.get<SelectionFence>(fencePath(uid, sourceId));
    const source = await tx.get<SourceRow>(sourcePath(uid, sourceId));
    tx.set(registrationPath(uid, sourceId), { ...found, state: 'retiring' });
    tx.set(retiredPath(uid, found.sourceInstallationId), { sourceId, retiredAt: now });
    tx.set(fencePath(uid, sourceId), {
      generation: choice.generation, currentEpoch: (prior?.currentEpoch ?? 0) + 1,
      intentId: randomUUID(), opId: randomUUID(), operation: 'retire', selectionDigest: '',
      leaseUntil: new Date(Date.now() + LEASE_MS).toISOString(),
    } satisfies SelectionFence);
    if (source) tx.set(sourcePath(uid, sourceId), { ...source, status: 'retiring' });
    return found;
  });
  if (!registration) return 0;
  const result = await deleteBusySource(uid, sourceId, { storage });
  await storage.runTransaction(async (tx) => {
    const current = await tx.get<DeviceRegistration>(registrationPath(uid, sourceId));
    if (current?.state === 'retiring') tx.delete(registrationPath(uid, sourceId));
  });
  return result.deleted;
}

export async function calendarChoiceProbe(uid: string, sourceId: string | null, storage: StorageAdapter = getStorage()) {
  const choice = await readCalendarChoice(uid, storage);
  let sourceStatus: 'active' | 'revoked' | null = null;
  let sourceEpoch: number | null = null;
  if (sourceId) {
    if (sourceId.startsWith('device:')) {
      const registration = await storage.get<DeviceRegistration>(registrationPath(uid, sourceId));
      sourceStatus = registration?.state === 'active' ? 'active' : null;
      if (!sourceStatus) {
        const retired = await storage.list<{ sourceId: string }>(userCol(uid, RETIRED_DEVICE_SOURCES), { limit: PHONE_LIMIT + 1 });
        if (retired.some((row) => row.data.sourceId === sourceId)) sourceStatus = 'revoked';
      }
      const fence = await storage.get<SelectionFence>(fencePath(uid, sourceId));
      sourceEpoch = fence?.currentEpoch ?? null;
    }
  }
  return { enrolled: Boolean(choice), state: choice?.state ?? null, sourceStatus, sourceEpoch };
}
