/**
 * The image-strip cases, as bytes (UC-3.6, #190).
 *
 * `imageStripCases.json` is written by `tests/share/exportImageStripCases.test.ts`
 * at the repository root and carries its pictures base64-encoded, because JSON
 * has no bytes. This is the one place that decodes them, so the two suites that
 * read the fixture — the stripper's own and the share flow's — cannot disagree
 * about what a case contains.
 *
 * `Buffer` and `atob` are both absent on some of the runtimes this app is built
 * for, so the decoder is written out. It is twelve lines and it never has to
 * change.
 */
import cases from './imageStripCases.json';

export interface StripCase {
  readonly name: string;
  readonly mediaType: string;
  /** Declared by a person in the exporting test, never computed there. */
  readonly expected: 'stripped' | 'unchanged' | 'refused';
  readonly because: string;
  readonly input: string;
  readonly output: string | null;
  readonly removedSegments: number;
  readonly removedBytes: number;
}

export const STRIP_CASES = cases as readonly StripCase[];

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let bits = 0;
  let value = 0;
  let at = 0;
  for (const character of clean) {
    const index = ALPHABET.indexOf(character);
    if (index < 0) throw new Error('not base64');
    value = (value << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at] = (value >> bits) & 0xff;
      at += 1;
    }
  }
  return out;
}

export function stripCaseNamed(name: string): StripCase {
  const found = STRIP_CASES.find((shared) => shared.name === name);
  if (!found) throw new Error(`no strip case named ${name}`);
  return found;
}

/** The bytes of one case, as the OS would have handed them over. */
export function stripCaseBytes(name: string): Uint8Array {
  return decodeBase64(stripCaseNamed(name).input);
}

/**
 * Whether anything metadata-shaped is still in these bytes, by raw scan.
 *
 * Deliberately not `metadataSegmentsIn` from `prepareImages.ts`: an oracle that
 * shares its parser with the thing it is checking agrees with it by
 * construction, and would go on agreeing after both were wrong.
 *
 * `FF E0`–`FF EF` is an `APPn` marker. Inside a JPEG's entropy-coded scan an
 * `FF` is always followed by `00` or a restart marker, so this cannot fire on
 * picture bytes.
 */
export function metadataMarkersIn(bytes: Uint8Array): string[] {
  const text = new TextDecoder('utf-8').decode(bytes);
  const found: string[] = [];
  for (const marker of ['Exif', 'eXIf', 'EXIF', 'XMP', 'xmp', 'tEXt', 'zTXt', 'iTXt', 'tIME']) {
    if (text.includes(marker)) found.push(marker);
  }
  for (let at = 0; at + 1 < bytes.length; at += 1) {
    if (bytes[at] === 0xff && bytes[at + 1]! >= 0xe0 && bytes[at + 1]! <= 0xef) found.push('APPn');
  }
  return found;
}
