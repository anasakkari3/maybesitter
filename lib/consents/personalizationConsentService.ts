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
import type { PersonalizationConsent } from '../../src/contracts/v1/personalizationContracts';
import { getStorage, type StorageAdapter } from '../storage';
import { userDoc } from '../storage/paths';
import { randomUUID } from 'node:crypto';
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
    super('a personalization purge or another withdrawal is running; this withdrawal was not recorded');
    this.name = 'PersonalizationWithdrawalBusyError';
  }
}

const PURGE_WAIT = { attempts: 40, delayMs: 250 } as const;

/** A withdrawal still between its phases after this long is taken to have died. */
const STALE_WITHDRAWAL_MS = 60_000;

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
interface WithdrawalLease {
  readonly epoch: number;
  /** Unguessable: only the withdrawal that took the fence can reopen it. */
  readonly owner: string;
  /** Whether it took the fence over from a withdrawal that may still be running. */
  readonly tookOver: boolean;
}

type FenceDocument = {
  state?: unknown; epoch?: unknown; withdrawalOwner?: unknown; withdrawalLeaseAt?: unknown; consentWithdrawnAt?: unknown;
};

/** Whether a `withdrawing` fence's lease, on the server's clock, has run out. */
function leaseExpired(fence: FenceDocument): boolean {
  const since = typeof fence.withdrawalLeaseAt === 'string' ? Date.parse(fence.withdrawalLeaseAt)
    : typeof fence.consentWithdrawnAt === 'string' ? Date.parse(fence.consentWithdrawnAt) : Number.NaN;
  return !Number.isFinite(since) || Date.now() - since >= STALE_WITHDRAWAL_MS;
}

async function beginPersonalizationWithdrawal(storage: StorageAdapter, uid: string, at: string): Promise<WithdrawalLease | null> {
  return storage.runTransaction(async (tx) => {
    const user = await tx.get<Record<string, unknown>>(userDoc(uid));
    const prior = user?.personalizationPurge as FenceDocument | undefined;
    if (prior?.state === 'purging') return null;
    // One owner of the fence at a time (M5B2A-R17-001): another withdrawal
    // still between its phases is waited for. A lease that ran out — on the
    // server's clock, never a caller's (M5B2A-R18-001) — is taken over, so a
    // crash cannot close memory for good; but a takeover never reopens the
    // fence unless consent is verified off (see the caller).
    if (prior?.state === 'withdrawing' && !leaseExpired(prior)) return null;
    const epoch = (Number.isSafeInteger(prior?.epoch) && (prior!.epoch as number) >= 0 ? (prior!.epoch as number) : 0) + 1;
    const owner = randomUUID();
    const personalizationPurge = {
      ...(prior ?? {}), state: 'withdrawing', epoch, consentWithdrawnAt: at,
      withdrawalOwner: owner, withdrawalLeaseAt: new Date().toISOString(),
    };
    if (user) tx.merge(userDoc(uid), { personalizationPurge });
    else tx.set(userDoc(uid), { personalizationPurge });
    return { epoch, owner, tookOver: prior?.state === 'withdrawing' };
  });
}

/**
 * Phase two: the fence is active again at the epoch phase one set — once the
 * store is disabled, so a reader that sees it active also sees consent off.
 * Only that exact epoch, still withdrawing: a purge that began in between owns
 * the fence, and a later withdrawal finishes its own.
 */
async function finishPersonalizationWithdrawal(
  storage: StorageAdapter,
  uid: string,
  lease: WithdrawalLease,
  consentOff: boolean,
): Promise<void> {
  await storage.runTransaction(async (tx) => {
    const user = await tx.get<Record<string, unknown>>(userDoc(uid));
    const current = user?.personalizationPurge as FenceDocument | undefined;
    if (current?.state !== 'withdrawing') return;
    // Consent verified off: whoever holds the fence now, reopening it lets no
    // reader take memory, so a fence a takeover left behind is recovered too
    // (M5B2A-R19-001). Otherwise only this withdrawal's own lease.
    if (!consentOff && (current.epoch !== lease.epoch || current.withdrawalOwner !== lease.owner)) return;
    const { withdrawalOwner: _owner, withdrawalLeaseAt: _lease, ...rest } = current;
    tx.merge(userDoc(uid), { personalizationPurge: { ...rest, state: 'active', withdrawalOwner: null, withdrawalLeaseAt: null } });
  });
}

async function waitForNoLiveWithdrawal(storage: StorageAdapter, uid: string, wait: { readonly attempts: number; readonly delayMs: number }): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const user = await storage.get<Record<string, unknown>>(userDoc(uid));
    const fence = user?.personalizationPurge as FenceDocument | undefined;
    if (fence?.state !== 'withdrawing' || leaseExpired(fence)) return;
    if (attempt >= wait.attempts) throw new PersonalizationWithdrawalBusyError();
    await new Promise((resolve) => setTimeout(resolve, wait.delayMs));
  }
}

/**
 * A grant reopens a fence a dead withdrawal left closed (lease run out), so
 * the person who turns memory back on gets it back. A live withdrawal's fence
 * is left to that withdrawal.
 */
async function reopenAbandonedWithdrawal(storage: StorageAdapter, uid: string): Promise<void> {
  await storage.runTransaction(async (tx) => {
    const user = await tx.get<Record<string, unknown>>(userDoc(uid));
    const current = user?.personalizationPurge as FenceDocument | undefined;
    if (current?.state !== 'withdrawing' || !leaseExpired(current)) return;
    const epoch = (Number.isSafeInteger(current.epoch) ? (current.epoch as number) : 0) + 1;
    tx.merge(userDoc(uid), { personalizationPurge: { ...current, state: 'active', epoch, withdrawalOwner: null, withdrawalLeaseAt: null } });
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
    // Never while a live withdrawal owns the fence (M5B2A-R19-001): it could
    // otherwise finish after this and leave memory closed under a grant that
    // said it worked. Waited for, as a withdrawal waits; refused if it lasts.
    await waitForNoLiveWithdrawal(storage, uid, options.purgeWait ?? PURGE_WAIT);
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
    // A fence a dead withdrawal left closed opens with the grant; failing that
    // only leaves memory closed, never the answer unrecorded.
    await reopenAbandonedWithdrawal(storage, uid).catch(() => undefined);
    return record;
  }
  if (input.state === 'declined') {
    // The version is checked by `setConsent`; it is checked here first too, so
    // a refused answer does not disable anything on its way to being refused.
    if (!PERSONALIZATION_CONSENT.isSupportedVersion(input.version)) {
      return setConsent(PERSONALIZATION_CONSENT, uid, { ...input, at }, { storage });
    }
    await disablePersonalizationFenced(uid, at.toISOString(), { ...options, storage, consent: store });
    return setConsent(PERSONALIZATION_CONSENT, uid, { ...input, at }, { storage });
  }
  return setConsent(PERSONALIZATION_CONSENT, uid, { ...input, at }, { storage });
}

/**
 * Disables the personalization store behind the fence — the one way it is
 * ever disabled (M5B2A-R11-001).
 *
 * Withdrawal moves the personalization fence (M5B2A-R2-001), in two phases
 * (M5B2A-R7-001): the epoch moves and the fence closes in one transaction, the
 * store is disabled, then the fence reopens at that epoch. A plan that read
 * the kept window before phase one is refused by its write guard; a basis read
 * across it is not shown; and while the fence is closed no reader takes the
 * window at all. Reopened only once the store is off, so any reader after it
 * sees consent withdrawn. If the store write fails the fence reopens — consent
 * is still on and the epoch has moved — unless it was taken over from a
 * withdrawal that may still be running (M5B2A-R18-001); the caller is told.
 *
 * Behind a running purge it waits (M5B2A-R8-003): every withdrawal takes its
 * own epoch, so a plan that read the window under the purge's epoch after the
 * purge reopened is refused too. A purge that outlasts the wait fails the
 * withdrawal before anything changes.
 */
export async function disablePersonalizationFenced(
  uid: string,
  at: string,
  options: PersonalizationConsentOptions = {},
): Promise<PersonalizationConsent> {
  const storage = options.storage ?? getStorage();
  const store = storeOf(options);
  const wait = options.purgeWait ?? PURGE_WAIT;
  let lease = await beginPersonalizationWithdrawal(storage, uid, at);
  for (let attempt = 1; lease === null; attempt += 1) {
    if (attempt >= wait.attempts) throw new PersonalizationWithdrawalBusyError();
    await new Promise((resolve) => setTimeout(resolve, wait.delayMs));
    lease = await beginPersonalizationWithdrawal(storage, uid, at);
  }
  const held = lease;
  try {
    return await store.write(uid, 'disabled', at);
  } finally {
    // Reopened once consent reads off. A withdrawal whose own write failed
    // reopens too — consent is still on, and the epoch has moved — unless it
    // took over from one that may still be running (M5B2A-R18-001): then the
    // fence stays closed until consent is off or the lease runs out.
    const off = await store.read(uid).then((consent) => consent.state === 'disabled', () => false);
    if (off || !held.tookOver) await finishPersonalizationWithdrawal(storage, uid, held, off);
  }
}

/**
 * A consent store whose `disabled` writes go through the fence. For every
 * caller that holds a raw store — the legacy control centre route — so none
 * can withdraw around it (M5B2A-R11-001).
 */
export function fencedPersonalizationConsentStore(
  options: PersonalizationConsentOptions = {},
): PersonalizationConsentStore {
  const base = storeOf(options);
  // Every method delegated by name: the storage store's methods live on its
  // prototype, which a spread does not copy (M5B2A-R12-001).
  return {
    read: (scopeId) => base.read(scopeId),
    write: (scopeId, state, at) => (state === 'disabled'
      ? disablePersonalizationFenced(scopeId, at, { ...options, consent: base })
      : base.write(scopeId, state, at)),
    deleteScope: (scopeId) => base.deleteScope(scopeId),
  };
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
