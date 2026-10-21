/**
 * This phone's calendar source credential (M5a R1.1, M5A-R55-001/R56-001).
 *
 * The properties worth holding: one secure-store value, minted once even when
 * two passes ask at a cold start; a malformed value is replaced by a whole new
 * tuple rather than patched; a refusing keychain answers null so nothing is
 * registered; and a fresh mint for «رجّع هاد التلفون» never reuses the old
 * installation id.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as SecureStore from 'expo-secure-store';
import {
  deleteSourceCredential,
  ensureSourceCredential,
  mintFreshSourceCredential,
  readSourceCredential,
  resetSourceCredentialForTests,
} from '../sourceCredential';

const UID = 'uid-credential';

beforeEach(() => {
  (SecureStore as unknown as { __reset(): void }).__reset();
  resetSourceCredentialForTests();
  jest.restoreAllMocks();
});

describe('the source credential', () => {
  it('is minted once, as one value, when two passes ask at the same time', async () => {
    const writes = jest.spyOn(SecureStore, 'setItemAsync');
    const [a, b] = await Promise.all([ensureSourceCredential(UID), ensureSourceCredential(UID)]);
    expect(a).not.toBeNull();
    expect(b).toEqual(a);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(writes.mock.calls[0]![1]))).toEqual({
      sourceInstallationId: a!.sourceInstallationId, sourceSecret: a!.sourceSecret, registrationId: a!.registrationId,
    });
    expect(a!.sourceSecret.length).toBeGreaterThanOrEqual(24);
  });

  it('is kept per account', async () => {
    const a = await ensureSourceCredential(UID);
    const b = await ensureSourceCredential('uid-other');
    expect(b!.sourceInstallationId).not.toBe(a!.sourceInstallationId);
    expect((await readSourceCredential(UID))!.sourceInstallationId).toBe(a!.sourceInstallationId);
  });

  it('replaces a malformed value with a whole new tuple', async () => {
    const first = await ensureSourceCredential(UID);
    await SecureStore.setItemAsync(`calendar_source_credential.v1.${UID}`, '{"sourceSecret":"short"}');
    resetSourceCredentialForTests();
    const second = await ensureSourceCredential(UID);
    expect(second!.sourceInstallationId).not.toBe(first!.sourceInstallationId);
  });

  it('answers null when the keychain refuses, and stores nothing', async () => {
    jest.spyOn(SecureStore, 'setItemAsync').mockRejectedValue(new Error('keychain unavailable'));
    expect(await ensureSourceCredential(UID)).toBeNull();
    jest.restoreAllMocks();
    expect(await readSourceCredential(UID)).toBeNull();
  });

  it('mints an entirely new tuple to rejoin, and deletes it on removal', async () => {
    const old = await ensureSourceCredential(UID);
    const fresh = await mintFreshSourceCredential(UID);
    expect(fresh!.sourceInstallationId).not.toBe(old!.sourceInstallationId);
    expect(fresh!.sourceSecret).not.toBe(old!.sourceSecret);
    expect((await readSourceCredential(UID))!.sourceInstallationId).toBe(fresh!.sourceInstallationId);
    await deleteSourceCredential(UID);
    expect(await readSourceCredential(UID)).toBeNull();
  });
});
