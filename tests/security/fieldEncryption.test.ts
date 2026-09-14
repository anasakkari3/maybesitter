import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FieldEncryptionError,
  KMS_KEY_ENV_VAR,
  additionalAuthenticatedData,
  decryptField,
  encryptField,
  fieldEncryptionKeyName,
  fieldPurpose,
  isEncryptedField,
  isKmsRejection,
  kmsClientFromSdk,
  type EncryptedField,
  type FieldEncryptionOptions,
  type KmsClient,
  type KmsSdkClient,
} from '../../lib/security/fieldEncryption';
import { createInMemoryKms } from '../../lib/security/inMemoryKms';

// The values this module protects are bearer secrets: a Google refresh token
// (#187) and a Moodle feed URL with an `authtoken=` in it (#188). So the
// interesting cases are not "does a round trip work" — they are every way a
// value could come back out for someone it was not encrypted for, and every
// way a missing key could end with the secret stored as text.

const UID = 'firebase-uid-aaaaaaaaaaaaaaaaaaaa';
const OTHER_UID = 'firebase-uid-bbbbbbbbbbbbbbbbbbbb';
const PURPOSE = 'ics-url';
const SECRET = 'https://moodle.example.edu/calendar/export_execute.php?authtoken=sup3r-s3cret-t0ken';

/** A fresh double plus the env that points the module at it. */
function fixture() {
  const kms = createInMemoryKms();
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', [KMS_KEY_ENV_VAR]: kms.keyName };
  const options: FieldEncryptionOptions = { env, kms };
  return { kms, env, options };
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('a value encrypted for a uid and purpose comes back unchanged', async () => {
  const { options } = fixture();
  const blob = await encryptField(UID, PURPOSE, SECRET, options);
  assert.equal(await decryptField(UID, PURPOSE, blob, options), SECRET);
});

test('nothing stored is derived from the plaintext', async () => {
  const { options } = fixture();
  const blob = await encryptField(UID, PURPOSE, SECRET, options);

  // What a route would actually write to Firestore, including the wrapper the
  // document puts around it — this is the grep #188's acceptance criteria ask
  // for, done against the thing that gets stored rather than against a log.
  const stored = JSON.stringify({ kind: 'ics', label: 'University', encryptedUrl: blob });

  for (const form of [
    SECRET,
    'sup3r-s3cret-t0ken',
    'authtoken',
    'moodle.example.edu',
    Buffer.from(SECRET, 'utf8').toString('base64'),
    Buffer.from(SECRET, 'utf8').toString('hex'),
    encodeURIComponent(SECRET),
  ]) {
    assert.equal(stored.includes(form), false, `the stored document leaks ${form.slice(0, 24)}`);
  }
  // And the ciphertext is not a reversible transform of the plaintext either:
  // its length is the only thing that survives, which AES-GCM does not hide.
  assert.equal(Buffer.from(blob.ciphertext, 'base64').toString('utf8').includes('authtoken'), false);
});

test('encrypting the same value twice produces two different blobs', async () => {
  const { options } = fixture();
  const first = await encryptField(UID, PURPOSE, SECRET, options);
  const second = await encryptField(UID, PURPOSE, SECRET, options);
  // A fresh DEK and IV each time. Equal blobs would mean equal ciphertext for
  // equal plaintext, which leaks that two users subscribed to the same feed.
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.wrappedDek, second.wrappedDek);
});

test('the DEK is zeroed once the value is wrapped', async () => {
  const { env, kms } = fixture();

  // The DEK is the one thing in this module worth stealing out of a heap dump:
  // it opens exactly one stored value without any call to KMS. The module says
  // it wipes it, so hold the very buffer it hands to the wrap and look at it
  // after the call returns.
  let handedToKms: Buffer | null = null;
  const watching: KmsClient = {
    async encrypt(request) {
      handedToKms = request.plaintext;
      return kms.encrypt(request);
    },
    decrypt: (request) => kms.decrypt(request),
  };

  await encryptField(UID, PURPOSE, SECRET, { env, kms: watching });

  const dek: Buffer = handedToKms!;
  assert.equal(dek.length, 32);
  assert.deepEqual(dek, Buffer.alloc(32), 'the DEK was left in memory after wrapping');
});

test("another uid's AAD does not decrypt the value", async () => {
  const { options } = fixture();
  const blob = await encryptField(UID, PURPOSE, SECRET, options);

  // #187's acceptance criteria state this outright. Copying the field into
  // another user's document must not hand that user a working secret.
  await assert.rejects(
    () => decryptField(OTHER_UID, PURPOSE, blob, options),
    (error: unknown) => error instanceof FieldEncryptionError && error.code === 'decrypt_failed',
  );
});

test('a different purpose does not decrypt the value', async () => {
  const { options } = fixture();
  const blob = await encryptField(UID, 'ics-url', SECRET, options);
  // Stops a feed URL being read back through the code path that handles
  // Google refresh tokens, and vice versa.
  await assert.rejects(
    () => decryptField(UID, 'google-refresh-token', blob, options),
    (error: unknown) => error instanceof FieldEncryptionError && error.code === 'decrypt_failed',
  );
});

test('the uid binding holds at the KMS layer on its own', async () => {
  const { kms, options } = fixture();
  await encryptField(UID, PURPOSE, SECRET, options);
  const wrap = kms.calls.find((call) => call.op === 'encrypt');
  // The AAD reaches KMS as well as the local cipher, so the binding survives
  // even if the local AES-GCM layer were ever changed or removed.
  assert.equal(wrap?.aad, `${UID}:${PURPOSE}`);
});

test('a tampered ciphertext is refused, not partially decrypted', async () => {
  const { options } = fixture();
  const blob = await encryptField(UID, PURPOSE, SECRET, options);

  const cipherBytes = Buffer.from(blob.ciphertext, 'base64');
  cipherBytes[0] ^= 0x01;
  const tampered: EncryptedField = { ...blob, ciphertext: cipherBytes.toString('base64') };

  await assert.rejects(
    () => decryptField(UID, PURPOSE, tampered, options),
    (error: unknown) => error instanceof FieldEncryptionError && error.code === 'decrypt_failed',
  );
});

test('tampering with any other part of the blob is refused too', async () => {
  const { options } = fixture();
  const blob = await encryptField(UID, PURPOSE, SECRET, options);

  const flip = (value: string) => {
    const bytes = Buffer.from(value, 'base64');
    bytes[0] ^= 0x01;
    return bytes.toString('base64');
  };

  for (const tampered of [
    { ...blob, iv: flip(blob.iv) },
    { ...blob, tag: flip(blob.tag) },
    { ...blob, wrappedDek: flip(blob.wrappedDek) },
  ]) {
    await assert.rejects(
      () => decryptField(UID, PURPOSE, tampered, options),
      (error: unknown) => error instanceof FieldEncryptionError && error.code === 'decrypt_failed',
    );
  }
});

test("a DEK from another document does not open this one", async () => {
  const { options } = fixture();
  const mine = await encryptField(UID, PURPOSE, SECRET, options);
  const theirs = await encryptField(UID, PURPOSE, 'a different secret', options);

  // Same uid, same purpose, same key — so KMS unwraps the borrowed DEK
  // happily. The local GCM tag is what refuses, which is the reason the
  // envelope authenticates at both layers rather than trusting the wrap.
  await assert.rejects(
    () => decryptField(UID, PURPOSE, { ...mine, wrappedDek: theirs.wrappedDek }, options),
    (error: unknown) => error instanceof FieldEncryptionError && error.code === 'decrypt_failed',
  );
});

test('a value keeps decrypting after the key rotates', async () => {
  const { kms, options } = fixture();
  const beforeRotation = await encryptField(UID, PURPOSE, SECRET, options);
  assert.equal(beforeRotation.kmsKeyVersion, kms.primaryVersion());

  // #187 asks for 90-day rotation. If an old value stopped decrypting on the
  // first rotation, every connected calendar would silently need reconnecting.
  const newVersion = kms.rotate();
  assert.notEqual(newVersion, beforeRotation.kmsKeyVersion);

  assert.equal(await decryptField(UID, PURPOSE, beforeRotation, options), SECRET);

  const afterRotation = await encryptField(UID, PURPOSE, SECRET, options);
  assert.equal(afterRotation.kmsKeyVersion, newVersion);
  assert.equal(await decryptField(UID, PURPOSE, afterRotation, options), SECRET);

  // Both still readable, in either order, with no migration pass.
  assert.equal(await decryptField(UID, PURPOSE, beforeRotation, options), SECRET);
});

test('decryption addresses the CryptoKey, never the stored version', async () => {
  const { kms, options } = fixture();
  const blob = await encryptField(UID, PURPOSE, SECRET, options);
  kms.rotate();
  await decryptField(UID, PURPOSE, blob, options);

  // Naming the version in the decrypt call is what would turn a rotation into
  // a data-loss event once the old version is eventually destroyed, so the
  // module must ask for the key and let KMS resolve the version.
  for (const call of kms.calls) assert.equal(call.name, kms.keyName);
});

test('a missing key configuration fails loudly instead of storing plaintext', async () => {
  const kms = createInMemoryKms();
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test' };

  assert.equal(fieldEncryptionKeyName(env), null);

  await assert.rejects(
    () => encryptField(UID, PURPOSE, SECRET, { env, kms }),
    (error: unknown) =>
      error instanceof FieldEncryptionError && error.code === 'not_configured' && error.status === 503,
  );
  // Nothing was attempted and, crucially, nothing was returned that a caller
  // could have written to Firestore believing it was encrypted.
  assert.deepEqual(kms.calls, []);
});

test('a blank key configuration is missing configuration, not a key', async () => {
  const kms = createInMemoryKms();
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', [KMS_KEY_ENV_VAR]: '   ' };
  await assert.rejects(
    () => encryptField(UID, PURPOSE, SECRET, { env, kms }),
    (error: unknown) => error instanceof FieldEncryptionError && error.code === 'not_configured',
  );
});

test('decryption without a configured key fails closed as well', async () => {
  const { options, kms } = fixture();
  const blob = await encryptField(UID, PURPOSE, SECRET, options);

  await assert.rejects(
    () => decryptField(UID, PURPOSE, blob, { env: { NODE_ENV: 'test' }, kms }),
    (error: unknown) =>
      error instanceof FieldEncryptionError && error.code === 'not_configured' && error.status === 503,
  );
});

test('a KMS that cannot be reached is 503, and yields no blob', async () => {
  const { env } = fixture();
  const broken = {
    encrypt: async () => {
      throw new Error('UNAVAILABLE: 14');
    },
    decrypt: async () => {
      throw new Error('UNAVAILABLE: 14');
    },
  };
  await assert.rejects(
    () => encryptField(UID, PURPOSE, SECRET, { env, kms: broken }),
    (error: unknown) =>
      error instanceof FieldEncryptionError && error.code === 'kms_unavailable' && error.status === 503,
  );
});

test('an empty plaintext is refused rather than stored as an empty envelope', async () => {
  const { options } = fixture();
  await assert.rejects(
    () => encryptField(UID, PURPOSE, '', options),
    (error: unknown) => error instanceof FieldEncryptionError && error.code === 'invalid_plaintext',
  );
});

test('a uid or purpose containing ":" is refused', () => {
  // Without this the pairs ("uid-a", "b:ics-url") and ("uid-a:b", "ics-url")
  // would share an AAD, which is a seam in the binding the module exists for.
  for (const [uid, purpose] of [
    [`${UID}:extra`, PURPOSE],
    [UID, 'ics:url'],
    ['', PURPOSE],
    [UID, ''],
  ] as const) {
    assert.throws(
      () => additionalAuthenticatedData(uid, purpose),
      (error: unknown) => error instanceof FieldEncryptionError && error.code === 'invalid_scope',
    );
  }
  assert.equal(additionalAuthenticatedData(UID, PURPOSE).toString('utf8'), `${UID}:${PURPOSE}`);
});

test('a value that was never encrypted is reported as such, not as a decrypt failure', async () => {
  const { options } = fixture();
  const blob = await encryptField(UID, PURPOSE, SECRET, options);

  for (const notABlob of [
    SECRET,
    null,
    undefined,
    {},
    { ...blob, v: 2 },
    { ...blob, iv: Buffer.alloc(8).toString('base64') },
    { ...blob, tag: Buffer.alloc(8).toString('base64') },
    { ...blob, kmsKeyVersion: '' },
    { ...blob, wrappedDek: 'not base64!' },
  ]) {
    assert.equal(isEncryptedField(notABlob), false);
    await assert.rejects(
      () => decryptField(UID, PURPOSE, notABlob, options),
      (error: unknown) => error instanceof FieldEncryptionError && error.code === 'malformed_blob',
    );
  }
  assert.equal(isEncryptedField(blob), true);
});

test('the module logs nothing and loads the KMS SDK lazily', () => {
  const source = readFileSync(join(repoRoot, 'lib', 'security', 'fieldEncryption.ts'), 'utf8');

  // A single `console.log` of a blob or a DEK undoes the whole module, and it
  // is the kind of line that gets added while debugging and left behind.
  assert.equal(/\bconsole\s*\./.test(source), false, 'fieldEncryption.ts must not log');

  // The SDK must be reachable only through `await import`, so that these tests
  // — and any process that encrypts nothing — never load gRPC or go looking
  // for application-default credentials.
  assert.equal(/^import .*@google-cloud\/kms/m.test(source), false, 'the KMS SDK must not be imported statically');
  assert.equal(source.includes("await import('@google-cloud/kms')"), true);
});

// ── Each layer of the AAD binding, with the other one held open ────
//
// The module claims the uid binding is enforced twice, so that neither layer
// can be removed as "redundant" without something going red. Proving that
// needs a test per layer that the *other* layer cannot satisfy — dropping the
// AAD from both at once only shows at least one of them is doing the work.

/**
 * A `KmsClient` that unwraps a DEK whatever AAD it is handed.
 *
 * It replays the AAD the DEK was wrapped under, so the KMS layer contributes
 * no binding at all and only the local AES-GCM tag can refuse. That is exactly
 * the module a reviewer would be left with after deleting `cipher.setAAD` on
 * the grounds that KMS already authenticates the field.
 */
function kmsThatIgnoresAadOnUnwrap(): KmsClient & { keyName: string } {
  const inner = createInMemoryKms();
  const wrapAad = new Map<string, Buffer>();
  return {
    keyName: inner.keyName,
    async encrypt(request) {
      const response = await inner.encrypt(request);
      wrapAad.set(response.ciphertext.toString('base64'), request.additionalAuthenticatedData);
      return response;
    },
    async decrypt(request) {
      const asWrapped = wrapAad.get(request.ciphertext.toString('base64'));
      return inner.decrypt({ ...request, additionalAuthenticatedData: asWrapped ?? request.additionalAuthenticatedData });
    },
  };
}

test('the local cipher refuses another uid even when KMS ignores the AAD', async () => {
  const kms = kmsThatIgnoresAadOnUnwrap();
  const options: FieldEncryptionOptions = { env: { NODE_ENV: 'test', [KMS_KEY_ENV_VAR]: kms.keyName }, kms };
  const blob = await encryptField(UID, PURPOSE, SECRET, options);

  // First prove the double really is toothless, or the rejection below would
  // pass for the wrong reason — a KMS that failed everything would too.
  assert.equal(await decryptField(UID, PURPOSE, blob, options), SECRET);

  await assert.rejects(
    () => decryptField(OTHER_UID, PURPOSE, blob, options),
    (error: unknown) => error instanceof FieldEncryptionError && error.code === 'decrypt_failed',
  );
});

test('the KMS wrap refuses another uid on its own', async () => {
  const { kms, options } = fixture();
  const blob = await encryptField(UID, PURPOSE, SECRET, options);

  // Straight at the wrap, with the local cipher out of the picture entirely:
  // the DEK does not come back out under a uid it was not wrapped for.
  await assert.rejects(() =>
    kms.decrypt({
      name: kms.keyName,
      ciphertext: Buffer.from(blob.wrappedDek, 'base64'),
      additionalAuthenticatedData: additionalAuthenticatedData(OTHER_UID, PURPOSE),
    }),
  );
  // And comes back out under the right one, so the rejection above is the AAD.
  const unwrapped = await kms.decrypt({
    name: kms.keyName,
    ciphertext: Buffer.from(blob.wrappedDek, 'base64'),
    additionalAuthenticatedData: additionalAuthenticatedData(UID, PURPOSE),
  });
  assert.equal(unwrapped.plaintext.length, 32);
});

// ── An outage is not a verdict on the stored value ─────────────────

test('an unreachable KMS on decrypt is 503, not a decryption failure', async () => {
  const { options, kms } = fixture();
  const blob = await encryptField(UID, PURPOSE, SECRET, options);

  const unreachable: KmsClient = {
    encrypt: async () => {
      throw new FieldEncryptionError('kms_unavailable', 'unreachable');
    },
    decrypt: async () => {
      throw new FieldEncryptionError('kms_unavailable', 'unreachable');
    },
  };

  // #188 reads a stored feed URL on every refresh. If a five-minute KMS blip
  // came back as `decrypt_failed`, a caller that reasonably treats that as "no
  // longer readable" would clear every user's feed URL over a network hiccup.
  await assert.rejects(
    () => decryptField(UID, PURPOSE, blob, { env: options.env, kms: unreachable }),
    (error: unknown) =>
      error instanceof FieldEncryptionError && error.code === 'kms_unavailable' && error.status === 503,
  );

  // A rejection still is one: the two are told apart, not merged.
  await assert.rejects(
    () => decryptField(OTHER_UID, PURPOSE, blob, options),
    (error: unknown) => error instanceof FieldEncryptionError && error.code === 'decrypt_failed',
  );
});

/**
 * A stand-in for the `@google-cloud/kms` generated client.
 *
 * It answers in the SDK's shape — a tuple whose first element has optional,
 * nullable fields — and is backed by the in-memory double so a round trip
 * through the real adapter actually works. `fault` makes it behave like a
 * service that is down, refusing the caller, or answering with nothing.
 */
function sdkClient(
  inner: ReturnType<typeof createInMemoryKms>,
  fault: { throwOnDecrypt?: unknown; emptyDecrypt?: boolean } = {},
): KmsSdkClient {
  return {
    async encrypt(request) {
      const wrapped = await inner.encrypt(request);
      return [{ ciphertext: wrapped.ciphertext, name: wrapped.keyVersionName }];
    },
    async decrypt(request) {
      if (fault.throwOnDecrypt !== undefined) throw fault.throwOnDecrypt;
      if (fault.emptyDecrypt) return [{}];
      const unwrapped = await inner.decrypt(request);
      return [{ plaintext: unwrapped.plaintext }];
    },
  };
}

test('the production KMS adapter round-trips a value', async () => {
  // Proves the adapter works at all, so the rejections in the next two tests
  // are the classification and not an adapter that fails everything.
  const inner = createInMemoryKms();
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', [KMS_KEY_ENV_VAR]: inner.keyName };
  const kms = kmsClientFromSdk(sdkClient(inner));

  const blob = await encryptField(UID, PURPOSE, SECRET, { env, kms });
  assert.equal(blob.kmsKeyVersion, inner.primaryVersion());
  assert.equal(await decryptField(UID, PURPOSE, blob, { env, kms }), SECRET);
});

test('the production KMS adapter turns an outage into 503, not a decryption failure', async () => {
  const inner = createInMemoryKms();
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', [KMS_KEY_ENV_VAR]: inner.keyName };
  const blob = await encryptField(UID, PURPOSE, SECRET, { env, kms: kmsClientFromSdk(sdkClient(inner)) });

  // This is the path #188 actually runs against Cloud KMS, so testing the
  // `isKmsRejection` predicate alone is not enough: the wiring around it can
  // be deleted on its own and the predicate stays green.
  for (const fault of [
    Object.assign(new Error('14 UNAVAILABLE: connect failed'), { code: 14 }),
    Object.assign(new Error('7 PERMISSION_DENIED'), { code: 7 }),
    Object.assign(new Error('5 NOT_FOUND'), { code: 5 }), // a mistyped key name
    Object.assign(new Error('9 FAILED_PRECONDITION'), { code: 9 }), // key version disabled
    new Error('connect ECONNREFUSED'), // no status at all
  ]) {
    const kms = kmsClientFromSdk(sdkClient(inner, { throwOnDecrypt: fault }));
    await assert.rejects(
      () => decryptField(UID, PURPOSE, blob, { env, kms }),
      (error: unknown) =>
        error instanceof FieldEncryptionError && error.code === 'kms_unavailable' && error.status === 503,
      `${fault.message} must not reach the caller as a verdict on the blob`,
    );
  }
});

test('the production KMS adapter still reports a refused blob as a decryption failure', async () => {
  const inner = createInMemoryKms();
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', [KMS_KEY_ENV_VAR]: inner.keyName };
  const blob = await encryptField(UID, PURPOSE, SECRET, { env, kms: kmsClientFromSdk(sdkClient(inner)) });

  // INVALID_ARGUMENT is Cloud KMS saying it looked and refused — a wrong uid
  // in the AAD, or a tampered wrapped DEK. Collapsing that into the outage
  // code would make tampering indistinguishable from a network blip.
  const refused = Object.assign(new Error('3 INVALID_ARGUMENT: Decryption failed'), { code: 3 });
  await assert.rejects(
    () => decryptField(UID, PURPOSE, blob, { env, kms: kmsClientFromSdk(sdkClient(inner, { throwOnDecrypt: refused })) }),
    (error: unknown) => error instanceof FieldEncryptionError && error.code === 'decrypt_failed',
  );
});

test('a KMS reply carrying no plaintext is an outage, not a verdict', async () => {
  const inner = createInMemoryKms();
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', [KMS_KEY_ENV_VAR]: inner.keyName };
  const blob = await encryptField(UID, PURPOSE, SECRET, { env, kms: kmsClientFromSdk(sdkClient(inner)) });

  // KMS answered, but not with a decryption. Nothing was refused, so nothing
  // about the stored value has been established.
  await assert.rejects(
    () => decryptField(UID, PURPOSE, blob, { env, kms: kmsClientFromSdk(sdkClient(inner, { emptyDecrypt: true })) }),
    (error: unknown) =>
      error instanceof FieldEncryptionError && error.code === 'kms_unavailable' && error.status === 503,
  );
});

test('only INVALID_ARGUMENT counts as Cloud KMS refusing a blob', () => {
  // This is the whole of the real client's judgement, and it cannot be
  // exercised through `decryptField` without the SDK, so it is tested here.
  assert.equal(isKmsRejection({ code: 3 }), true); // INVALID_ARGUMENT

  for (const notARejection of [
    { code: 14 }, // UNAVAILABLE
    { code: 4 }, // DEADLINE_EXCEEDED
    { code: 7 }, // PERMISSION_DENIED
    { code: 5 }, // NOT_FOUND — a mistyped key name
    { code: 9 }, // FAILED_PRECONDITION — key version disabled
    { code: '3' }, // a string, not the numeric status
    new Error('connect ECONNREFUSED'),
    null,
    undefined,
    'boom',
  ]) {
    // An unrecognised shape defaults to "no verdict": a pointless retry is a
    // cheaper mistake than a caller deleting a secret it could have read.
    assert.equal(isKmsRejection(notARejection), false, `${JSON.stringify(notARejection)} must not read as a rejection`);
  }
});

// ── One purpose per stored row ─────────────────────────────────────

test('two rows under the same kind are not interchangeable', async () => {
  const { options } = fixture();
  // #188 allows five ICS feeds per user. Under a bare `ics-url` purpose their
  // blobs would be swappable between rows with nothing noticing, because the
  // AAD knows the uid and the purpose and not which document it came from.
  const first = fieldPurpose('ics-url', 'feed-a');
  const second = fieldPurpose('ics-url', 'feed-b');
  assert.equal(first, 'ics-url/feed-a');

  const blobA = await encryptField(UID, first, SECRET, options);
  const blobB = await encryptField(UID, second, 'https://other.example.edu/ics?authtoken=b', options);

  assert.equal(await decryptField(UID, first, blobA, options), SECRET);
  for (const swapped of [
    [first, blobB],
    [second, blobA],
  ] as const) {
    await assert.rejects(
      () => decryptField(UID, swapped[0], swapped[1], options),
      (error: unknown) => error instanceof FieldEncryptionError && error.code === 'decrypt_failed',
    );
  }
});

test('a row purpose cannot be built ambiguously', () => {
  for (const [kind, rowId] of [
    ['ics-url', 'feed/b'],
    ['ics/url', 'feed-b'],
    ['ics-url', 'feed:b'],
    ['ics:url', 'feed-b'],
    ['', 'feed-b'],
    ['ics-url', ''],
  ] as const) {
    assert.throws(
      () => fieldPurpose(kind, rowId),
      (error: unknown) => error instanceof FieldEncryptionError && error.code === 'invalid_scope',
    );
  }
});

// ── The test double stays a test double ────────────────────────────

/**
 * `NODE_ENV` is read-only on this repo's `ProcessEnv`, so it is set through a
 * widened key, the way `tests/extraction/llmProvider.test.ts` does it.
 */
function withNodeEnv<T>(value: string, run: () => T): T {
  const key: string = 'NODE_ENV';
  const previous = process.env[key];
  process.env[key] = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

test('the in-memory KMS refuses to exist in production', () => {
  // Its key material is a process-local buffer. Wired into a deployment it
  // would ship fields that read as encrypted and are not, which nothing
  // downstream could detect — so the guard is worth a test of its own.
  withNodeEnv('production', () => {
    assert.throws(() => createInMemoryKms(), /must never be constructed in production/);
  });
  // And it still exists everywhere else, so the guard is the env and not a
  // constructor that always throws.
  assert.notEqual(createInMemoryKms().keyName, '');
});
