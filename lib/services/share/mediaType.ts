/**
 * What a shared file actually is (UC-3.0, #183).
 *
 * ── Why the bytes and nothing else ───────────────────────────────
 *
 * The acceptance criterion names the case exactly: a PNG renamed `.pdf` must be
 * refused with 415. Both of the things that would otherwise answer this
 * question are the client's to choose — the file name and the multipart
 * `Content-Type` — and a share arrives from *another app*, which is the one
 * source of files this product has no reason to trust at all. So the name is
 * never read here and the declared type is compared against the sniffed one
 * rather than believed.
 *
 * ── Why not `file-type` ──────────────────────────────────────────
 *
 * #183 step 7a proposed `file-type@^22`. It is ESM-only, and this backend is
 * compiled by Next into a graph that also runs under a Node `--loader` in the
 * test suite; pulling a pure-ESM dependency into a route for six signatures is
 * a build risk out of proportion to the work it saves. The allowed list here is
 * six formats long and every one of them is a fixed prefix, so it is written
 * out, and `tests/share/shareIntakeRoute.test.ts` holds it to real first bytes.
 *
 * ── UTF-8 is a format ────────────────────────────────────────────
 *
 * Text is accepted only if it decodes as strict UTF-8. A `.txt` that is
 * actually a JPEG, or Windows-1256 Arabic, would otherwise reach the extractor
 * as replacement characters and be read as a sentence about nothing.
 */
import type { ShareMediaType } from './shareTypes';

/** `bytes` starts with `prefix`. */
function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[offset + index] !== prefix[index]) return false;
  }
  return true;
}

/** The four ASCII characters at `offset`, or ''. */
function tag(bytes: Uint8Array, offset: number): string {
  if (bytes.length < offset + 4) return '';
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const RIFF = [0x52, 0x49, 0x46, 0x46]; // RIFF
const WEBP = [0x57, 0x45, 0x42, 0x50]; // WEBP
/** PK\x03\x04, PK\x05\x06 (empty) and PK\x07\x08 (spanned) are all zips. */
const ZIP_PREFIXES = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x50, 0x4b, 0x07, 0x08],
];
/** The HEIF brands iOS actually writes for a photo. */
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);

/**
 * The type a file's bytes say it is, or null when it is none of the six.
 *
 * Null is a refusal, never a default. A format this cannot name is a format the
 * product has not decided how to read, and guessing `text/plain` for it would
 * hand the extractor binary.
 */
export function sniffMediaType(bytes: Uint8Array): ShareMediaType | null {
  if (bytes.length === 0) return null;
  if (startsWith(bytes, JPEG)) return 'image/jpeg';
  if (startsWith(bytes, PNG)) return 'image/png';
  if (startsWith(bytes, PDF)) return 'application/pdf';
  // RIFF....WEBP — the four size bytes between the two tags are not checked,
  // because a truncated WebP is still a WebP and the model, not this, decides
  // whether it can read it.
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return 'image/webp';
  // ISO-BMFF: a 4-byte size, then `ftyp`, then the brand. `heic` covers HEIF as
  // a whole here; Vertex takes `image/heic` for both.
  if (tag(bytes, 4) === 'ftyp' && HEIC_BRANDS.has(tag(bytes, 8))) return 'image/heic';
  if (ZIP_PREFIXES.some((prefix) => startsWith(bytes, prefix))) return 'application/zip';
  const text = decodeUtf8(bytes);
  if (text === null) return null;
  // Valid UTF-8 is not the same thing as text. A run of C0 control bytes
  // decodes cleanly and is not a sentence; a NUL in particular is the classic
  // marker of a binary file this list does not otherwise recognise, and letting
  // one through would hand the extractor a header to read as prose.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return null;
  // An `.ics` announces itself on its first line. Checked before plain text so
  // a calendar file is not flattened into one, which would lose the one thing a
  // future channel would route on.
  if (/^﻿?BEGIN:VCALENDAR/i.test(text.slice(0, 64))) return 'text/calendar';
  return 'text/plain';
}

/**
 * The string these bytes are, or null if they are not strict UTF-8.
 *
 * `fatal: true` is the whole point. Without it `TextDecoder` substitutes U+FFFD
 * for every byte it cannot read, so a JPEG decodes "successfully" into a page of
 * replacement characters and is then read as prose.
 */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Whether a client's declared type is consistent with the sniffed one.
 *
 * Not equality: browsers and share sheets send `image/jpg`, `image/*`,
 * `text/plain; charset=utf-8`, `application/x-zip-compressed` and
 * `application/octet-stream` for things that are exactly what they claim, and
 * refusing those would refuse real shares — `image/*` alone would refuse every
 * Android multi-photo share there is. What this catches is the one case the
 * criterion names: a declaration asserting a *different, specific* format from
 * the one the bytes turned out to be. A wildcard asserts a family, and is
 * checked against the family; anything that asserts nothing is let through and
 * the bytes decide.
 */
export function declarationConflicts(declared: string | null, sniffed: ShareMediaType): boolean {
  const raw = (declared ?? '').split(';')[0]!.trim().toLowerCase();
  if (raw === '' || raw === 'application/octet-stream') return false;
  if (raw === sniffed) return false;
  // A wildcard is not a claim about a format, it is a claim about a family, and
  // it is what Android sends constantly: `ACTION_SEND_MULTIPLE` from the photo
  // picker declares every part `image/*`, and a chooser filtered on `text/*`
  // passes that straight through. Refusing `image/*` over sniffed `image/png`
  // would 415 the most ordinary share this product has. `*/*` says even less.
  if (raw === '*/*' || raw.endsWith('/*')) {
    const family = raw.slice(0, -2);
    return family !== '*' && !sniffed.startsWith(`${family}/`);
  }
  if (raw === 'image/jpg' && sniffed === 'image/jpeg') return false;
  if (raw === 'image/heif' && sniffed === 'image/heic') return false;
  // Windows and several Android file managers call a zip this. #189's Android
  // WhatsApp export arrives declared exactly so.
  if (sniffed === 'application/zip'
    && (raw === 'application/x-zip-compressed' || raw === 'application/zip-compressed' || raw === 'multipart/x-zip')) {
    return false;
  }
  // An `.eml` is a UTF-8 text file with headers on the front, and that is both
  // what it sniffs as and what #192 will read. The declaration is right about
  // the file and this is right about the bytes; they are not in conflict.
  if (sniffed === 'text/plain' && (raw === 'message/rfc822' || raw === 'application/mbox')) return false;
  // A share sheet that says only "text/something" about a UTF-8 file is not
  // making a claim this needs to argue with.
  if (sniffed === 'text/plain' && raw.startsWith('text/')) return false;
  if (sniffed === 'text/calendar' && raw.startsWith('text/')) return false;
  return true;
}
