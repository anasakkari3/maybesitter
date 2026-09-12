import { describe, expect, it } from '@jest/globals';
import { DEFAULT_NONCE_LENGTH, NONCE_CHARSET, generateNonce, sha256Hex } from '../appleNonce';

/**
 * The replay protection, pinned.
 *
 * Apple receives the SHA-256 of the nonce; Firebase receives the raw nonce and
 * checks the hash itself. Getting those two the wrong way round **fails open**
 * — sign-in still works and the protection is simply absent — so it cannot be
 * caught by trying it on a device. Only an assertion catches it.
 */
describe('the Apple nonce', () => {
  it('is the requested length, from the URL- and JWT-safe charset', () => {
    const nonce = generateNonce();
    expect(nonce).toHaveLength(DEFAULT_NONCE_LENGTH);
    for (const character of nonce) expect(NONCE_CHARSET).toContain(character);
  });

  it('honours an explicit length and refuses a useless one', () => {
    expect(generateNonce(16)).toHaveLength(16);
    expect(() => generateNonce(0)).toThrow();
    expect(() => generateNonce(-1)).toThrow();
  });

  it('differs every time', () => {
    const nonces = new Set(Array.from({ length: 50 }, () => generateNonce()));
    expect(nonces.size).toBe(50);
  });

  it('uses a charset whose length divides 256, so the modulo is unbiased', () => {
    // 64 divides 256 exactly. A charset of, say, 62 characters would make the
    // first two characters measurably more likely — subtle, and pointless to
    // accept when a power of two is available.
    expect(256 % NONCE_CHARSET.length).toBe(0);
    expect(new Set(NONCE_CHARSET).size).toBe(NONCE_CHARSET.length);
  });

  it('hashes to lower-case hex, which is what Apple expects', async () => {
    // The SHA-256 of "abc", from the FIPS 180-4 test vectors.
    await expect(sha256Hex('abc')).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes the empty string to the known digest', async () => {
    await expect(sha256Hex('')).resolves.toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('gives a different hash for a different nonce', async () => {
    const [a, b] = await Promise.all([sha256Hex(generateNonce()), sha256Hex(generateNonce())]);
    expect(a).not.toBe(b);
    expect(a).toHaveLength(64);
  });
});
