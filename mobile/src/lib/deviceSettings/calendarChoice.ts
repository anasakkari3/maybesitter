import AsyncStorage from '@react-native-async-storage/async-storage';
import { clearCachedBusyBlocksOf, inclusionGenerationKey } from './calendarBusy';

/**
 * What this phone keeps about the person's calendar choice (M5a R1.1), per
 * account. Ids, markers and one pending operation — never a calendar title,
 * an event, or the source secret (that lives in the secure store,
 * `sourceCredential.ts`).
 *
 * Unlike the older calendar keys, a read failure here is not "nothing": an
 * unreadable inclusion list or marker blocks every device read (M5A-011), so
 * the loaders that guard a read throw instead of answering empty.
 */
export const calendarChoiceKeys = {
  included: (uid: string) => `calendar.includedCalendarIds.v1:${uid}`,
  enrolledAt: (uid: string) => `calendar.choiceEnrolledAt.v1:${uid}`,
  choicePending: (uid: string) => `calendar.choicePending.v1:${uid}`,
  pendingSelection: (uid: string) => `calendar.pendingSelection.v1:${uid}`,
  phoneRemoved: (uid: string) => `calendar.phoneRemoved.v1:${uid}`,
  removedInstallation: (uid: string) => `calendar.removedInstallation.v1:${uid}`,
  rejoinInstallation: (uid: string) => `calendar.rejoinInstallation.v1:${uid}`,
  sourceId: (uid: string) => `calendar.sourceId.v1:${uid}`,
  inclusionGeneration: inclusionGenerationKey,
} as const;

/** Every member a non-empty id, or the whole list is unreadable: a filtered list is not the one the person chose. */
function ids(raw: string | null): string[] {
  if (raw === null) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === 'string' && id !== '')) {
    throw new Error('unreadable inclusion list');
  }
  return [...new Set(parsed as string[])];
}

function isInstant(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

/** The calendars this account reads on this phone. Throws when unreadable. */
export async function loadIncludedCalendarIds(uid: string): Promise<string[]> {
  return ids(await AsyncStorage.getItem(calendarChoiceKeys.included(uid)));
}

/** Throws when unreadable: an unknown marker blocks reads like an unknown list. */
export async function loadChoiceEnrolledAt(uid: string): Promise<string | null> {
  const value = await AsyncStorage.getItem(calendarChoiceKeys.enrolledAt(uid));
  if (value !== null && !isInstant(value)) throw new Error('unreadable enrolment marker');
  return value;
}

export async function loadChoicePending(uid: string): Promise<string | null> {
  return AsyncStorage.getItem(calendarChoiceKeys.choicePending(uid));
}

/** Awaited before enrolment starts; a failure stops it (M5A-R9-004). */
export async function saveChoicePending(uid: string, at: Date): Promise<void> {
  await AsyncStorage.setItem(calendarChoiceKeys.choicePending(uid), at.toISOString());
}

/** Enrolled: the marker first, then the pending key goes. */
export async function finishChoiceEnrolment(uid: string, enrolledAt: string): Promise<void> {
  await AsyncStorage.setItem(calendarChoiceKeys.enrolledAt(uid), enrolledAt);
  await AsyncStorage.removeItem(calendarChoiceKeys.choicePending(uid));
}

/**
 * The one durable pending operation (M5A-R51-001, M5A-R53-005): a selection
 * being applied, or the clear of an empty one. Cleared only when the upload
 * or clear completes.
 */
export interface PendingSelection {
  intentId: string;
  included: string[];
  selectionDigest: string;
  operation: 'upload' | 'clear';
  epoch: number | null;
  opId: string | null;
}

function pendingFrom(raw: string | null): PendingSelection | null {
  if (raw === null) return null;
  const row: unknown = JSON.parse(raw);
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('unreadable pending selection');
  const value = row as Record<string, unknown>;
  if (typeof value.intentId !== 'string' || value.intentId === ''
    || !Array.isArray(value.included) || !value.included.every((id) => typeof id === 'string')
    || typeof value.selectionDigest !== 'string'
    || (value.operation !== 'upload' && value.operation !== 'clear')
    || !(value.epoch === null || (typeof value.epoch === 'number' && Number.isSafeInteger(value.epoch)))
    || !(value.opId === null || (typeof value.opId === 'string' && value.opId !== ''))
    // An operation and its list agree (an empty list is a clear), and the
    // server's acknowledgement is whole or absent.
    || (value.operation === 'clear') !== ((value.included as unknown[]).length === 0)
    || (value.epoch === null) !== (value.opId === null)
    || !(value.included as unknown[]).every((id) => id !== '')) {
    throw new Error('unreadable pending selection');
  }
  return {
    intentId: value.intentId,
    included: [...(value.included as string[])],
    selectionDigest: value.selectionDigest,
    operation: value.operation,
    epoch: value.epoch as number | null,
    opId: value.opId as string | null,
  };
}

/** Throws when unreadable: an operation that cannot be read is not "none". */
export async function loadPendingSelection(uid: string): Promise<PendingSelection | null> {
  return pendingFrom(await AsyncStorage.getItem(calendarChoiceKeys.pendingSelection(uid)));
}

export async function savePendingSelection(uid: string, pending: PendingSelection): Promise<void> {
  await AsyncStorage.setItem(calendarChoiceKeys.pendingSelection(uid), JSON.stringify(pending));
}

export async function removePendingSelection(uid: string): Promise<void> {
  await AsyncStorage.removeItem(calendarChoiceKeys.pendingSelection(uid));
}

/**
 * The selection takes effect: the list, then a new inclusion generation, so
 * a cache read under the old list is never shown again (M5A-R12-002).
 */
export async function applyIncludedCalendarIds(uid: string, included: readonly string[]): Promise<void> {
  const raw = await AsyncStorage.getItem(calendarChoiceKeys.inclusionGeneration(uid));
  const current = raw === null ? 0 : Number(raw);
  const next = Number.isSafeInteger(current) && current >= 0 && current < Number.MAX_SAFE_INTEGER ? current + 1 : 1;
  // The generation first: if the list write then fails or the app dies, the
  // old cache already mismatches and is never shown (R1.1c, M5A-R8-004).
  await AsyncStorage.setItem(calendarChoiceKeys.inclusionGeneration(uid), String(next));
  await AsyncStorage.setItem(calendarChoiceKeys.included(uid), JSON.stringify([...new Set(included)]));
}

/** A new inclusion generation with no change to the list: enrolment (R1.1c). */
export async function bumpInclusionGeneration(uid: string): Promise<void> {
  const raw = await AsyncStorage.getItem(calendarChoiceKeys.inclusionGeneration(uid));
  const current = raw === null ? 0 : Number(raw);
  const next = Number.isSafeInteger(current) && current >= 0 && current < Number.MAX_SAFE_INTEGER ? current + 1 : 1;
  await AsyncStorage.setItem(calendarChoiceKeys.inclusionGeneration(uid), String(next));
}

/**
 * The account's busy cache must not be read again (a removal, a disconnect,
 * consent withdrawn): a new generation first, so even a cache that fails to
 * delete never matches again (M5A-R4-002), then the delete itself.
 */
export async function invalidateDeviceBusyCache(uid: string): Promise<void> {
  try {
    await bumpInclusionGeneration(uid);
  } catch {
    // The delete below still runs; a later read retries the bump.
  }
  await clearCachedBusyBlocksOf(uid);
}

/** Throws when unreadable: an unknown barrier is treated as set by callers. */
export async function loadPhoneRemoved(uid: string): Promise<boolean> {
  return (await AsyncStorage.getItem(calendarChoiceKeys.phoneRemoved(uid))) !== null;
}

export async function savePhoneRemoved(uid: string, at: Date): Promise<void> {
  await AsyncStorage.setItem(calendarChoiceKeys.phoneRemoved(uid), at.toISOString());
}

export async function clearPhoneRemoved(uid: string): Promise<void> {
  await AsyncStorage.removeItem(calendarChoiceKeys.phoneRemoved(uid));
}

/**
 * The installation id of the credential this phone was removed under
 * (M5A-R6-003), so a rejoin can tell that tuple — if its delete failed and it
 * survived — from the fresh one it mints. Not a secret.
 */
export async function saveRemovedInstallation(uid: string, sourceInstallationId: string): Promise<void> {
  await AsyncStorage.setItem(calendarChoiceKeys.removedInstallation(uid), sourceInstallationId);
}

/** Null when absent or unreadable. */
export async function loadRemovedInstallation(uid: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(calendarChoiceKeys.removedInstallation(uid));
  } catch {
    return null;
  }
}

export async function clearRemovedInstallation(uid: string): Promise<void> {
  await AsyncStorage.removeItem(calendarChoiceKeys.removedInstallation(uid));
}

/**
 * The installation id of the tuple minted for a rejoin (M5A-R7-002). While the
 * removal barrier is set, only a credential carrying this id is reused; any
 * other — the removed one, whose delete may have failed — is replaced first.
 */
export async function saveRejoinInstallation(uid: string, sourceInstallationId: string): Promise<void> {
  await AsyncStorage.setItem(calendarChoiceKeys.rejoinInstallation(uid), sourceInstallationId);
}

/** Null when absent or unreadable (then a fresh tuple is minted). */
export async function loadRejoinInstallation(uid: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(calendarChoiceKeys.rejoinInstallation(uid));
  } catch {
    return null;
  }
}

export async function clearRejoinInstallation(uid: string): Promise<void> {
  await AsyncStorage.removeItem(calendarChoiceKeys.rejoinInstallation(uid));
}

/**
 * The server-issued id of this phone's source for the account, with the
 * installation id it was registered under — a credential minted anew is a new
 * source, so an id from the old one is never reused. Neither is a secret.
 */
export interface StoredSource {
  sourceId: string;
  sourceInstallationId: string;
}

export async function loadSource(uid: string): Promise<StoredSource | null> {
  try {
    const raw = await AsyncStorage.getItem(calendarChoiceKeys.sourceId(uid));
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const row = value as Record<string, unknown>;
    if (typeof row.sourceId !== 'string' || !row.sourceId.startsWith('device:')) return null;
    if (typeof row.sourceInstallationId !== 'string' || row.sourceInstallationId === '') return null;
    return { sourceId: row.sourceId, sourceInstallationId: row.sourceInstallationId };
  } catch {
    return null;
  }
}

export async function saveSource(uid: string, source: StoredSource): Promise<void> {
  await AsyncStorage.setItem(calendarChoiceKeys.sourceId(uid), JSON.stringify(source));
}

export async function removeSource(uid: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(calendarChoiceKeys.sourceId(uid));
  } catch {
    // The next registration overwrites it.
  }
}
