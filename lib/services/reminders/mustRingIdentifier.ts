/**
 * The identifier a Must ring is held and shown under (UC-3.12b, #198).
 *
 * It is the local request's identifier on the phone *and* the backup push's
 * `apns-collapse-id` and Android `tag`, which is what lets one replace the
 * other. So it has to fit where the push puts it: at most 64 characters from
 * `[A-Za-z0-9:._-]`, starting with a letter or digit. A commitment id for which
 * `${id}:strong` fits keeps that readable form (every uuid does); any other id
 * is hashed to `h<16 hex>:strong`, so a long or non-ASCII id still rings, still
 * gets its backup, and the two still collapse.
 *
 * This file exists twice, on purpose, because the app and the server do not
 * share a package: `mobile/src/features/reminders/mustRingIdentifier.ts` and
 * `lib/services/reminders/mustRingIdentifier.ts`. Both are held to the one table
 * in `mobile/src/features/reminders/__fixtures__/mustRingIdentifier.json`, so a
 * change to either that the other does not make goes red.
 */
const FITS = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;
const MAX = 64;
const SUFFIX = ':strong';

/** FNV-1a over UTF-16 code units, seeded; the same in Node and in Hermes. */
function fnv1a(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function mustRingIdentifier(commitmentId: string): string {
  const plain = `${commitmentId}${SUFFIX}`;
  if (plain.length <= MAX && FITS.test(plain)) return plain;
  return `h${fnv1a(commitmentId, 0x811c9dc5)}${fnv1a(commitmentId, 0x01000193)}${SUFFIX}`;
}
