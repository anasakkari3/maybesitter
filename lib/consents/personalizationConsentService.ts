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
import { getConsent, setConsent, setConsentIf, setConsentWhile, setConsentWithToken, type SetConsentInput } from './consentService';

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

/**
 * The withdrawal lost the fence before it could disable consent — a grant, or
 * another withdrawal, took over after its lease ran out (M5B2A-R20-002).
 * Nothing it would write is written; asking again withdraws.
 */
export class PersonalizationWithdrawalSupersededError extends PersonalizationWithdrawalBusyError {
  constructor() {
    super();
    this.name = 'PersonalizationWithdrawalSupersededError';
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
function leaseExpired(fence: FenceDocument, nowMs: number = Date.now()): boolean {
  const since = typeof fence.withdrawalLeaseAt === 'string' ? Date.parse(fence.withdrawalLeaseAt)
    : typeof fence.consentWithdrawnAt === 'string' ? Date.parse(fence.consentWithdrawnAt) : Number.NaN;
  return !Number.isFinite(since) || nowMs - since >= STALE_WITHDRAWAL_MS;
}

/**
 * Whether a withdrawal still owns this fence: `withdrawing`, its lease not run
 * out at `nowMs`. A purge must not take the fence from it (M5B2A-R26-001): the
 * withdrawal may sit between its disable and its declined answer, and losing
 * the fence there would leave the two consent records disagreeing.
 */
export function liveWithdrawalOwnsFence(fence: unknown, nowMs: number): boolean {
  const current = fence as FenceDocument | undefined;
  return current?.state === 'withdrawing' && !leaseExpired(current, nowMs);
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
    // This withdrawal's own lease, exactly. Another owner's fence is recovered
    // only when consent is verified off *and* that owner's lease has run out on
    // the server's clock (M5B2A-R19-001, R23-001): a live owner may still be
    // between its disable and its declined answer, and reopening under it
    // would let a grant land before that answer does.
    const own = current.epoch === lease.epoch && current.withdrawalOwner === lease.owner;
    if (!own && !(consentOff && leaseExpired(current))) return;
    const { withdrawalOwner: _owner, withdrawalLeaseAt: _lease, ...rest } = current;
    tx.merge(userDoc(uid), { personalizationPurge: { ...rest, state: 'active', withdrawalOwner: null, withdrawalLeaseAt: null } });
  });
}

/** The fence epoch a user document carries; 0 before any withdrawal or purge. */
function fenceEpoch(user: unknown): number {
  const epoch = (user as { personalizationPurge?: FenceDocument } | null)?.personalizationPurge?.epoch;
  return Number.isSafeInteger(epoch) && (epoch as number) >= 0 ? (epoch as number) : 0;
}

/** This withdrawal's fence, still closed, with its lease marked run out. */
async function abandonWithdrawalLease(storage: StorageAdapter, uid: string, lease: WithdrawalLease): Promise<void> {
  await storage.runTransaction(async (tx) => {
    const user = await tx.get<Record<string, unknown>>(userDoc(uid));
    const current = user?.personalizationPurge as FenceDocument | undefined;
    if (current?.state !== 'withdrawing' || current.epoch !== lease.epoch || current.withdrawalOwner !== lease.owner) return;
    tx.merge(userDoc(uid), { personalizationPurge: { ...current, withdrawalLeaseAt: new Date(0).toISOString() } });
  });
}

/** Whether `lease` still owns the fence in this user document. */
function ownsFence(user: unknown, lease: WithdrawalLease): boolean {
  const fence = (user as { personalizationPurge?: FenceDocument } | null)?.personalizationPurge;
  return fence?.state === 'withdrawing' && fence.epoch === lease.epoch && fence.withdrawalOwner === lease.owner;
}

/** Active, or a fence from before states existed. */
function fenceActive(fence: FenceDocument | undefined): boolean {
  return fence === undefined || fence.state === undefined || fence.state === 'active';
}

/**
 * The epoch of an active fence, read in a transaction that also supersedes a
 * withdrawal whose lease ran out. A live withdrawal or a purge is waited for,
 * as a withdrawal waits; one that lasts refuses the grant before anything is
 * written.
 */
async function captureGrantVersion(
  storage: StorageAdapter,
  uid: string,
  wait: { readonly attempts: number; readonly delayMs: number },
): Promise<number> {
  for (let attempt = 1; ; attempt += 1) {
    const version = await storage.runTransaction(async (tx) => {
      const user = await tx.get<Record<string, unknown>>(userDoc(uid));
      const fence = user?.personalizationPurge as FenceDocument | undefined;
      if (fenceActive(fence)) return fenceEpoch(user);
      if (fence!.state === 'withdrawing' && leaseExpired(fence!)) {
        const epoch = fenceEpoch(user) + 1;
        tx.merge(userDoc(uid), { personalizationPurge: { ...fence, state: 'active', epoch, withdrawalOwner: null, withdrawalLeaseAt: null } });
        return epoch;
      }
      return null;
    });
    if (version !== null) return version;
    if (attempt >= wait.attempts) throw new PersonalizationWithdrawalBusyError();
    await new Promise((resolve) => setTimeout(resolve, wait.delayMs));
  }
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
    // Refused before any fence is touched (M5B2A-R25-001): an answer that will
    // not be recorded must not supersede a withdrawal on its way to that
    // refusal. `setConsent` throws the same refusal it always has.
    if (!PERSONALIZATION_CONSENT.isSupportedVersion(input.version)) {
      return setConsent(PERSONALIZATION_CONSENT, uid, { ...input, at }, { storage });
    }
    // Never while a live withdrawal owns the fence (M5B2A-R19-001): it could
    // otherwise finish after this and leave memory closed under a grant that
    // said it worked. Waited for, as a withdrawal waits; refused if it lasts.
    // The fence version this grant is decided under, taken in one transaction
    // that sees the fence active (M5B2A-R21-001, R22-001). A withdrawal whose
    // lease ran out is superseded there, before the grant is written, so its
    // delayed disable can no longer land after it (R20-002). The store is then
    // enabled only at this same epoch, still active: a withdrawal that began
    // after this point has moved the epoch, and refuses the grant.
    const version = await captureGrantVersion(storage, uid, options.purgeWait ?? PURGE_WAIT);
    const { record, token } = await setConsentWithToken(PERSONALIZATION_CONSENT, uid, { ...input, at }, { storage });
    try {
      if (!store.writeGuarded) await store.write(uid, 'enabled', record.changedAt);
      else {
        const written = await store.writeGuarded(uid, 'enabled', record.changedAt, {
          path: userDoc(uid),
          accepts: (value) => {
            const fence = (value as { personalizationPurge?: FenceDocument } | null)?.personalizationPurge;
            return fenceActive(fence) && fenceEpoch(value) === version;
          },
        });
        if (written === null) throw new Error('a withdrawal took the fence after this grant was decided');
      }
    } catch (error) {
      // Rolled back to what is actually in force. If this also fails, growth
      // is still off — `personalizationGrowthAllowed` needs the store — and the
      // caller is told the answer was not recorded either way.
      // Only while the stored answer is still this grant's own (R22-002): a
      // newer grant that succeeded since keeps its answer.
      await setConsentIf(PERSONALIZATION_CONSENT, uid, { ...input, state: 'declined', at }, token, { storage })
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
    // The answer is recorded while the fence is still closed (M5B2A-R21-001):
    // a grant decided after this withdrawal reopens cannot be overtaken by
    // this withdrawal's own answer landing late.
    // …and only while this withdrawal still owns the fence (R25-002): one that
    // stalled past its lease and was superseded by a grant must not write its
    // older "declined" over the newer answer.
    let record: ConsentRecord | null = null;
    await withdrawFenced(uid, at.toISOString(), { ...options, storage, consent: store }, async (held) => {
      record = await setConsentWhile(PERSONALIZATION_CONSENT, uid, { ...input, at }, (user) => ownsFence(user, held), { storage });
      if (record === null) throw new PersonalizationWithdrawalSupersededError();
    });
    return record!;
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
  return withdrawFenced(uid, at, options);
}

/** `disablePersonalizationFenced`, with a step run after the disable and before the fence reopens. */
async function withdrawFenced(
  uid: string,
  at: string,
  options: PersonalizationConsentOptions,
  whileClosed?: (held: WithdrawalLease) => Promise<void>,
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
    // Written only while this withdrawal still owns the fence (M5B2A-R20-002):
    // one that outlived its lease, superseded by a grant, must not turn the
    // newer grant off. A store that cannot guard writes as before.
    const written = !store.writeGuarded ? await store.write(uid, 'disabled', at) : await store.writeGuarded(uid, 'disabled', at, {
      path: userDoc(uid),
      accepts: (value) => {
        const fence = (value as { personalizationPurge?: FenceDocument } | null)?.personalizationPurge;
        return fence?.state === 'withdrawing' && fence.epoch === held.epoch && fence.withdrawalOwner === held.owner;
      },
    });
    if (written === null) throw new PersonalizationWithdrawalSupersededError();
    if (whileClosed) await whileClosed(held);
    return written;
  } finally {
    // Reopened once consent reads off. A withdrawal whose own write failed
    // reopens too — consent is still on, and the epoch has moved — unless it
    // took over from one that may still be running (M5B2A-R18-001): then the
    // fence stays closed until consent is off or the lease runs out.
    const off = await store.read(uid).then((consent) => consent.state === 'disabled', () => false);
    if (off || !held.tookOver) await finishPersonalizationWithdrawal(storage, uid, held, off);
    // A takeover that failed with consent still on keeps the fence closed, but
    // gives its lease up (R23-001): whoever later finds consent off may then
    // recover it at once, without reopening under a live owner.
    else await abandonWithdrawalLease(storage, uid, held).catch(() => undefined);
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
