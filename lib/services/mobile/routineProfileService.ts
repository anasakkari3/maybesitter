/**
 * The routine profile, and the facts derived from it (UC-2.7a, #167).
 *
 * ── Two representations, one write ───────────────────────────────
 *
 * A save writes the profile document *and* reconciles the routine facts, in
 * that order, under one call. They are not two features that happen to run
 * together: the memory screen shows the facts, the planner reads the profile,
 * and a user who edits their quiet hours must not be able to observe a state
 * where those two disagree about when they sleep.
 *
 * ── Reconciliation, not replacement ──────────────────────────────
 *
 * The obvious implementation — delete every routine fact and write fresh ones —
 * destroys the history the store exists to keep, and it would churn five
 * records every time the user re-opened the survey and pressed save without
 * changing anything. Instead each answer is matched to its previous record by
 * key, and only what actually differs moves:
 *
 *   unchanged  → left exactly as it was, same id
 *   changed    → `supersede`, so the old answer stays inspectable behind the new
 *   removed    → `revoke`, because there is no replacement to supersede it with
 *                and the answer is no longer true
 *   added      → `put`
 *
 * Revoke rather than delete for a removed answer: the user did not ask to erase
 * their history, they changed their routine. Deleting is what
 * `DELETE /api/mobile/memory/{id}` is for, and that is the user's own verb.
 */
import {
  ROUTINE_SURVEY_VERSION,
  buildRoutineProfile,
  isUserRoutineProfile,
  type RoutineProfileInput,
  type UserRoutineProfile,
} from '../../../src/contracts/v1/routineContracts';
import type { CreateMemoryInput, RuntimeMemoryRecord } from '../../../src/contracts/v1/memoryContracts';
import {
  ROUTINE_FACT_KEYS,
  routineFactKeyOf,
  routineProfileToFacts,
  type RoutineFactKey,
} from '../../memory/routineFacts';
import { createPilotAuditEvent } from '../../pilot/closedPilotControls';
import { appendAudit } from '../../pilot/pilotTrustStore';
import { createStorageRuntimeMemoryStore } from '../../runtimeMemory/runtimeMemoryStore';
import { getStorage, requireUserId, userDoc, type StorageAdapter } from '../../storage';
import type { RuntimeMemoryStore } from '../../../src/contracts/v1/memoryContracts';

/** The user document's profile map, as this service reads and writes it. */
interface ProfileBearingUser {
  profile?: {
    routine?: UserRoutineProfile;
  };
}

export interface RoutineProfileOptions {
  storage?: StorageAdapter;
  memory?: RuntimeMemoryStore;
}

function storageOf(options: RoutineProfileOptions): StorageAdapter {
  return options.storage ?? getStorage();
}

function memoryOf(options: RoutineProfileOptions): RuntimeMemoryStore {
  return options.memory ?? createStorageRuntimeMemoryStore(undefined, options.storage);
}

/** The stored profile, or null when this account has never answered. */
export async function readRoutineProfile(
  uid: string,
  options: RoutineProfileOptions = {},
): Promise<UserRoutineProfile | null> {
  requireUserId(uid);
  const user = await storageOf(options).get<ProfileBearingUser>(userDoc(uid));
  const routine = user?.profile?.routine;
  // A document written by a future schema, or edited by hand, reads as absent
  // rather than as a half-profile the planner would act on.
  return routine && isUserRoutineProfile(routine) ? routine : null;
}

export interface SaveRoutineProfileResult {
  profile: UserRoutineProfile;
  facts: {
    created: number;
    superseded: number;
    revoked: number;
    unchanged: number;
  };
}

/**
 * Records the survey.
 *
 * `at` is supplied by the caller rather than read from the clock here, so the
 * profile's `updatedAt`, every fact's `observedAt` and the audit line all carry
 * the same instant — which is what makes "the server copy is newer" decidable
 * on the phone (step 5 of #167) instead of a race between three `new Date()`s.
 */
export async function saveRoutineProfile(
  uid: string,
  input: RoutineProfileInput,
  at: string,
  options: RoutineProfileOptions = {},
): Promise<SaveRoutineProfileResult> {
  requireUserId(uid);
  const storage = storageOf(options);
  const profile = buildRoutineProfile(input, at);

  await storage.runTransaction(async (tx) => {
    const current = await tx.get<ProfileBearingUser>(userDoc(uid));
    tx.merge<ProfileBearingUser>(userDoc(uid), {
      profile: { ...(current?.profile ?? {}), routine: profile },
    });
  });

  const facts = await reconcileRoutineFacts(uid, profile, at, options);

  // After the writes commit, for the same reason consent does it that way: an
  // audit line for a save that did not happen is worse than a missing one.
  await appendAudit(createPilotAuditEvent({
    version: 'v1',
    eventType: 'profile_updated',
    participantId: uid,
    occurredAt: at,
    outcome: 'recorded',
    reasonCode: profile.surveySkipped ? 'routine_survey_skipped' : 'routine_survey_saved',
  }));

  return { profile, facts };
}

/** Active routine facts, grouped by key, oldest first inside each key. */
function groupByKey(records: readonly RuntimeMemoryRecord[]): Map<RoutineFactKey, RuntimeMemoryRecord[]> {
  const grouped = new Map<RoutineFactKey, RuntimeMemoryRecord[]>();
  for (const record of records) {
    if (record.status !== 'active') continue;
    if (record.provenance?.origin !== 'routine_survey') continue;
    const key = routineFactKeyOf(record.content);
    if (!key) continue;
    const bucket = grouped.get(key);
    if (bucket) bucket.push(record);
    else grouped.set(key, [record]);
  }
  // `listAll` already returns oldest-created first, so each bucket is in write
  // order and pairing is stable across calls.
  return grouped;
}

function groupInputsByKey(inputs: readonly CreateMemoryInput[]): Map<RoutineFactKey, CreateMemoryInput[]> {
  const grouped = new Map<RoutineFactKey, CreateMemoryInput[]>();
  for (const input of inputs) {
    const key = routineFactKeyOf(input.content);
    if (!key) continue;
    const bucket = grouped.get(key);
    if (bucket) bucket.push(input);
    else grouped.set(key, [input]);
  }
  return grouped;
}

export async function reconcileRoutineFacts(
  uid: string,
  profile: UserRoutineProfile,
  at: string,
  options: RoutineProfileOptions = {},
): Promise<SaveRoutineProfileResult['facts']> {
  const memory = memoryOf(options);
  const existing = groupByKey(await memory.listAll(uid));
  const desired = groupInputsByKey(routineProfileToFacts(profile, uid, { observedAt: at }));

  let created = 0;
  let superseded = 0;
  let revoked = 0;
  let unchanged = 0;

  // Iterated in the contract's own order rather than over the two maps' keys,
  // so reconciliation touches records in the same sequence every run and a
  // test can assert the writes, not just the counts.
  for (const key of ROUTINE_FACT_KEYS) {
    const before = existing.get(key) ?? [];
    const after = desired.get(key) ?? [];
    const paired = Math.min(before.length, after.length);

    for (let index = 0; index < paired; index += 1) {
      const prior = before[index]!;
      const next = after[index]!;
      if (prior.content === next.content) {
        unchanged += 1;
        continue;
      }
      await memory.supersede(prior.id, next, at);
      superseded += 1;
    }
    for (let index = paired; index < before.length; index += 1) {
      await memory.revoke(before[index]!.id, at);
      revoked += 1;
    }
    for (let index = paired; index < after.length; index += 1) {
      await memory.put(after[index]!, at);
      created += 1;
    }
  }

  return { created, superseded, revoked, unchanged };
}

export { ROUTINE_SURVEY_VERSION };
