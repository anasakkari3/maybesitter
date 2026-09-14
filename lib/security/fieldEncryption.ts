import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for individual Firestore field values (UC-3.3, #187 step 1).
 *
 * ── What this is for ─────────────────────────────────────────────
 *
 * A few fields are bearer secrets in their own right: a Google refresh token
 * (#187), a Moodle feed URL with an `authtoken=` query parameter (#188). They
 * cannot live in Firestore as text — anyone who can read the document, or a
 * backup of it, can then act as the user against a third party. They also
 * cannot be hashed, because the server has to use the original value again.
 *
 * So they are encrypted, and the key that encrypts them never exists in this
 * repository, in an environment variable, or in a backup.
 *
 * ── Why envelope encryption rather than "just call KMS" ──────────
 *
 * Cloud KMS will encrypt a small payload directly, but every read and write
 * then costs a network round trip to KMS, and the payload limit is 64 KiB.
 * Instead each value gets its own random 256-bit data-encryption key (DEK):
 *
 *   plaintext --AES-256-GCM(DEK)--> ciphertext        (local, `node:crypto`)
 *   DEK       --KMS wrap---------> wrappedDek         (one small KMS call)
 *
 * The DEK exists only in memory for the length of one call and is zeroed
 * afterwards. Only the wrapped DEK is stored, so the stored document is
 * useless without KMS, and KMS is useless without the stored document.
 *
 * ── The uid binding is the point, not a detail ───────────────────
 *
 * `additionalAuthenticatedData = uid + ':' + purpose` is passed to *both*
 * layers: the KMS wrap and the local AES-GCM. AAD is authenticated but not
 * encrypted, so a value cannot be decrypted unless the caller names the same
 * uid and the same purpose it was encrypted under.
 *
 * That is what makes a stolen or misfiled document inert. Copying user A's
 * `encryptedRefreshToken` into user B's document does not give B a working
 * token: decryption under B's uid fails, it does not return A's secret. It is
 * also what stops a feed URL stored for `ics-url` being read back through a
 * code path that asks for `google-refresh-token`. #187's acceptance criteria
 * name this explicitly ("decrypting with another uid's AAD fails"), so it is
 * enforced twice rather than once — a future change to either layer cannot
 * quietly drop it on its own. Both halves of that are pinned by tests that
 * hold the other layer open: one runs a KMS double that ignores the AAD
 * entirely on unwrap, so only the local tag can refuse, and one hands the
 * double a wrapped DEK under the wrong AAD directly. Neither layer can be
 * deleted as "redundant" and land green.
 *
 * ── `purpose` must identify the row, not just the kind ───────────
 *
 * The AAD binds (uid, purpose) and nothing else. It does not know which
 * document or which field the blob was written to, so two values encrypted
 * for the same uid under the same purpose are interchangeable: swapping them
 * between rows is undetectable, and every guarantee above still holds while
 * the wrong secret comes back.
 *
 * For a singleton — one Google refresh token per user — `google-refresh-token`
 * is already unique per uid and that is fine. For anything a user can hold
 * several of, the purpose **must** carry a per-row discriminator; #188 allows
 * five ICS feeds per user, so its purpose is `ics-url/<feedId>`, not
 * `ics-url`. Use `fieldPurpose('ics-url', feedId)`, which composes and
 * validates it.
 *
 * This is worth getting right before there is data: `purpose` is baked into
 * the AAD, so widening it afterwards is a re-encryption pass over every
 * stored value, not a code change.
 *
 * ── Rotation is free, on purpose ─────────────────────────────────
 *
 * The wrap targets the CryptoKey, not a CryptoKeyVersion, so KMS encrypts
 * with whichever version is primary at the time and resolves the right
 * version itself on decrypt. #187 asks for 90-day rotation; when the key
 * rotates, values wrapped under the old version keep decrypting with no
 * migration and no re-encryption pass. `kmsKeyVersion` is stored for auditing
 * only — it is never used to address the decrypt, because doing so would turn
 * a rotation into a data-loss event.
 *
 * ── Fails closed, with no bypass ─────────────────────────────────
 *
 * Missing key configuration throws (503), exactly as `lib/auth/schedulerOidc`
 * answers 503 rather than "allow". There is deliberately no development mode
 * that stores the value in the clear: a passthrough would put a live refresh
 * token or a Moodle URL into Firestore as text on any deployment that forgot
 * one environment variable, and nothing downstream could tell.
 *
 * Nothing here logs. Not the plaintext, not the ciphertext, not the DEK, and
 * not the underlying KMS error — a failure is reported as a code, because the
 * error object from a KMS call can carry request material with it.
 *
 * ── An outage is not a verdict on the blob ───────────────────────
 *
 * `decrypt_failed` means Cloud KMS looked at the wrapped DEK, or the local
 * cipher looked at the tag, and refused. It never means "KMS was unreachable"
 * — that is `kms_unavailable`, 503, the same code the encrypt path uses.
 *
 * The distinction exists because the two mistakes are not symmetric. A caller
 * that reads a stored secret, sees `decrypt_failed` and concludes the value is
 * unusable will reasonably clear it; if a five-minute KMS blip produced that
 * code, a network hiccup would silently delete every user's stored feed URL.
 * Collapsing them costs nothing in privacy either: `kms_unavailable` is only
 * ever reached when no authenticated decryption happened at all, so it tells a
 * prober nothing about its ciphertext or its AAD.
 *
 * What is still deliberately collapsed is everything *inside* a rejection:
 * a wrong uid, a wrong purpose and a tampered ciphertext are one code, because
 * separating them would confirm to a prober which half of its attempt was
 * already right.
 *
 * ── Two things this does not do ──────────────────────────────────
 *
 * There is no CRC32C on the KMS round trip, which Google's own guidance
 * recommends: in-transit corruption of the wrapped DEK or the AAD would be
 * stored as a blob that never decrypts, and nobody would find out until the
 * first read. Worth adding if these fields ever carry something that cannot
 * be re-obtained by asking the user to reconnect.
 *
 * `isEncryptedField` puts no length cap on the base64 fields and decodes them
 * a second time in `decryptField`. Firestore's 1 MiB document ceiling bounds
 * it, and every one of these fields is a token or a URL, so the work is
 * trivial in practice — but it is a bound the module borrows rather than one
 * it sets.
 */

/** The CryptoKey the DEKs are wrapped with, e.g. `projects/…/cryptoKeys/user-secrets`. */
export const KMS_KEY_ENV_VAR = 'MAYBESITTER_KMS_KEY_NAME';

/** The stored blob's shape version. Bump only with a reader for the old shape. */
export const FIELD_ENCRYPTION_VERSION = 1;

const DEK_BYTES = 32; // AES-256
const IV_BYTES = 12; // 96-bit nonce, the size GCM is specified for
const TAG_BYTES = 16;
const CIPHER = 'aes-256-gcm';

export type FieldEncryptionErrorCode =
  /** No KMS key is configured. A deployment fault: answer 503, never proceed. */
  | 'not_configured'
  /** The uid or purpose is empty or contains the `:` the AAD is joined with. */
  | 'invalid_scope'
  /** Asked to encrypt something that is not a non-empty string. */
  | 'invalid_plaintext'
  /** The stored value is not an `EncryptedField`. */
  | 'malformed_blob'
  /**
   * KMS never produced an authenticated result: unreachable, refused the
   * caller, or the key version is disabled. Transient — retry, and never
   * treat it as a verdict on the stored value.
   */
  | 'kms_unavailable'
  /**
   * The value was looked at and refused: wrong uid, wrong purpose, or
   * tampering. This is **not** a reason to delete the stored value either —
   * a blob that fails under one uid is still the rightful owner's secret.
   */
  | 'decrypt_failed';

const STATUS: Record<FieldEncryptionErrorCode, number> = {
  not_configured: 503,
  invalid_scope: 500,
  invalid_plaintext: 500,
  malformed_blob: 500,
  kms_unavailable: 503,
  decrypt_failed: 500,
};

/**
 * Why a field could not be encrypted or decrypted.
 *
 * The message is a fixed string per code. It never contains the uid, the
 * plaintext, any part of the blob, or the message of the error underneath,
 * so it is safe to put in a log line or an error response as it stands.
 *
 * Every *rejection* is the single code `decrypt_failed`, whatever was wrong
 * with it. Separating "wrong uid" from "tampered ciphertext" would tell
 * someone probing stored blobs which half of the attempt was already right.
 * A failure that never reached a verdict — KMS unreachable, permission
 * refused, key version disabled — is `kms_unavailable` instead; see the
 * module header for why that line is drawn where it is.
 */
export class FieldEncryptionError extends Error {
  readonly code: FieldEncryptionErrorCode;
  /** What a route should answer. 503 means the deployment is wrong, not the caller. */
  readonly status: number;

  constructor(code: FieldEncryptionErrorCode, message: string) {
    super(message);
    this.name = 'FieldEncryptionError';
    this.code = code;
    this.status = STATUS[code];
  }
}

/**
 * What is written to Firestore in place of the value.
 *
 * Every binary part is base64 so the whole thing survives a JSON round trip
 * unchanged. No field of it is derived from the plaintext.
 */
export interface EncryptedField {
  readonly v: typeof FIELD_ENCRYPTION_VERSION;
  /** The CryptoKeyVersion that wrapped the DEK. Audit only — see the header. */
  readonly kmsKeyVersion: string;
  readonly wrappedDek: string;
  readonly iv: string;
  readonly ciphertext: string;
  readonly tag: string;
}

export interface KmsEncryptRequest {
  /** The CryptoKey resource name. KMS picks the primary version itself. */
  readonly name: string;
  readonly plaintext: Buffer;
  readonly additionalAuthenticatedData: Buffer;
}

export interface KmsEncryptResponse {
  readonly ciphertext: Buffer;
  /** The CryptoKeyVersion KMS actually used. */
  readonly keyVersionName: string;
}

export interface KmsDecryptRequest {
  /** The CryptoKey resource name, not a version: KMS resolves the version. */
  readonly name: string;
  readonly ciphertext: Buffer;
  readonly additionalAuthenticatedData: Buffer;
}

export interface KmsDecryptResponse {
  readonly plaintext: Buffer;
}

/**
 * The only part of Cloud KMS this module uses, as an interface it can be
 * handed instead of reaching for the real one.
 *
 * This seam exists because the real keyring does not exist yet — creating it
 * is an owner action on the GCP project (#187's external chain, step 6) — and
 * because unit tests must not need network or GCP credentials to run. See
 * `lib/security/inMemoryKms.ts` for the double the tests use. The production
 * path is unchanged by the seam: pass no client and the real KMS client is
 * lazily constructed.
 *
 * One obligation on an implementation: when a `decrypt` call fails **without
 * reaching a verdict** on the ciphertext — unreachable, permission refused,
 * key version disabled — it must throw
 * `new FieldEncryptionError('kms_unavailable', …)`. Any other throw is read as
 * "KMS refused this blob" and surfaces as `decrypt_failed`. The production
 * implementation, `kmsClientFromSdk`, classifies with `isKmsRejection`; a
 * double that only ever succeeds or rejects has nothing to do.
 */
export interface KmsClient {
  encrypt(request: KmsEncryptRequest): Promise<KmsEncryptResponse>;
  decrypt(request: KmsDecryptRequest): Promise<KmsDecryptResponse>;
}

export interface FieldEncryptionOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly kms?: KmsClient;
}

/** The configured CryptoKey, or null when the deployment has not set one. */
export function fieldEncryptionKeyName(env: NodeJS.ProcessEnv = process.env): string | null {
  return env[KMS_KEY_ENV_VAR]?.trim() || null;
}

/**
 * The additional authenticated data a value is bound to.
 *
 * `:` is rejected in both halves rather than escaped. Without that, the pairs
 * (`user-a`, `b:ics-url`) and (`user-a:b`, `ics-url`) would produce the same
 * AAD, and the uid binding this whole module exists for would have a seam in
 * it. Firebase uids never contain `:`, so nothing legitimate is refused.
 */
export function additionalAuthenticatedData(uid: string, purpose: string): Buffer {
  for (const part of [uid, purpose]) {
    if (typeof part !== 'string' || part.length === 0 || part.includes(':')) {
      throw new FieldEncryptionError('invalid_scope', 'uid and purpose must be non-empty and contain no ":"');
    }
  }
  return Buffer.from(`${uid}:${purpose}`, 'utf8');
}

/**
 * A `purpose` that identifies one stored row, not just a kind of secret.
 *
 * The AAD binds (uid, purpose), so two values a user holds under the same
 * purpose are interchangeable — swap the blobs between two of #188's five ICS
 * feeds and nothing notices. `fieldPurpose('ics-url', feedId)` makes the
 * purpose unique per row, which closes that.
 *
 * Neither half may contain `:` (the AAD separator) or `/` (this separator),
 * so the composed string comes apart exactly one way and two different rows
 * can never produce one purpose.
 */
export function fieldPurpose(kind: string, rowId: string): string {
  for (const part of [kind, rowId]) {
    if (typeof part !== 'string' || part.length === 0 || part.includes(':') || part.includes('/')) {
      throw new FieldEncryptionError('invalid_scope', 'purpose parts must be non-empty and contain no ":" or "/"');
    }
  }
  return `${kind}/${rowId}`;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function base64Field(value: unknown, expectedBytes?: number): Buffer | null {
  if (typeof value !== 'string' || !BASE64.test(value)) return null;
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0) return null;
  if (expectedBytes !== undefined && decoded.length !== expectedBytes) return null;
  return decoded;
}

/**
 * Whether a value read back out of Firestore is a blob this module wrote.
 *
 * Worth checking before calling `decryptField`: a document written before a
 * field was encrypted would otherwise reach the decrypt path as a plain
 * string, and "it failed to decrypt" is a much less useful thing to know than
 * "this field was never encrypted".
 */
export function isEncryptedField(value: unknown): value is EncryptedField {
  if (typeof value !== 'object' || value === null) return false;
  const blob = value as Record<string, unknown>;
  return (
    blob.v === FIELD_ENCRYPTION_VERSION &&
    typeof blob.kmsKeyVersion === 'string' &&
    blob.kmsKeyVersion.length > 0 &&
    base64Field(blob.wrappedDek) !== null &&
    base64Field(blob.iv, IV_BYTES) !== null &&
    base64Field(blob.ciphertext) !== null &&
    base64Field(blob.tag, TAG_BYTES) !== null
  );
}

/** gRPC INVALID_ARGUMENT — what Cloud KMS answers for a ciphertext or AAD it refuses. */
const GRPC_INVALID_ARGUMENT = 3;

/**
 * Whether a Cloud KMS failure was a verdict on the ciphertext.
 *
 * Only `INVALID_ARGUMENT` is. Everything else — `UNAVAILABLE`,
 * `PERMISSION_DENIED`, `NOT_FOUND` on a mistyped key, `FAILED_PRECONDITION` on
 * a disabled key version, and any error whose shape is not recognised at all —
 * means the call never reached a verdict, and becomes `kms_unavailable`.
 *
 * Unrecognised errors default to "no verdict" on purpose. The two mistakes are
 * not symmetric: calling a rejection an outage costs a pointless retry, while
 * calling an outage a rejection invites the caller to delete a secret it could
 * have read a minute later.
 *
 * Exported so this mapping is testable without the SDK — it is the one piece
 * of the real client that has judgement in it.
 */
export function isKmsRejection(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === GRPC_INVALID_ARGUMENT;
}

let cachedKms: KmsClient | null = null;

/**
 * The slice of `@google-cloud/kms`'s generated client this module calls.
 *
 * Declared structurally so `kmsClientFromSdk` can be handed a stand-in. The
 * shapes are the SDK's: every response field is optional and nullable, and
 * bytes arrive as `Uint8Array` or as a base64 string.
 */
export interface KmsSdkClient {
  encrypt(request: {
    name: string;
    plaintext: Buffer;
    additionalAuthenticatedData: Buffer;
  }): Promise<[{ ciphertext?: Uint8Array | string | null; name?: string | null }, ...unknown[]]>;
  decrypt(request: {
    name: string;
    ciphertext: Buffer;
    additionalAuthenticatedData: Buffer;
  }): Promise<[{ plaintext?: Uint8Array | string | null }, ...unknown[]]>;
}

/**
 * Wraps the Cloud KMS SDK in this module's `KmsClient`.
 *
 * Split out from `realKms` because it holds the only judgement on the
 * production path: deciding whether a failed `decrypt` was Cloud KMS refusing
 * the ciphertext or Cloud KMS never answering. That decision is what keeps a
 * five-minute outage from reaching #188 as `decrypt_failed`, and it is worth
 * nothing unless it is tested — so it is reachable with a stand-in SDK client
 * instead of living inside a lazy import that needs gRPC and credentials.
 *
 * `isKmsRejection` is the predicate; this is the wiring around it, and both
 * are pinned separately because either one can be broken on its own.
 */
export function kmsClientFromSdk(client: KmsSdkClient): KmsClient {
  return {
    async encrypt(request) {
      // No classification here: nothing is stored yet, so every failure of the
      // wrap is the same answer — `encryptField` reports `kms_unavailable` and
      // the caller has no blob it could misread.
      const [response] = await client.encrypt({
        name: request.name,
        plaintext: request.plaintext,
        additionalAuthenticatedData: request.additionalAuthenticatedData,
      });
      if (!response?.ciphertext || !response.name) {
        throw new Error('kms encrypt returned no ciphertext');
      }
      return {
        ciphertext: Buffer.from(response.ciphertext as Uint8Array),
        keyVersionName: response.name,
      };
    },
    async decrypt(request) {
      let response;
      try {
        [response] = await client.decrypt({
          name: request.name,
          ciphertext: request.ciphertext,
          additionalAuthenticatedData: request.additionalAuthenticatedData,
        });
      } catch (error) {
        // The gRPC status code is the only place the difference between "KMS
        // refused this blob" and "KMS never answered" exists, and this adapter
        // is the only code here that knows the SDK, so it classifies rather
        // than leaking a gax error upwards. A rejection is rethrown as it came
        // and `decryptField` turns it into `decrypt_failed`; anything else is
        // an outage and says so.
        if (isKmsRejection(error)) throw error;
        throw new FieldEncryptionError('kms_unavailable', 'Cloud KMS could not be reached to unwrap the data key');
      }
      // A response with no plaintext is not a verdict on the ciphertext
      // either: KMS answered, but not with a decryption. Calling it
      // `decrypt_failed` would invite the caller to clear a readable secret.
      if (!response?.plaintext) {
        throw new FieldEncryptionError('kms_unavailable', 'Cloud KMS returned no plaintext for the data key');
      }
      return { plaintext: Buffer.from(response.plaintext as Uint8Array) };
    },
  };
}

/**
 * The real Cloud KMS client.
 *
 * `@google-cloud/kms` is imported lazily, following `lib/auth/schedulerOidc`:
 * unit tests inject their own client and must never load it (it pulls in gRPC
 * and tries to find application-default credentials), and a process that
 * encrypts nothing should not pay for it either.
 */
async function realKms(): Promise<KmsClient> {
  if (!cachedKms) {
    const { KeyManagementServiceClient } = await import('@google-cloud/kms');
    cachedKms = kmsClientFromSdk(new KeyManagementServiceClient() as unknown as KmsSdkClient);
  }
  return cachedKms;
}

/** Drops the memoised KMS client. For tests that swap the environment. */
export function resetFieldEncryptionForTests(): void {
  cachedKms = null;
}

function requireKeyName(env: NodeJS.ProcessEnv): string {
  const keyName = fieldEncryptionKeyName(env);
  if (!keyName) {
    throw new FieldEncryptionError(
      'not_configured',
      `${KMS_KEY_ENV_VAR} is not set; refusing to store the value unencrypted`,
    );
  }
  return keyName;
}

/**
 * Encrypt one field value for one user and one purpose.
 *
 * The result is the whole of what gets stored; there is no companion field
 * kept in the clear, and nothing in it is derived from the plaintext.
 */
export async function encryptField(
  uid: string,
  purpose: string,
  plaintext: string,
  options: FieldEncryptionOptions = {},
): Promise<EncryptedField> {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new FieldEncryptionError('invalid_plaintext', 'plaintext must be a non-empty string');
  }
  const keyName = requireKeyName(options.env ?? process.env);
  const aad = additionalAuthenticatedData(uid, purpose);
  const kms = options.kms ?? (await realKms());

  const dek = randomBytes(DEK_BYTES);
  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(CIPHER, dek, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    let wrapped: KmsEncryptResponse;
    try {
      wrapped = await kms.encrypt({ name: keyName, plaintext: dek, additionalAuthenticatedData: aad });
    } catch {
      // Deliberately not passed on: a gax error carries the request with it.
      throw new FieldEncryptionError('kms_unavailable', 'could not wrap the data key with Cloud KMS');
    }

    return {
      v: FIELD_ENCRYPTION_VERSION,
      kmsKeyVersion: wrapped.keyVersionName,
      wrappedDek: wrapped.ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: tag.toString('base64'),
    };
  } finally {
    // The DEK is the one thing here that is worth stealing out of a heap dump.
    dek.fill(0);
  }
}

/**
 * Decrypt a field written by `encryptField`, for the same uid and purpose.
 *
 * Any mismatch — a different uid, a different purpose, an altered blob, a
 * rewrapped DEK from another document — throws `decrypt_failed`. It never
 * returns a partial or wrong plaintext: AES-GCM verifies the tag before this
 * function has anything to return.
 */
export async function decryptField(
  uid: string,
  purpose: string,
  blob: unknown,
  options: FieldEncryptionOptions = {},
): Promise<string> {
  const keyName = requireKeyName(options.env ?? process.env);
  const aad = additionalAuthenticatedData(uid, purpose);
  if (!isEncryptedField(blob)) {
    throw new FieldEncryptionError('malformed_blob', 'the stored value is not an encrypted field');
  }
  const kms = options.kms ?? (await realKms());

  const wrappedDek = Buffer.from(blob.wrappedDek, 'base64');
  const iv = Buffer.from(blob.iv, 'base64');
  const ciphertext = Buffer.from(blob.ciphertext, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');

  let dek: Buffer;
  try {
    // The CryptoKey, never `blob.kmsKeyVersion`: KMS finds the version that
    // wrapped this DEK, which is what lets a 90-day rotation happen without
    // rewriting a single stored value.
    const unwrapped = await kms.decrypt({ name: keyName, ciphertext: wrappedDek, additionalAuthenticatedData: aad });
    dek = Buffer.from(unwrapped.plaintext);
  } catch (error) {
    // A `KmsClient` says "this call never reached a verdict" by throwing
    // `kms_unavailable` itself — see the interface. That is an outage, and
    // passing it on as `decrypt_failed` would invite the caller to clear a
    // secret over a network blip.
    if (error instanceof FieldEncryptionError && error.code === 'kms_unavailable') throw error;
    // Everything else is a rejection: a wrong uid lands here, and so does a
    // corrupt wrapped DEK. They share one code, because distinguishing them
    // would confirm to a prober that the AAD was the only thing wrong.
    throw new FieldEncryptionError('decrypt_failed', 'the field could not be decrypted');
  }

  try {
    if (dek.length !== DEK_BYTES) {
      throw new FieldEncryptionError('decrypt_failed', 'the field could not be decrypted');
    }
    const decipher = createDecipheriv(CIPHER, dek, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new FieldEncryptionError('decrypt_failed', 'the field could not be decrypted');
  } finally {
    dek.fill(0);
  }
}
