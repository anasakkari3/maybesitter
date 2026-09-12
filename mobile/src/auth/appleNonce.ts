/**
 * The nonce that stops an Apple identity token being replayed (UC-1.1 #145).
 *
 * Apple is given the **SHA-256** of a random string; the token it returns
 * carries that hash in its `nonce` claim. Firebase is given the **raw** string
 * and checks the hash itself. So a token captured from one sign-in cannot be
 * presented for another: whoever replays it does not have the raw nonce that
 * hashes to the claim inside it.
 *
 * Getting the two the wrong way round is the classic mistake here, and it
 * fails open — sign-in works, and the replay protection simply is not there.
 * `appleNonce.test.ts` pins which value goes where.
 */
import * as Crypto from 'expo-crypto';

/**
 * The URL-safe base64 alphabet: 64 characters, none of which needs escaping in
 * a URL or in a JWT claim, which is where Apple's nonce travels.
 *
 * Exactly 64 matters. `byte % length` over a 0–255 byte is uniform only when
 * the length divides 256; the first version of this had 65 characters, which
 * made three of them measurably more likely. A test asserts the division now,
 * because the bias is invisible in any amount of manual use.
 */
const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export const DEFAULT_NONCE_LENGTH = 32;

/** A random string of the given length, uniformly drawn from the charset. */
export function generateNonce(length: number = DEFAULT_NONCE_LENGTH): string {
  if (length <= 0) throw new Error('nonce length must be positive');
  const bytes = Crypto.getRandomBytes(length);
  let out = '';
  for (const byte of bytes) out += CHARSET[byte % CHARSET.length];
  return out;
}

/** Lower-case hex, which is what Apple expects in the `nonce` parameter. */
export function sha256Hex(input: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, input, {
    encoding: Crypto.CryptoEncoding.HEX,
  });
}

export { CHARSET as NONCE_CHARSET };
