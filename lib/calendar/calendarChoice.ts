import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { requireLiveAccount } from '../account/accountLiveness';
import { getStorage } from '../storage';
import type { StorageAdapter, StorageTransaction } from '../storage/storageAdapter';
import {
  BUSY_SOURCE_FENCES,
  CALENDAR_CHOICE,
  CALENDAR_SOURCES,
  DEVICE_STALE_STATE,
  PLANNING_STATE_CHANGES,
  REGISTERED_DEVICE_SOURCES,
  RETIRED_DEVICE_SOURCES,
  docIdForKey,
  userCol,
  userSubDoc,
} from '../storage/paths';
import {
  deleteBusySource,
  firstDeviceBusySourceId,
  listBusyBlocksOfSource,
  sourceKindOf,
  type BusySourceReplacementFence,
  type CalendarSource,
} from './busyBlocks';
import { M5A_CONTROLS_PATH, parseM5aControls, resolveM5aCapabilities } from '../release/m5aControls';
import { GOOGLE_BUSY_SOURCE_ID } from '../integrations/google/googleConfig';
import { PLANNING_STATE_CHANGE_SCHEMA_VERSION, type PlanningStateChange } from '../../src/contracts/v1/watcherContracts';

export const CALENDAR_CHOICE_VERSION = 1;
export const SOURCE_SECRET_HEADER = 'x-maybesitter-source-secret';
const PHONE_LIMIT = 20;
const LEASE_MS = 120_000;

type CalendarChoiceTestHook = (
  point: 'purge_page_deleted' | 'retirement_claimed',
  context: { readonly uid: string; readonly sourceId: string },
) => Promise<void>;
let calendarChoiceTestHook: CalendarChoiceTestHook | null = null;

/** Test-only pause seam for lease takeover and stale-owner mutations. */
export function setCalendarChoiceTestHookForTests(hook: CalendarChoiceTestHook | null): void {
  calendarChoiceTestHook = hook;
}

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

interface SelectionFence extends BusySourceReplacementFence {
  readonly generation: number;
  readonly currentEpoch: number;
  readonly intentId: string;
  readonly opId: string;
  readonly operation: 'upload' | 'clear' | 'retire';
  readonly selectionDigest: string;
  readonly leaseUntil: string;
}

type SourceRow = CalendarSource & {
  readonly status?: 'uploading' | 'active' | 'clearing' | 'retiring';
};

interface DeviceStaleState {
  readonly choiceGeneration: number;
  readonly sourceId: string;
  readonly fenceGeneration: number;
  readonly failureStartedAt: string | null;
  readonly version: number;
}

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
function retiredSourcePath(uid: string, sourceId: string): string {
  return userSubDoc(uid, RETIRED_DEVICE_SOURCES, `source_${docIdForKey(sourceId)}`);
}
function fencePath(uid: string, sourceId: string): string {
  return userSubDoc(uid, BUSY_SOURCE_FENCES, docIdForKey(sourceId));
}
function sourcePath(uid: string, sourceId: string): string {
  return userSubDoc(uid, CALENDAR_SOURCES, docIdForKey(sourceId));
}
function staleStatePath(uid: string, sourceId: string): string {
  return userSubDoc(uid, DEVICE_STALE_STATE, docIdForKey(sourceId));
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

async function markGoogleCoverageStale(tx: StorageTransaction, uid: string): Promise<void> {
  const google = await tx.get<CalendarSource>(sourcePath(uid, GOOGLE_BUSY_SOURCE_ID));
  if (!google) return;
  const { m5Certificate: _certificate, ...withoutCertificate } = google;
  tx.set<CalendarSource>(sourcePath(uid, GOOGLE_BUSY_SOURCE_ID), {
    ...withoutCertificate,
    coverageStatus: 'stale',
  });
}

async function writeDeviceStaleState(
  tx: StorageTransaction,
  uid: string,
  sourceId: string,
  choiceGeneration: number,
  failureStartedAt: string | null = null,
): Promise<void> {
  const [prior, fence] = await Promise.all([
    tx.get<DeviceStaleState>(staleStatePath(uid, sourceId)),
    tx.get<BusySourceReplacementFence>(fencePath(uid, sourceId)),
  ]);
  tx.set<DeviceStaleState>(staleStatePath(uid, sourceId), {
    choiceGeneration,
    sourceId,
    fenceGeneration: fence?.generation ?? 0,
    failureStartedAt,
    version: (prior?.version ?? 0) + 1,
  });
}

function activationChange(uid: string, sourceId: string, at: string): PlanningStateChange & {
  readonly kind: 'busy_source_activated'; readonly sourceId: string;
} {
  const changeId = `calendar:${docIdForKey(JSON.stringify(['busy_source_activated', sourceId, randomUUID()]))}`;
  return {
    schemaVersion: PLANNING_STATE_CHANGE_SCHEMA_VERSION,
    changeId,
    scopeId: uid,
    source: 'calendar',
    entityId: sourceId,
    occurredAt: at,
    changedFields: ['busy_source_activated'],
    beforeDigest: null,
    afterDigest: sha(JSON.stringify(['busy_source_activated', sourceId, at])),
    provenanceRef: `calendar-source-activation:${docIdForKey(sourceId)}`,
    kind: 'busy_source_activated',
    sourceId,
  };
}

async function requirePurgeFence(
  tx: StorageTransaction,
  uid: string,
  expected: CalendarChoiceState & { state: 'purging'; purge: NonNullable<CalendarChoiceState['purge']> },
): Promise<CalendarChoiceState & { state: 'purging'; purge: NonNullable<CalendarChoiceState['purge']> }> {
  const current = await tx.get<CalendarChoiceState>(choicePath(uid));
  if (!current || current.state !== 'purging' || !current.purge
    || current.generation !== expected.generation
    || current.purge.owner !== expected.purge.owner
    || current.purge.version !== expected.purge.version) {
    throw new CalendarChoiceError('calendar_choice_purging');
  }
  return current as CalendarChoiceState & { state: 'purging'; purge: NonNullable<CalendarChoiceState['purge']> };
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
    // The account deletion fence (#772), in every transaction here that writes
    // under the account: a choice, a registration, a fence or a source row
    // written after the account was swept would re-create documents under it.
    await requireLiveAccount(tx, uid);
    const existing = await tx.get<CalendarChoiceState>(choicePath(uid));
    if (activeChoice(existing)) return existing;
    const controls = parseM5aControls(await tx.get(M5A_CONTROLS_PATH));
    if (!controls?.calendar.enabled || controls.calendar.epoch !== calendarEpoch) throw new CalendarChoiceError('calendar_choice_unavailable');
    if (existing?.state === 'purging') {
      if (Date.parse(existing.purge?.leaseUntil ?? '') > now.getTime()) return existing;
      await markGoogleCoverageStale(tx, uid);
      const taken: CalendarChoiceState = {
        ...existing,
        purge: { owner, leaseUntil: new Date(now.getTime() + LEASE_MS).toISOString(), cursor: existing.purge?.cursor ?? null, version: (existing.purge?.version ?? 0) + 1 },
      };
      tx.set(choicePath(uid), taken);
      return taken;
    }
    await markGoogleCoverageStale(tx, uid);
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

  while (state.state === 'purging' && state.purge?.owner === owner) {
    const expected = state as CalendarChoiceState & { state: 'purging'; purge: NonNullable<CalendarChoiceState['purge']> };
    const [sourceRows, orphanSourceId] = await Promise.all([
      storage.list<SourceRow>(userCol(uid, CALENDAR_SOURCES), { where: [['kind', '==', 'device']], limit: 1 }),
      firstDeviceBusySourceId(uid, { storage }),
    ]);
    const registeredSourceId = sourceRows[0]?.data.sourceId ?? null;
    const sourceId = registeredSourceId ?? orphanSourceId;
    if (registeredSourceId !== null) {
      await deleteBusySource(uid, registeredSourceId, {
        storage,
        now,
        transactionGuard: async (tx) => { await requirePurgeFence(tx, uid, expected); },
      });
    } else if (orphanSourceId !== null) {
      await deleteBusySource(uid, orphanSourceId, {
        storage,
        now,
        transactionGuard: async (tx) => { await requirePurgeFence(tx, uid, expected); },
      });
    }
    if (sourceId !== null) {
      if (calendarChoiceTestHook) await calendarChoiceTestHook('purge_page_deleted', { uid, sourceId });
      state = await storage.runTransaction(async (tx) => {
        await requireLiveAccount(tx, uid);
        const [current, controls] = await Promise.all([
          requirePurgeFence(tx, uid, expected),
          tx.get(M5A_CONTROLS_PATH),
        ]);
        const parsed = parseM5aControls(controls);
        if (!parsed?.calendar.enabled || parsed.calendar.epoch !== calendarEpoch) throw new CalendarChoiceError('calendar_choice_unavailable');
        const advanced: CalendarChoiceState = {
          ...current,
          purge: {
            ...current.purge,
            cursor: sourceId,
            version: current.purge.version + 1,
            leaseUntil: new Date(Date.now() + LEASE_MS).toISOString(),
          },
        };
        tx.set(choicePath(uid), advanced);
        return advanced;
      });
      continue;
    }

    state = await storage.runTransaction(async (tx) => {
      await requireLiveAccount(tx, uid);
      const [current, controls] = await Promise.all([
        requirePurgeFence(tx, uid, expected),
        tx.get(M5A_CONTROLS_PATH),
      ]);
      const parsed = parseM5aControls(controls);
      if (!parsed?.calendar.enabled || parsed.calendar.epoch !== calendarEpoch) throw new CalendarChoiceError('calendar_choice_unavailable');
      const active: CalendarChoiceState = { ...current, state: 'active', purge: null };
      tx.set(choicePath(uid), active);
      return active;
    });
  }

  if (state.state === 'active') {
    const registrations = await storage.list<DeviceRegistration>(userCol(uid, REGISTERED_DEVICE_SOURCES), { limit: PHONE_LIMIT + 1 });
    for (const { data: registration } of registrations) {
      await storage.runTransaction(async (tx) => {
        await requireLiveAccount(tx, uid);
        await writeDeviceStaleState(tx, uid, registration.sourceId, state.generation);
      });
    }
  }
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
    await requireLiveAccount(tx, uid);
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
    await writeDeviceStaleState(tx, uid, sourceId, choice.generation);
    tx.create(registrationPath(uid, sourceId), registration);
    return sourceId;
  });
}

async function retiredSource(tx: StorageTransaction, uid: string, sourceId: string): Promise<boolean> {
  return Boolean(await tx.get<{ sourceId: string }>(retiredSourcePath(uid, sourceId)));
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
    await requireLiveAccount(tx, uid);
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
    if (operation === 'clear') await markGoogleCoverageStale(tx, uid);
    if (operation === 'upload' && !source) {
      tx.set(sourcePath(uid, sourceId), {
        sourceId, kind: 'device', platform: null,
        lastSyncedAt: now.toISOString(), windowStart: now.toISOString(), windowEnd: now.toISOString(),
        status: 'uploading', choiceGeneration: choice.generation, lastUploadAt: null,
        coverageStatus: 'refreshing',
        upload: { owner: opId, leaseUntil: fence.leaseUntil, selectionEpoch: epoch },
      } satisfies SourceRow);
    } else if (operation === 'upload' && source) {
      tx.set(sourcePath(uid, sourceId), {
        ...source,
        status: source.status === 'uploading' ? 'uploading' : 'active',
        coverageStatus: 'refreshing',
        upload: { owner: opId, leaseUntil: fence.leaseUntil, selectionEpoch: epoch },
      });
    } else if (operation === 'clear' && source) {
      tx.set(sourcePath(uid, sourceId), { ...source, status: 'clearing', coverageStatus: 'clearing', upload: null });
    }
    tx.set(fencePath(uid, sourceId), { ...(prior ?? {}), ...fence });
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
    await requireLiveAccount(tx, uid);
    const current = await tx.get<SourceRow>(sourcePath(uid, sourceId));
    const finalized = await finishDeviceUploadInTransaction(tx, uid, sourceId, secret, opId, epoch, source, current);
    tx.set(sourcePath(uid, sourceId), {
      ...(current ?? {}),
      ...source,
      ...finalized,
    } satisfies SourceRow);
  });
}

export async function finishDeviceUploadInTransaction(
  tx: StorageTransaction,
  uid: string,
  sourceId: string,
  secret: string,
  opId: string,
  epoch: number,
  source: CalendarSource,
  current: SourceRow | null,
): Promise<Partial<CalendarSource>> {
  const { choice } = await validateSelectionContinuationInTransaction(tx, uid, sourceId, secret, 'upload', opId, epoch);
  await writeDeviceStaleState(tx, uid, sourceId, choice.generation);
  if (current?.status === 'uploading') {
    const change = activationChange(uid, sourceId, source.lastSyncedAt);
    tx.set(userSubDoc(uid, PLANNING_STATE_CHANGES, docIdForKey(change.changeId)), change);
  }
  return {
    status: 'active',
    choiceGeneration: choice.generation,
    lastUploadAt: source.lastSyncedAt,
    coverageStatus: 'settled',
    upload: null,
  };
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
  await storage.runTransaction(async (tx) => {
    await requireLiveAccount(tx, uid);
    const { choice } = await validateSelectionContinuationInTransaction(tx, uid, sourceId, secret, 'clear', opId, epoch);
    await writeDeviceStaleState(tx, uid, sourceId, choice.generation);
  });
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
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const claim = await storage.runTransaction(async (tx) => {
    await requireLiveAccount(tx, uid);
    const choice = await tx.get<CalendarChoiceState>(choicePath(uid));
    if (!choice) throw new CalendarChoiceError('calendar_choice_required');
    const found = await tx.get<DeviceRegistration>(registrationPath(uid, sourceId));
    if (!found) {
      if (await retiredSource(tx, uid, sourceId)) return null;
      throw new CalendarChoiceError('source_unregistered');
    }
    const prior = await tx.get<SelectionFence>(fencePath(uid, sourceId));
    const source = await tx.get<SourceRow>(sourcePath(uid, sourceId));
    await markGoogleCoverageStale(tx, uid);
    if (found.state === 'retiring' && Date.parse(prior?.leaseUntil ?? '') > nowDate.getTime()) return null;
    const currentEpoch = (prior?.currentEpoch ?? 0) + 1;
    const opId = randomUUID();
    tx.set(registrationPath(uid, sourceId), { ...found, state: 'retiring' });
    tx.set(retiredPath(uid, found.sourceInstallationId), { sourceId, retiredAt: now });
    tx.set(retiredSourcePath(uid, sourceId), { sourceId, retiredAt: now });
    tx.set(fencePath(uid, sourceId), {
      ...(prior ?? {}),
      generation: choice.generation, currentEpoch: (prior?.currentEpoch ?? 0) + 1,
      intentId: randomUUID(), opId, operation: 'retire', selectionDigest: '',
      leaseUntil: new Date(nowDate.getTime() + LEASE_MS).toISOString(),
    } satisfies SelectionFence);
    if (source) tx.set(sourcePath(uid, sourceId), { ...source, status: 'retiring', coverageStatus: 'clearing', upload: null });
    return { registration: found, currentEpoch, opId };
  });
  if (!claim) return 0;
  if (calendarChoiceTestHook) await calendarChoiceTestHook('retirement_claimed', { uid, sourceId });
  const retirementGuard = async (tx: StorageTransaction): Promise<void> => {
    const [registration, fence] = await Promise.all([
      tx.get<DeviceRegistration>(registrationPath(uid, sourceId)),
      tx.get<SelectionFence>(fencePath(uid, sourceId)),
    ]);
    if (registration?.state !== 'retiring' || fence?.operation !== 'retire'
      || fence.opId !== claim.opId || fence.currentEpoch !== claim.currentEpoch) {
      throw new CalendarChoiceError('selection_stale', fence?.currentEpoch ?? 0);
    }
  };
  const result = await deleteBusySource(uid, sourceId, { storage, transactionGuard: retirementGuard });
  await storage.runTransaction(async (tx) => {
    await retirementGuard(tx);
    tx.delete(registrationPath(uid, sourceId));
    tx.delete(staleStatePath(uid, sourceId));
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
        const retired = await storage.get<{ sourceId: string }>(retiredSourcePath(uid, sourceId));
        if (retired?.sourceId === sourceId) sourceStatus = 'revoked';
      }
      const fence = await storage.get<SelectionFence>(fencePath(uid, sourceId));
      sourceEpoch = fence?.currentEpoch ?? null;
    }
  }
  return { enrolled: Boolean(choice), state: choice?.state ?? null, sourceStatus, sourceEpoch };
}
