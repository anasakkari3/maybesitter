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
}

function storeOf(options: PersonalizationConsentOptions): PersonalizationConsentStore {
  return options.consent ?? createStoragePersonalizationConsentStore(options.storage ?? getStorage());
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
    await store.write(uid, 'disabled', at.toISOString());
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
