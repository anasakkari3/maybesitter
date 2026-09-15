import { beforeEach, describe, expect, it } from '@jest/globals';
import * as SecureStore from 'expo-secure-store';
import {
  forgetInstallationId,
  INSTALLATION_ID_KEY,
  installationId,
  resetInstallationIdForTests,
} from '../installationId';

/**
 * One id per installation, minted once (UC-3.0b, #184; reused by UC-3.1 #185).
 *
 * The property that matters is stability: the device registry is keyed by this
 * value, so an id that changed would leave a dead row — and its token — behind
 * on every launch.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

beforeEach(() => {
  (SecureStore as unknown as { __reset(): void }).__reset();
  resetInstallationIdForTests();
});

describe('minting', () => {
  it('produces a uuid and stores it under the documented key', async () => {
    const id = await installationId();
    expect(id).toMatch(UUID);
    expect(await SecureStore.getItemAsync(INSTALLATION_ID_KEY)).toBe(id);
  });

  it('returns the same id on the next call, and after a relaunch', async () => {
    const first = await installationId();
    expect(await installationId()).toBe(first);

    // The relaunch: the in-process cache is gone, the keychain is not.
    resetInstallationIdForTests();
    expect(await installationId()).toBe(first);
  });

  it('gives two concurrent callers the same id', async () => {
    // Push registration and UC-3.1 both ask on a cold start. Two mints would
    // mean the second overwrote the id the first had already registered under.
    const [a, b] = await Promise.all([installationId(), installationId()]);
    expect(a).toBe(b);
  });

  it('replaces a stored value that is not a uuid', async () => {
    await SecureStore.setItemAsync(INSTALLATION_ID_KEY, 'whatever-was-there-before');
    expect(await installationId()).toMatch(UUID);
  });
});

describe('when the keychain refuses', () => {
  it('answers null rather than minting a throwaway', async () => {
    const original = SecureStore.getItemAsync;
    (SecureStore as unknown as { getItemAsync: unknown }).getItemAsync = async () => {
      throw new Error('no keychain');
    };
    try {
      // A fresh uuid per launch would be one device row per launch, and one
      // copy of every push per row.
      expect(await installationId()).toBeNull();
    } finally {
      (SecureStore as unknown as { getItemAsync: unknown }).getItemAsync = original;
    }
  });
});

describe('forgetting', () => {
  it('removes the keychain entry and the cache', async () => {
    const first = await installationId();
    await forgetInstallationId();
    expect(await SecureStore.getItemAsync(INSTALLATION_ID_KEY)).toBeNull();
    expect(await installationId()).not.toBe(first);
  });
});
