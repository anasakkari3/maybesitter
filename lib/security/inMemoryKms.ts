import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { KmsClient, KmsDecryptRequest, KmsDecryptResponse, KmsEncryptRequest, KmsEncryptResponse } from './fieldEncryption';

/**
 * A Cloud KMS stand-in that lives in one process (UC-3.3, #187 step 1).
 *
 * ── Why this exists ──────────────────────────────────────────────
 *
 * The real keyring does not exist yet: creating
 * `projects/maybesitter-app/locations/europe-west1/keyRings/maybesitter/cryptoKeys/user-secrets`
 * is an owner action on the GCP project, and #187 is deferred behind a chain
 * of them. `lib/security/fieldEncryption.ts` still has to be provably correct
 * before then, and its tests have to run with no network and no credentials —
 * on a laptop, and in CI, where neither is available.
 *
 * So this implements `KmsClient` with the semantics the module actually
 * depends on, and nothing else:
 *
 * - Encryption uses the **primary** key version, and reports which one.
 * - Decryption resolves the version from the ciphertext, not from the caller.
 *   This is the property that makes rotation a non-event, and the only way to
 *   test it before a real 90-day rotation has ever happened.
 * - The AAD is authenticated. Decrypting with different AAD fails, which is
 *   what proves the uid binding holds at the KMS layer and not only in the
 *   local AES-GCM layer.
 * - The key name is checked, so a test cannot pass by pointing at the wrong
 *   key and getting a plausible answer back.
 *
 * It is **not** a security boundary: the key material is a process-local
 * buffer, so anything encrypted with it is protected only as well as the heap
 * it sits in. It refuses to exist in production for that reason — the failure
 * mode it guards against is someone wiring the test double into a deployment
 * and shipping "encrypted" fields that anyone with the process can read.
 */

export interface InMemoryKms extends KmsClient {
  /** The CryptoKey this double answers for. Requests naming anything else fail. */
  readonly keyName: string;
  /** The CryptoKeyVersion `encrypt` is currently using. */
  primaryVersion(): string;
  /** Adds a version and makes it primary, as a 90-day rotation would. */
  rotate(): string;
  /** Every request, for tests that assert what the module asked KMS to do. */
  readonly calls: ReadonlyArray<{ op: 'encrypt' | 'decrypt'; name: string; aad: string }>;
}

const DEFAULT_KEY_NAME =
  'projects/maybesitter-test/locations/europe-west1/keyRings/maybesitter/cryptoKeys/user-secrets';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION_PREFIX_BYTES = 2;

export function createInMemoryKms(options: { keyName?: string } = {}): InMemoryKms {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('createInMemoryKms is a test double and must never be constructed in production');
  }
  const keyName = options.keyName ?? DEFAULT_KEY_NAME;
  const versions: Buffer[] = [randomBytes(32)];
  const calls: Array<{ op: 'encrypt' | 'decrypt'; name: string; aad: string }> = [];

  const versionName = (index: number) => `${keyName}/cryptoKeyVersions/${index + 1}`;

  return {
    keyName,
    calls,
    primaryVersion: () => versionName(versions.length - 1),
    rotate() {
      versions.push(randomBytes(32));
      return versionName(versions.length - 1);
    },

    async encrypt(request: KmsEncryptRequest): Promise<KmsEncryptResponse> {
      calls.push({ op: 'encrypt', name: request.name, aad: request.additionalAuthenticatedData.toString('utf8') });
      if (request.name !== keyName) throw new Error(`unknown key ${request.name}`);

      const index = versions.length - 1;
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', versions[index]!, iv);
      cipher.setAAD(request.additionalAuthenticatedData);
      const body = Buffer.concat([cipher.update(request.plaintext), cipher.final()]);

      // The version index travels inside the opaque ciphertext, the way the
      // real service keeps it: the caller never has to name a version.
      const header = Buffer.alloc(VERSION_PREFIX_BYTES);
      header.writeUInt16BE(index, 0);
      return {
        ciphertext: Buffer.concat([header, iv, cipher.getAuthTag(), body]),
        keyVersionName: versionName(index),
      };
    },

    async decrypt(request: KmsDecryptRequest): Promise<KmsDecryptResponse> {
      calls.push({ op: 'decrypt', name: request.name, aad: request.additionalAuthenticatedData.toString('utf8') });
      if (request.name !== keyName) throw new Error(`unknown key ${request.name}`);

      const blob = request.ciphertext;
      if (blob.length < VERSION_PREFIX_BYTES + IV_BYTES + TAG_BYTES) throw new Error('ciphertext is too short');
      const index = blob.readUInt16BE(0);
      const key = versions[index];
      if (!key) throw new Error('ciphertext names a key version that does not exist');

      const iv = blob.subarray(VERSION_PREFIX_BYTES, VERSION_PREFIX_BYTES + IV_BYTES);
      const tag = blob.subarray(VERSION_PREFIX_BYTES + IV_BYTES, VERSION_PREFIX_BYTES + IV_BYTES + TAG_BYTES);
      const body = blob.subarray(VERSION_PREFIX_BYTES + IV_BYTES + TAG_BYTES);

      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(request.additionalAuthenticatedData);
      decipher.setAuthTag(tag);
      // Throws on a wrong AAD or a tampered blob, as the real service does.
      return { plaintext: Buffer.concat([decipher.update(body), decipher.final()]) };
    },
  };
}
