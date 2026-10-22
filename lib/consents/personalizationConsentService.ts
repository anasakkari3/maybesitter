/**
 * "Notice patterns in when you finish things" (UC-3.16, #202).
 *
 * ── One question, two places it has to be true ───────────────────
 *
 * The phone records consent the way every mobile consent is recorded:
 * `users/{uid}.consents.personalization`, versioned against the words shown,
 * audited, refused for an unknown version (`consentService`). The
 * personalization contracts, though, already read a different document —
 * `users/{uid}/consents/personalization`, the `enabled | disabled` record the
 * consent store owns and every derivation checks. So an answer is written to
 * both, and **growth requires both**: the versioned answer granted *and* the
 * store enabled.
 *
 * Requiring both is what makes the two writes safe without a transaction
 * spanning them. They are ordered so that a failure between them can only
 * leave growth *off*:
 *
 *  - turning on writes the versioned answer first and enables the store last;
 *  - turning off disables the store first and records the answer last.
 *
 * And it is what keeps the rest fail-closed: a store enabled by the frozen web
 * control centre, with no answer to these words, is off; an answer given to an
 * older version of the words reads as declined (`consentService`), so is off;
 * an account that has agreed to AI processing or to next-step suggestions and
 * never been asked this is off. Nothing here is inferred from another answer.
 */
import {
  PERSONALIZATION_CONSENT,
  PERSONALIZATION_CONSENT_VERSION,
  type ConsentRecord,
} from '../../src/contracts/v1/consentContracts';
import {
  createStoragePersonalizationConsentStore,
  type PersonalizationConsentStore,
} from '../personalizationControls/consentStore';
import { getStorage, type StorageAdapter } from '../storage';
import { userDoc } from '../storage/paths';
import { getConsent, setConsent, type SetConsentInput } from './consentService';

/**
 * A yes that could not be made true. The versioned answer was recorded but the
 * store could not be enabled, so the answer has been put back to declined —
 * leaving it `granted` would show the switch on while the feature stays off.
 */
export class PersonalizationConsentNotRecordedError extends Error {
  constructor(cause: unknown) {
    super(`personalization consent could not be recorded: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'PersonalizationConsentNotRecordedError';
  }
}

export interface PersonalizationConsentOptions {
  storage?: StorageAdapter;
  /** The `enabled | disabled` store; defaults to one over `storage`. */
  consent?: PersonalizationConsentStore;
  /** How long a withdrawal waits behind a running purge (tests shorten it). */
  purgeWait?: { readonly attempts: number; readonly delayMs: number };
}

/**
 * A withdrawal that arrived while a personalization purge was running, and the
 * purge did not finish in time. Nothing was changed: consent is as it was,
 * and asking again once the purge is done withdraws it.
 */
export class PersonalizationWithdrawalBusyError extends Error {
  constructor() {
    super('a personalization purge is running; the withdrawal was not recorded');
    this.name = 'PersonalizationWithdrawalBusyError';
  }
}

const PURGE_WAIT = { attempts: 40, delayMs: 250 } as const;

function storeOf(options: PersonalizationConsentOptions): PersonalizationConsentStore {
  return options.consent ?? createStoragePersonalizationConsentStore(options.storage ?? getStorage());
}

/**
 * Phase one of a withdrawal (M5B2A-R7-001): one transaction moves the epoch
 * *and* marks the fence `withdrawing`, which every memory reader and write
 * guard reads as not active. Nothing that read memory before this can write
 * after it, and nothing can read memory again until phase two. Returns the
 * epoch it set, or null while a purge runs: the purge owns the fence then,
 * and the caller waits for it (M5B2A-R8-003).
 */
async function beginPersonalizationWithdrawal(storage: StorageAdapter, uid: string, at: string): Promise<number | null> {
  return storage.runTransaction(async (tx) => {
    const user = await tx.get<Record<string, unknown>>(userDoc(uid));
    const prior = user?.personalizationPurge as { state?: unknown; epoch?: unknown } | undefined;
    if (prior?.state === 'purging') return null;
    const epoch = (Number.isSafeInteger(prior?.epoch) && (prior!.epoch as number) >= 0 ? (prior!.epoch as number) : 0) + 1;
    const personalizationPurge = { ...(prior ?? {}), state: 'withdrawing', epoch, consentWithdrawnAt: at };
    if (user) tx.merge(userDoc(uid), { personalizationPurge });
    else tx.set(userDoc(uid), { personalizationPurge });
    return epoch;
  });
}

/**
 * Phase two: the fence is active again at the epoch phase one set — once the
 * store is disabled, so a reader that sees it active also sees consent off.
 * Only that exact epoch, still withdrawing: a purge that began in between owns
 * the fence, and a later withdrawal finishes its own.
 */
async function finishPersonalizationWithdrawal(storage: StorageAdapter, uid: string, epoch: number): Promise<void> {
  await storage.runTransaction(async (tx) => {
    const user = await tx.get<Record<string, unknown>>(userDoc(uid));
    const current = user?.personalizationPurge as { state?: unknown; epoch?: unknown } | undefined;
    if (current?.state !== 'withdrawing' || current.epoch !== epoch) return;
    tx.merge(userDoc(uid), { personalizationPurge: { ...current, state: 'active' } });
  });
}

export async function setPersonalizationConsent(
  uid: string,
  input: SetConsentInput,
  options: PersonalizationConsentOptions = {},
): Promise<ConsentRecord> {
  const storage = options.storage ?? getStorage();
  const store = storeOf(options);
  const at = input.at ?? new Date();
  if (input.state === 'granted') {
    const record = await setConsent(PERSONALIZATION_CONSENT, uid, { ...input, at }, { storage });
    try {
      await store.write(uid, 'enabled', record.changedAt);
    } catch (error) {
      // Rolled back to what is actually in force. If this also fails, growth
      // is still off — `personalizationGrowthAllowed` needs the store — and the
      // caller is told the answer was not recorded either way.
      await setConsent(PERSONALIZATION_CONSENT, uid, { ...input, state: 'declined', at }, { storage })
        .catch(() => undefined);
      throw new PersonalizationConsentNotRecordedError(error);
    }
    return record;
  }
  if (input.state === 'declined') {
    // The version is checked by `setConsent`; it is checked here first too, so
    // a refused answer does not disable anything on its way to being refused.
    if (!PERSONALIZATION_CONSENT.isSupportedVersion(input.version)) {
      return setConsent(PERSONALIZATION_CONSENT, uid, { ...input, at }, { storage });
    }
    // Withdrawal moves the personalization fence (M5B2A-R2-001), in two
    // phases (M5B2A-R7-001): the epoch moves and the fence closes in one
    // transaction, the store is disabled, then the fence reopens at that
    // epoch. A plan that read the kept window before phase one is refused by
    // its write guard; a basis read across it is not shown; and while the
    // fence is closed no reader takes the window at all. Reopened only once
    // the store is off, so any reader after it sees consent withdrawn. If the
    // store write fails the fence still reopens — the epoch has already moved,
    // so nothing read before is written — and the caller is told.
    //
    // Behind a running purge it waits (M5B2A-R8-003): every withdrawal takes
    // its own epoch, so a plan that read the window under the purge's epoch
    // after the purge reopened is refused too. A purge that outlasts the wait
    // fails the withdrawal before anything changes.
    const wait = options.purgeWait ?? PURGE_WAIT;
    let epoch = await beginPersonalizationWithdrawal(storage, uid, at.toISOString());
    for (let attempt = 1; epoch === null; attempt += 1) {
      if (attempt >= wait.attempts) throw new PersonalizationWithdrawalBusyError();
      await new Promise((resolve) => setTimeout(resolve, wait.delayMs));
      epoch = await beginPersonalizationWithdrawal(storage, uid, at.toISOString());
    }
    try {
      await store.write(uid, 'disabled', at.toISOString());
    } finally {
      await finishPersonalizationWithdrawal(storage, uid, epoch);
    }
    return setConsent(PERSONALIZATION_CONSENT, uid, { ...input, at }, { storage });
  }
  return setConsent(PERSONALIZATION_CONSENT, uid, { ...input, at }, { storage });
}

/**
 * Whether behaviour-derived personalization may run for this account: pattern
 * suggestions, and a kept pattern shaping the plan. Both records must agree.
 */
export async function personalizationGrowthAllowed(
  uid: string,
  options: PersonalizationConsentOptions = {},
): Promise<boolean> {
  const storage = options.storage ?? getStorage();
  const [answer, stored] = await Promise.all([
    getConsent(PERSONALIZATION_CONSENT, uid, { storage }),
    storeOf(options).read(uid),
  ]);
  return answer === 'granted' && stored.state === 'enabled';
}

export { PERSONALIZATION_CONSENT_VERSION };
