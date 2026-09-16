/**
 * Everything in a shared image that is not the picture (UC-3.6, #190).
 *
 * ── What is actually in a photo file ─────────────────────────────
 *
 * A JPEG off a phone carries an APP1 segment holding EXIF: the GPS coordinates
 * the picture was taken at, the camera's serial number, the owner's name on
 * some bodies, the original timestamp, and — on iOS and on most editors — a
 * second APP1 holding XMP, which can carry the author, the editing history and
 * a copy of any caption. A screenshot annotated in a photo editor carries the
 * editor's own APP13 block. A PNG carries the same things in `eXIf`, `tEXt`,
 * `iTXt` and `zTXt` chunks. None of it is the poster on the wall, and all of it
 * is a fact about the person rather than about the thing they shared.
 *
 * #190's criterion is that none of it is in the upload. That is a claim about
 * the bytes that leave the phone, so the removal has to happen there — see
 * `mobile/src/features/share/prepareImages.ts`, which is the same algorithm,
 * held to the same answers by `tests/share/exportImageStripCases.test.ts`.
 * This copy is the second line: the server strips again before a single byte
 * reaches a model, because a client is a thing anybody can write.
 *
 * ── Removal, not redaction ───────────────────────────────────────
 *
 * Every rule here is "keep the small closed list that carries pixels, drop
 * everything else", never "drop the metadata I have heard of". An allowlist
 * fails safe against the container extension nobody here has read about; a
 * blocklist fails open, silently, on exactly the file that carried something
 * new.
 *
 * ── HEIC is refused rather than half-read ────────────────────────
 *
 * An iPhone photo is HEIF, and HEIF keeps its EXIF as an *item* whose payload
 * lives in `mdat` and whose position is recorded in `iloc` — so removing it
 * means rewriting every offset in the file, and getting that wrong produces a
 * file that still decodes and still carries the coordinates. There is no
 * honest way to land that here without a real-device fixture to hold it to, so
 * a HEIF share is refused and says why. Refusing is a product gap; a rewrite
 * this repository cannot test is a privacy claim that is not true.
 */
import type { ShareMediaType } from './shareTypes';

/**
 * What came out, or why nothing did.
 *
 * `ok: false` is not "there was nothing to remove" — that is `ok: true` with
 * `removedSegments: 0`. It means this module could not account for every byte
 * of the container, and a caller must refuse the file rather than send bytes
 * nobody has parsed.
 */
export type ImageStripResult =
  | {
    readonly ok: true;
    /** A fresh array. The caller owns it and should zero it when done. */
    readonly bytes: Uint8Array;
    readonly removedSegments: number;
    readonly removedBytes: number;
  }
  | { readonly ok: false; readonly reason: 'unreadable_container' | 'container_not_strippable' };

const FAILED: ImageStripResult = { ok: false, reason: 'unreadable_container' };

/** The four ASCII characters at `offset`, or ''. */
function tag(bytes: Uint8Array, offset: number): string {
  if (bytes.length < offset + 4) return '';
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! * 0x1000000) + (bytes[offset + 1]! << 16) + (bytes[offset + 2]! << 8) + bytes[offset + 3]!
  );
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! + (bytes[offset + 1]! << 8) + (bytes[offset + 2]! << 16) + (bytes[offset + 3]! * 0x1000000)
  );
}

function concat(pieces: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const piece of pieces) total += piece.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.length;
  }
  return out;
}

/* ══ JPEG ════════════════════════════════════════════════════════ */

/**
 * Every `APPn` and every comment, gone.
 *
 * `APP1` is EXIF and XMP and is the one the criterion names, but the rule is
 * the whole class: `APP0`'s JFXX extension carries a thumbnail of the picture,
 * `APP2` carries an ICC profile that some phones stamp with a device name,
 * `APP13` is Photoshop's block and carries IPTC — which is where a caption and
 * a photographer's name live — and `APP14` is Adobe's. Dropping the class is
 * one rule that can be checked; keeping "the harmless ones" is a judgement
 * nobody can re-derive a year from now.
 *
 * Everything from `SOS` on is copied byte for byte: that is the compressed
 * picture, and this module has no business interpreting it.
 */
function stripJpeg(bytes: Uint8Array): ImageStripResult {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return FAILED;
  const kept: Uint8Array[] = [bytes.subarray(0, 2)];
  let removedSegments = 0;
  let removedBytes = 0;
  let at = 2;
  let sawScan = false;

  while (at < bytes.length) {
    if (bytes[at] !== 0xff) return FAILED;
    // A marker may be padded with any number of 0xFF fill bytes.
    let marker = at + 1;
    while (marker < bytes.length && bytes[marker] === 0xff) marker += 1;
    if (marker >= bytes.length) return FAILED;
    const code = bytes[marker]!;

    // `SOS` starts the entropy-coded picture and `EOI` ends the image; in both
    // cases the rest of the file is copied without being read.
    if (code === 0xda || code === 0xd9) {
      kept.push(bytes.subarray(at));
      sawScan = true;
      at = bytes.length;
      break;
    }
    // `TEM` and the restart markers carry no payload.
    if (code === 0x01 || (code >= 0xd0 && code <= 0xd7)) {
      kept.push(bytes.subarray(at, marker + 1));
      at = marker + 1;
      continue;
    }
    if (marker + 2 >= bytes.length) return FAILED;
    const length = (bytes[marker + 1]! << 8) | bytes[marker + 2]!;
    if (length < 2) return FAILED;
    const end = marker + 1 + length;
    if (end > bytes.length) return FAILED;

    if (isJpegMetadata(code)) {
      removedSegments += 1;
      removedBytes += end - at;
    } else {
      kept.push(bytes.subarray(at, end));
    }
    at = end;
  }

  // A file that ran out before the picture started is a file this did not
  // understand, and half of an image is not something to hand a model.
  if (!sawScan) return FAILED;
  return { ok: true, bytes: concat(kept), removedSegments, removedBytes };
}

/** `APP0`–`APP15` and `COM`. */
function isJpegMetadata(code: number): boolean {
  return (code >= 0xe0 && code <= 0xef) || code === 0xfe;
}

/* ══ PNG ═════════════════════════════════════════════════════════ */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * The chunks that are the picture.
 *
 * `IHDR`, `PLTE` and `IDAT` are the image; `IEND` ends it; `tRNS` is
 * transparency, which is part of what the pixels look like. Everything else —
 * `eXIf`, `tEXt`, `iTXt`, `zTXt`, `tIME`, `iCCP`, and whatever a future editor
 * invents — is dropped without being named, which is the point of writing the
 * keep list rather than the drop list.
 */
const PNG_PICTURE_CHUNKS: ReadonlySet<string> = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS']);

function stripPng(bytes: Uint8Array): ImageStripResult {
  if (bytes.length < 8) return FAILED;
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) return FAILED;
  }
  const kept: Uint8Array[] = [bytes.subarray(0, 8)];
  let removedSegments = 0;
  let removedBytes = 0;
  let at = 8;
  let sawEnd = false;

  while (at + 8 <= bytes.length) {
    const length = readUint32(bytes, at);
    const type = tag(bytes, at + 4);
    // 2^31 is the format's own ceiling on a chunk, and an over-long one is a
    // file this did not understand rather than one to read optimistically.
    if (length > 0x7fffffff) return FAILED;
    const end = at + 12 + length;
    if (end > bytes.length) return FAILED;
    if (PNG_PICTURE_CHUNKS.has(type)) kept.push(bytes.subarray(at, end));
    else {
      removedSegments += 1;
      removedBytes += end - at;
    }
    at = end;
    if (type === 'IEND') {
      sawEnd = true;
      break;
    }
  }
  if (!sawEnd) return FAILED;
  // Anything after `IEND` is not part of the image, and a payload appended
  // past the end of a picture is the oldest trick there is.
  if (at < bytes.length) {
    removedSegments += 1;
    removedBytes += bytes.length - at;
  }
  return { ok: true, bytes: concat(kept), removedSegments, removedBytes };
}

/* ══ WebP ════════════════════════════════════════════════════════ */

/** The RIFF chunks that carry pixels rather than facts about the photographer. */
const WEBP_PICTURE_CHUNKS: ReadonlySet<string> = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF']);

/**
 * `EXIF` and `XMP ` are chunks, and `VP8X` announces that they exist.
 *
 * Dropping the chunks and leaving the announcement would produce a file whose
 * header promises metadata that is not there — which some decoders read as
 * corruption. So the three flag bits for ICC, EXIF and XMP are cleared in the
 * `VP8X` header as well, and the container comes out consistent.
 */
const VP8X_METADATA_FLAGS = 0x20 | 0x08 | 0x04;

function stripWebp(bytes: Uint8Array): ImageStripResult {
  if (bytes.length < 12) return FAILED;
  if (tag(bytes, 0) !== 'RIFF' || tag(bytes, 8) !== 'WEBP') return FAILED;
  const declared = readUint32LE(bytes, 4);
  const end = Math.min(bytes.length, 8 + declared);
  if (end < 12) return FAILED;

  const kept: Uint8Array[] = [];
  let removedSegments = 0;
  let removedBytes = 0;
  let at = 12;

  while (at + 8 <= end) {
    const type = tag(bytes, at);
    const size = readUint32LE(bytes, at + 4);
    // RIFF pads every odd-sized chunk to an even boundary.
    const chunkEnd = at + 8 + size + (size % 2);
    if (chunkEnd > end) return FAILED;
    if (WEBP_PICTURE_CHUNKS.has(type)) {
      // `slice`, not `subarray`: the flags byte below is edited, and editing
      // the caller's buffer would corrupt the copy the caller still holds.
      const chunk = bytes.slice(at, chunkEnd);
      if (type === 'VP8X' && size >= 1) chunk[8] = chunk[8]! & ~VP8X_METADATA_FLAGS;
      kept.push(chunk);
    } else {
      removedSegments += 1;
      removedBytes += chunkEnd - at;
    }
    at = chunkEnd;
  }
  if (at < bytes.length) {
    removedSegments += 1;
    removedBytes += bytes.length - at;
  }

  const body = concat(kept);
  const out = new Uint8Array(12 + body.length);
  out.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  const size = 4 + body.length;
  out[4] = size & 0xff;
  out[5] = (size >> 8) & 0xff;
  out[6] = (size >> 16) & 0xff;
  out[7] = (size >>> 24) & 0xff;
  out.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  out.set(body, 12);
  return { ok: true, bytes: out, removedSegments, removedBytes };
}

/* ══ The door ════════════════════════════════════════════════════ */

/**
 * The same picture with nothing about the photographer in it.
 *
 * `mediaType` is the sniffed one from `mediaType.ts` and never a declaration,
 * so a PNG that arrived calling itself a JPEG is parsed as the PNG it is.
 */
export function stripImageMetadata(bytes: Uint8Array, mediaType: ShareMediaType | 'image/heif'): ImageStripResult {
  switch (mediaType) {
    case 'image/jpeg': return stripJpeg(bytes);
    case 'image/png': return stripPng(bytes);
    case 'image/webp': return stripWebp(bytes);
    case 'image/heic':
    case 'image/heif':
      return { ok: false, reason: 'container_not_strippable' };
    default:
      return FAILED;
  }
}

/**
 * The names of the metadata segments still in a file. Empty is the goal.
 *
 * A second walk over the *output*, used by `channels/image.ts` as the check on
 * its own work. `stripImageMetadata` deciding it removed everything and the
 * file actually carrying nothing are two different statements, and only the
 * second one is the acceptance criterion — so the second one is what is
 * asserted, on every image, on the production path and not only in a test.
 */
export function metadataSegmentsIn(bytes: Uint8Array, mediaType: ShareMediaType | 'image/heif'): readonly string[] {
  const found: string[] = [];
  if (mediaType === 'image/jpeg') {
    let at = 2;
    while (at + 1 < bytes.length && bytes[at] === 0xff) {
      let marker = at + 1;
      while (marker < bytes.length && bytes[marker] === 0xff) marker += 1;
      const code = bytes[marker];
      if (code === undefined || code === 0xda || code === 0xd9) break;
      if (code === 0x01 || (code >= 0xd0 && code <= 0xd7)) {
        at = marker + 1;
        continue;
      }
      if (marker + 2 >= bytes.length) break;
      const length = (bytes[marker + 1]! << 8) | bytes[marker + 2]!;
      if (length < 2) break;
      if (isJpegMetadata(code)) found.push(code === 0xfe ? 'COM' : `APP${code - 0xe0}`);
      at = marker + 1 + length;
    }
    return found;
  }
  if (mediaType === 'image/png') {
    let at = 8;
    while (at + 8 <= bytes.length) {
      const length = readUint32(bytes, at);
      const type = tag(bytes, at + 4);
      if (length > 0x7fffffff || at + 12 + length > bytes.length) break;
      if (!PNG_PICTURE_CHUNKS.has(type)) found.push(type);
      at += 12 + length;
      if (type === 'IEND') break;
    }
    if (at < bytes.length) found.push('trailing');
    return found;
  }
  if (mediaType === 'image/webp') {
    let at = 12;
    while (at + 8 <= bytes.length) {
      const type = tag(bytes, at);
      const size = readUint32LE(bytes, at + 4);
      const chunkEnd = at + 8 + size + (size % 2);
      if (chunkEnd > bytes.length) break;
      if (!WEBP_PICTURE_CHUNKS.has(type)) found.push(type.trim());
      else if (type === 'VP8X' && size >= 1 && (bytes[at + 8]! & VP8X_METADATA_FLAGS) !== 0) found.push('VP8X-flags');
      at = chunkEnd;
    }
    return found;
  }
  // Nothing here can account for a HEIF's items, and saying "none" about a
  // container this cannot read would be the worst answer available.
  return ['unparsed_container'];
}
