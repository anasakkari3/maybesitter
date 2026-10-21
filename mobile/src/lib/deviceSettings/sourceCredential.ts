/**
 * This phone's calendar source credential, per account (M5a R1.1,
 * M5A-R55-001, M5A-R56-001).
 *
 * ── What it is ───────────────────────────────────────────────────
 *
 * `{ sourceInstallationId, sourceSecret, registrationId }`: three random
 * values, minted on this phone the first time it registers as a busy-time
 * source for the account. The server keeps the secret's hash only, and every
 * selection intent, upload and clear from this phone proves possession of it
 * in the `X-MaybeSitter-Source-Secret` header. A phone the person removed
 * cannot come back with its old tuple, and another phone cannot write as this
 * one.
 *
 * ── Why the secure store, and one value ──────────────────────────
 *
 * It is a credential, so it never goes near AsyncStorage (readable with the
 * container, backed up on Android). The keychain entry is app-scoped and
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY` keeps it off iCloud Keychain, so two phones
 * are always two sources. The three values are one entry, written once, so no
 * crash can leave half a tuple.
 *
 * ── Why the in-flight promise ────────────────────────────────────
 *
 * A foreground pass and a selection change can both reach a cold start at
 * once; both would find nothing, both would mint, and the server would get two
 * registrations for one phone. The whole read / validate / mint / write is
 * shared, like `installationId.ts`.
 *
 * ── A phone that cannot store one does not register ──────────────
 *
 * A keychain refusal answers null, and the caller registers nothing, reads
 * nothing and uploads nothing.
 */
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';

export interface StoredSourceCredential {
  sourceInstallationId: string;
  sourceSecret: string;
  registrationId: string;
}

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/** Secure-store keys allow letters, digits, `.`, `-` and `_` only. */
function keyFor(uid: string): string {
  return `calendar_source_credential.v1.${uid.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

function credentialFrom(raw: string | null): StoredSourceCredential | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const row = value as Record<string, unknown>;
    if (typeof row.sourceInstallationId !== 'string' || row.sourceInstallationId === '') return null;
    if (typeof row.sourceSecret !== 'string' || row.sourceSecret.length < 24) return null;
    if (typeof row.registrationId !== 'string' || row.registrationId === '') return null;
    return { sourceInstallationId: row.sourceInstallationId, sourceSecret: row.sourceSecret, registrationId: row.registrationId };
  } catch {
    return null;
  }
}

const inFlight = new Map<string, Promise<StoredSourceCredential | null>>();

/** The held credential, or null. Never mints. Throws when the store cannot be read. */
export async function readSourceCredential(uid: string): Promise<StoredSourceCredential | null> {
  return credentialFrom(await SecureStore.getItemAsync(keyFor(uid), OPTIONS));
}

/**
 * The credential, minted and persisted first if there is none (or what is
 * stored is malformed — a new tuple is a new source; the old one stays
 * removable in the other-phones list). Null when the store refuses.
 */
export function ensureSourceCredential(uid: string): Promise<StoredSourceCredential | null> {
  const running = inFlight.get(uid);
  if (running) return running;
  const task: Promise<StoredSourceCredential | null> = readOrMint(uid).finally(() => {
    if (inFlight.get(uid) === task) inFlight.delete(uid);
  });
  inFlight.set(uid, task);
  return task;
}

async function readOrMint(uid: string): Promise<StoredSourceCredential | null> {
  try {
    const held = credentialFrom(await SecureStore.getItemAsync(keyFor(uid), OPTIONS));
    if (held) return held;
    return await mint(uid);
  } catch {
    return null;
  }
}

async function mint(uid: string): Promise<StoredSourceCredential> {
  const minted: StoredSourceCredential = {
    sourceInstallationId: Crypto.randomUUID(),
    sourceSecret: `${Crypto.randomUUID()}${Crypto.randomUUID()}`.replace(/-/g, ''),
    registrationId: Crypto.randomUUID(),
  };
  await SecureStore.setItemAsync(keyFor(uid), JSON.stringify(minted), OPTIONS);
  return minted;
}

/**
 * «رجّع هاد التلفون» (M5A-R60-001): an entirely new tuple, persisted before
 * anything is sent. Null when the store refuses, and the barrier then stays.
 */
export function mintFreshSourceCredential(uid: string): Promise<StoredSourceCredential | null> {
  const task: Promise<StoredSourceCredential | null> = (inFlight.get(uid) ?? Promise.resolve(null))
    .catch(() => null)
    .then(() => mint(uid))
    .catch(() => null)
    .finally(() => {
      if (inFlight.get(uid) === task) inFlight.delete(uid);
    });
  inFlight.set(uid, task);
  return task;
}

/** The phone was removed, or its credential is no longer known to the server. */
export async function deleteSourceCredential(uid: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(keyFor(uid), OPTIONS);
  } catch {
    // Nothing more to do: the server refuses this tuple anyway.
  }
}

/** Tests only. */
export function resetSourceCredentialForTests(): void {
  inFlight.clear();
}
