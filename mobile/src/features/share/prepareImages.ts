/**
 * Taking the photographer out of the photograph, before it leaves the phone
 * (UC-3.6, #190).
 *
 * ── The criterion is about the upload, so this has to be here ────
 *
 * #190 asks that there be no APP1/EXIF **in the upload**. That is a claim about
 * the bytes on the wire, and the only place it can be made true is the device.
 * The server strips again — `lib/services/share/imageMetadata.ts` — but a
 * server-side strip happens after the coordinates have already crossed the
 * network, which is precisely the thing the criterion forbids.
 *
 * What is in a photo off a phone: the GPS coordinates it was taken at, the
 * camera's serial number, the original timestamp, the owner's name on some
 * bodies, and — after any edit — an XMP block with the editing history and any
 * caption. A screenshot annotated in an editor carries that editor's own block.
 * None of it is the poster on the wall.
 *
 * ── Two implementations, one set of answers ──────────────────────
 *
 * This file and `lib/services/share/imageMetadata.ts` are the same algorithm on
 * two sides of a workspace boundary that cannot import across itself — the same
 * situation `emailTextDetector.ts` is in. So they are held to one written-down
 * set of answers: `tests/share/exportImageStripCases.test.ts` asserts the
 * backend stripper against declared properties and then writes the inputs and
 * outputs to `__fixtures__/imageStripCases.json`, and
 * `__tests__/prepareImages.test.ts` runs *this* over them byte for byte. A
 * change on one side and not the other is a red run rather than a silent
 * divergence.
 *
 * ── Removal, not redaction ───────────────────────────────────────
 *
 * Every rule is "keep the small closed list that carries pixels, drop
 * everything else", never "drop the metadata I have heard of". An allowlist
 * fails safe against the container extension nobody here has read about; a
 * blocklist fails open, silently, on exactly the file that carried something
 * new.
 *
 * ── HEIF is converted, never byte-stripped (#404) ────────────────
 *
 * An iPhone photo is usually HEIF, and HEIF keeps its EXIF as an *item* whose
 * payload lives in `mdat` and whose position is recorded in `iloc` — so
 * removing it in place means rewriting every offset in the file, and getting
 * that wrong produces a file that still decodes and still carries the
 * coordinates. #190 refused HEIF for that reason. #404 does not strip it at
 * all: `prepareImages` has the platform decode every picture and re-encode it
 * as a JPEG at most 2048 px on its long edge, and it is *that* JPEG the
 * stripper below runs over. `stripImageMetadata` still refuses a HEIF handed
 * to it directly, as the server's copy does.
 *
 * ── The bytes do enter JavaScript here, and only here ────────────
 *
 * `ShareProvider.tsx` says the bytes never reach the JS heap, because
 * `apiUpload` hands React Native a `{ uri, name, type }` descriptor and the
 * platform streams the file. That stays true of the *upload*. It cannot stay
 * true of a rewrite: there is no way to remove a segment from a file without
 * reading it. So one image at a time is decoded, encoded, read, rewritten and
 * dropped; the encoder's JPEG and the stripped copy go into the cache directory
 * beside the copy the OS already made, and `ShareProvider` deletes all three on
 * every exit from the flow.
 */
import type { SharedFile } from './intake';

/* ══ The pure half ═══════════════════════════════════════════════ */

export type ImageStripResult =
  | {
    readonly ok: true;
    readonly bytes: Uint8Array;
    readonly removedSegments: number;
    readonly removedBytes: number;
  }
  | { readonly ok: false; readonly reason: 'unreadable_container' | 'container_not_strippable' };

const FAILED: ImageStripResult = { ok: false, reason: 'unreadable_container' };

function tag(bytes: Uint8Array, offset: number): string {
  if (bytes.length < offset + 4) return '';
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000 + (bytes[offset + 1]! << 16) + (bytes[offset + 2]! << 8) + bytes[offset + 3]!
  );
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! + (bytes[offset + 1]! << 8) + (bytes[offset + 2]! << 16) + bytes[offset + 3]! * 0x1000000
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

/** `APP0`–`APP15` and `COM`. */
function isJpegMetadata(code: number): boolean {
  return (code >= 0xe0 && code <= 0xef) || code === 0xfe;
}

/**
 * Every `APPn` and every comment, gone.
 *
 * `APP1` is EXIF and XMP and is the one the criterion names, but the rule is
 * the whole class: `APP0`'s JFXX extension carries a thumbnail of the picture,
 * `APP2` an ICC profile some phones stamp with a device name, `APP13`
 * Photoshop's block — which is where a caption and a photographer's name live.
 * Everything from `SOS` on is copied byte for byte: that is the picture.
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

    // `EOI` ends the picture, and whatever follows it is not this picture
    // (#404). A gain map or a Multi-Picture secondary image is a whole second
    // JPEG with its own Exif, appended here by iOS HDR and Android Ultra HDR;
    // copying it unread would upload that file's GPS untouched.
    if (code === 0xd9) {
      if (!sawScan) return FAILED;
      kept.push(bytes.subarray(at, marker + 1));
      if (marker + 1 < bytes.length) {
        removedSegments += 1;
        removedBytes += bytes.length - (marker + 1);
      }
      return { ok: true, bytes: concat(kept), removedSegments, removedBytes };
    }
    // Every other marker is either one this knows carries a length, or the file
    // is refused. A second `SOI`, `TEM` or a restart marker outside a scan has
    // no length: reading its next two bytes as one would copy whatever they
    // "cover" — an Exif block, a whole thumbnail — without looking at it. And a
    // flood of them is how a few megabytes become gigabytes of kept pieces.
    const metadata = isJpegMetadata(code);
    if (!metadata && code !== 0xda && !isJpegPictureSegment(code)) return FAILED;
    if (marker + 2 >= bytes.length) return FAILED;
    const length = (bytes[marker + 1]! << 8) | bytes[marker + 2]!;
    if (length < 2) return FAILED;
    const end = marker + 1 + length;
    if (end > bytes.length) return FAILED;

    if (metadata) {
      removedSegments += 1;
      removedBytes += end - at;
      at = end;
      continue;
    }
    kept.push(bytes.subarray(at, end));
    at = end;

    // `SOS`: the entropy-coded picture follows its header. It is copied byte for
    // byte up to the next real marker — which, in a progressive JPEG, may be
    // another table, another scan, or an `APPn` or comment *between* scans, so
    // the walk goes on rather than copying the rest of the file unread.
    if (code === 0xda) {
      sawScan = true;
      const data = endOfEntropyData(bytes, at);
      kept.push(bytes.subarray(at, data));
      at = data;
    }
  }

  // Ran out before `EOI`: a file this cannot account for to its last byte.
  return FAILED;
}

/**
 * The length-bearing segments that are the picture, and nothing else: `SOFn`
 * (`C0`–`CF` except `C4` DHT, `C8` reserved and `CC` DAC, which are listed
 * themselves), `DQT`, `DNL`, `DRI`, `DHP` and `EXP`. `SOS` is handled on its own.
 */
function isJpegPictureSegment(code: number): boolean {
  return (code >= 0xc0 && code <= 0xcf && code !== 0xc8) || (code >= 0xdb && code <= 0xdf);
}

/**
 * Where entropy-coded data starting at `from` ends: the offset of the next
 * marker, or the end of the file.
 *
 * Inside a scan an `FF` is followed by `00` (a stuffed byte) or `D0`–`D7` (a
 * restart marker) and neither ends it. Anything else — including a run of `FF`
 * fill bytes in front of a marker — does.
 */
function endOfEntropyData(bytes: Uint8Array, from: number): number {
  let at = from;
  while (at + 1 < bytes.length) {
    if (bytes[at] !== 0xff) {
      at += 1;
      continue;
    }
    const next = bytes[at + 1]!;
    if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
      at += 2;
      continue;
    }
    return at;
  }
  return bytes.length;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * The chunks that are the picture: `IHDR`, `PLTE`, `IDAT`, `IEND` and `tRNS`.
 *
 * Everything else — `eXIf`, `tEXt`, `iTXt`, `zTXt`, `tIME`, `iCCP`, and
 * whatever a future editor invents — goes without being named, which is the
 * point of writing the keep list rather than the drop list.
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
  // A payload appended past the end of a picture is the oldest trick there is.
  if (at < bytes.length) {
    removedSegments += 1;
    removedBytes += bytes.length - at;
  }
  return { ok: true, bytes: concat(kept), removedSegments, removedBytes };
}

/** The RIFF chunks that carry pixels rather than facts about the photographer. */
const WEBP_PICTURE_CHUNKS: ReadonlySet<string> = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF']);

/** ICC, EXIF and XMP, as announced in the `VP8X` header. */
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
    const chunkEnd = at + 8 + size + (size % 2);
    if (chunkEnd > end) return FAILED;
    if (WEBP_PICTURE_CHUNKS.has(type)) {
      // `slice`, not `subarray`: the flags byte is edited, and editing the
      // caller's buffer would corrupt the copy the caller still holds.
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
  out.set([0x52, 0x49, 0x46, 0x46], 0);
  const size = 4 + body.length;
  out[4] = size & 0xff;
  out[5] = (size >> 8) & 0xff;
  out[6] = (size >> 16) & 0xff;
  out[7] = (size >>> 24) & 0xff;
  out.set([0x57, 0x45, 0x42, 0x50], 8);
  out.set(body, 12);
  return { ok: true, bytes: out, removedSegments, removedBytes };
}

/** The same picture with nothing about the photographer in it. */
export function stripImageMetadata(bytes: Uint8Array, mimeType: string): ImageStripResult {
  switch (mimeType) {
    case 'image/jpeg':
      return stripJpeg(bytes);
    case 'image/png':
      return stripPng(bytes);
    case 'image/webp':
      return stripWebp(bytes);
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
 * A second walk over the *output*, used below as the check on this module's own
 * work. "It removed everything" and "nothing is left" are two statements, and
 * only the second one is the criterion — so the second one is what is checked,
 * on every image, on the path a real share takes and not only in a test.
 */
export function metadataSegmentsIn(bytes: Uint8Array, mimeType: string): readonly string[] {
  const found: string[] = [];
  if (mimeType === 'image/jpeg') {
    // Fail closed: anything this walk cannot follow from `SOI` to `EOI` is
    // reported as `unparsed`, never as clean. A check that stops at the first
    // thing it does not understand and says "nothing found" is not a check.
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return ['unparsed'];
    let at = 2;
    let sawScan = false;
    for (;;) {
      if (at >= bytes.length || bytes[at] !== 0xff) {
        found.push('unparsed');
        break;
      }
      let marker = at + 1;
      while (marker < bytes.length && bytes[marker] === 0xff) marker += 1;
      const code = bytes[marker];
      if (code === undefined) {
        found.push('unparsed');
        break;
      }
      if (code === 0xd9) {
        if (!sawScan) found.push('unparsed');
        // Anything after `EOI` is a second picture or a payload, never this one.
        else if (marker + 1 < bytes.length) found.push('trailing');
        break;
      }
      const metadata = isJpegMetadata(code);
      const length = marker + 2 < bytes.length ? (bytes[marker + 1]! << 8) | bytes[marker + 2]! : 0;
      if ((!metadata && code !== 0xda && !isJpegPictureSegment(code)) || length < 2
        || marker + 1 + length > bytes.length) {
        found.push('unparsed');
        break;
      }
      if (metadata) found.push(code === 0xfe ? 'COM' : `APP${code - 0xe0}`);
      at = marker + 1 + length;
      if (code === 0xda) {
        sawScan = true;
        at = endOfEntropyData(bytes, at);
      }
    }
    return found;
  }
  if (mimeType === 'image/png') {
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
  if (mimeType === 'image/webp') {
    let at = 12;
    while (at + 8 <= bytes.length) {
      const type = tag(bytes, at);
      const size = readUint32LE(bytes, at + 4);
      const chunkEnd = at + 8 + size + (size % 2);
      if (chunkEnd > bytes.length) break;
      if (!WEBP_PICTURE_CHUNKS.has(type)) found.push(type.trim());
      else if (type === 'VP8X' && size >= 1 && (bytes[at + 8]! & VP8X_METADATA_FLAGS) !== 0) {
        found.push('VP8X-flags');
      }
      at = chunkEnd;
    }
    return found;
  }
  // Saying "none" about a container this cannot read would be the worst answer
  // available.
  return ['unparsed_container'];
}

/* ══ The half that touches the disk ══════════════════════════════ */

/**
 * Reading and writing, as a port.
 *
 * `eslint.config.js` forbids importing `expo-file-system*` from
 * `src/features/**`, and rightly: the rule is "no local database or file cache
 * of user content". This module does the filesystem's work through an injected
 * port instead, so the algorithm above stays a pure function a test can run
 * over real bytes with no native module present, and the one implementation
 * that does touch the disk lives in `src/lib/shareImages.ts` — outside the
 * glob, with its own argument in its own header, exactly as
 * `src/lib/shareFiles.ts` does.
 */
export interface ImageBytesPort {
  /** Every byte of a file the OS copied out for us. */
  read(uri: string): Uint8Array;
  /** Writes a stripped copy somewhere temporary and returns its uri. */
  write(bytes: Uint8Array, extension: string): string;
}

/**
 * Decoding and re-encoding a picture, as a port (#404).
 *
 * The one implementation is `expo-image-manipulator`, in `src/lib/shareImages.ts`
 * beside the byte port and for the same reason: this file stays a function a
 * test can drive with no native module present. `decode` rejects on anything
 * the platform cannot open — a HEIF on an Android below API 28 among them —
 * and that rejection is a refusal with words for the user, never a crash.
 */
export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

export interface DecodedImage {
  /** Pixels, after the platform applied the photo's orientation. */
  readonly width: number;
  readonly height: number;
  /**
   * Writes this picture at `size` (null: as decoded) and returns the file's uri.
   * `quality` is ignored for PNG.
   */
  encode(size: ImageSize | null, format: 'jpeg' | 'png', quality: number): Promise<string>;
  /** Lets the native bitmap go. Called exactly once per decode. */
  release(): void;
}

export interface ImageCodecPort {
  decode(uri: string): Promise<DecodedImage>;
}

export interface ImagePorts {
  readonly bytes: ImageBytesPort;
  readonly codec: ImageCodecPort;
  /**
   * The stripper. Always `stripImageMetadata` in the app; a test hands in one
   * that lies, to prove the post-check behind it is what stops the upload.
   */
  readonly strip?: (bytes: Uint8Array, mimeType: string) => ImageStripResult;
}

/**
 * How big a picture leaves the phone (#404).
 *
 * `longEdge` is #190 step 1's 2048 px: enough for a model to read a flyer's
 * small print, and a 12 MP camera photo comes down from ~3–12 MB to a few
 * hundred KB. `maxBytes` is its 6 MB retry threshold. `minimumLongEdge` is the
 * floor below which no retry goes, because the text on the picture is the
 * whole point of sharing it; past that the share is refused as too large
 * rather than sent illegible.
 */
export const UPLOAD_IMAGE = {
  longEdge: 2048,
  minimumLongEdge: 1600,
  maxBytes: 6 * 1024 * 1024,
} as const;

/**
 * The encodes tried, in order, until one fits `maxBytes`. Bounded.
 *
 * Quality goes before pixels: JPEG quality loss blurs texture first and edges
 * last, while fewer pixels shrink every letter. So every attempt at the full
 * edge comes first, and the smaller edge is only tried at the documented floor.
 * In practice the first attempt fits: a 2048 px JPEG at q0.8 is well under a
 * megabyte for a photograph, and this ladder is for the pathological picture
 * (dense noise, a 2048 px image of confetti).
 */
export const ENCODE_ATTEMPTS: readonly { readonly longEdge: number; readonly quality: number }[] = [
  { longEdge: 2048, quality: 0.8 },
  { longEdge: 2048, quality: 0.7 },
  { longEdge: 2048, quality: 0.6 },
  { longEdge: 1600, quality: 0.6 },
  { longEdge: 1600, quality: 0.5 },
];

/**
 * The encodes tried for a picture with transparency: PNG, never JPEG (#404 review).
 *
 * JPEG has no alpha. iOS's encoder puts a transparent area on white, but
 * Android's `Bitmap.compress(JPEG)` puts it on black — so dark text on a
 * transparent flyer would upload as black on black. A picture that may be
 * transparent stays PNG, is stripped as a PNG, and past the 1600 px floor is
 * refused as too large rather than sent as a JPEG nobody can read.
 */
export const PNG_ATTEMPTS: readonly { readonly longEdge: number }[] = [
  { longEdge: 2048 },
  { longEdge: 1600 },
];

/**
 * The most pixels a shared picture may have before it is decoded (#404 review).
 *
 * The manipulator decodes at full resolution before resizing: 4 bytes a pixel,
 * so 50 MP is ~200 MB, and a 200 MP phone photo or a PNG "bomb" of a few
 * kilobytes would be the gigabyte that kills the app. A 48 MP iPhone photo
 * (8064 × 6048) is under it. Checked from the file's header, before decoding.
 */
export const MAX_DECODE_PIXELS = 50_000_000;

/** What a shared picture's header says, read without decoding it. */
export interface ImageHeader {
  readonly width: number;
  readonly height: number;
  /** Whether the container can carry transparency for this picture. */
  readonly hasAlpha: boolean;
}

function be16At(bytes: Uint8Array, at: number): number {
  return (bytes[at]! << 8) | bytes[at + 1]!;
}

function le24At(bytes: Uint8Array, at: number): number {
  return bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
}

function sized(width: number, height: number, hasAlpha: boolean): ImageHeader | null {
  return width > 0 && height > 0 ? { width, height, hasAlpha } : null;
}

function jpegHeader(bytes: Uint8Array): ImageHeader | null {
  let at = 2;
  while (at + 3 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    let marker = at + 1;
    while (marker < bytes.length && bytes[marker] === 0xff) marker += 1;
    const code = bytes[marker];
    if (code === undefined || marker + 2 >= bytes.length) return null;
    const length = be16At(bytes, marker + 1);
    if (length < 2) return null;
    // `SOFn`: precision, then height, then width.
    if (code >= 0xc0 && code <= 0xcf && code !== 0xc4 && code !== 0xc8 && code !== 0xcc) {
      if (marker + 8 >= bytes.length) return null;
      return sized(be16At(bytes, marker + 6), be16At(bytes, marker + 4), false);
    }
    if (!isJpegMetadata(code) && !isJpegPictureSegment(code)) return null;
    at = marker + 1 + length;
  }
  return null;
}

function pngHeader(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length < 33 || tag(bytes, 12) !== 'IHDR') return null;
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) return null;
  }
  const width = readUint32(bytes, 16);
  const height = readUint32(bytes, 20);
  const colorType = bytes[25]!;
  // Colour types 4 and 6 carry an alpha channel; any other type is transparent
  // only if a `tRNS` chunk comes before the pixels.
  let hasAlpha = colorType === 4 || colorType === 6;
  let at = 8;
  while (!hasAlpha && at + 8 <= bytes.length) {
    const type = tag(bytes, at + 4);
    if (type === 'IDAT' || type === 'IEND') break;
    if (type === 'tRNS') hasAlpha = true;
    at += 12 + readUint32(bytes, at);
  }
  return sized(width, height, hasAlpha);
}

function webpHeader(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length < 25 || tag(bytes, 0) !== 'RIFF' || tag(bytes, 8) !== 'WEBP') return null;
  const first = tag(bytes, 12);
  if (first === 'VP8X' && bytes.length >= 30) {
    return sized(1 + le24At(bytes, 24), 1 + le24At(bytes, 27), (bytes[20]! & 0x10) !== 0);
  }
  if (first === 'VP8L' && bytes[20] === 0x2f) {
    const bits = readUint32LE(bytes, 21);
    return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1, ((bits >>> 28) & 1) === 1);
  }
  if (first === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return sized((bytes[26]! | (bytes[27]! << 8)) & 0x3fff, (bytes[28]! | (bytes[29]! << 8)) & 0x3fff, false);
  }
  return null;
}

/**
 * HEIF: the largest `ispe` (image spatial extent) property inside the top-level
 * `meta` box. The primary image of a grid carries the full size; tiles and the
 * thumbnail carry smaller ones. Only `meta` is searched — compressed pixels in
 * `mdat` can spell anything.
 */
function heifHeader(bytes: Uint8Array): ImageHeader | null {
  let at = 0;
  while (at + 8 <= bytes.length) {
    let size = readUint32(bytes, at);
    const type = tag(bytes, at + 4);
    if (size === 1) return null; // A 64-bit box before `meta` is not a layout a phone writes.
    if (size === 0) size = bytes.length - at;
    if (size < 8 || at + size > bytes.length) return null;
    if (type === 'meta') {
      let width = 0;
      let height = 0;
      for (let index = at + 12; index + 16 <= at + size; index += 1) {
        if (bytes[index] !== 0x69 || tag(bytes, index) !== 'ispe') continue;
        const w = readUint32(bytes, index + 8);
        const h = readUint32(bytes, index + 12);
        if (w * h > width * height) {
          width = w;
          height = h;
        }
      }
      return sized(width, height, false);
    }
    at += size;
  }
  return null;
}

/** A shared picture's size and transparency, from its bytes rather than its declared type. */
export function imageHeader(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpegHeader(bytes);
  if (bytes.length >= 8 && bytes[0] === 0x89 && tag(bytes, 1) === 'PNG\r') return pngHeader(bytes);
  if (tag(bytes, 0) === 'RIFF') return webpHeader(bytes);
  if (tag(bytes, 4) === 'ftyp') return heifHeader(bytes);
  return null;
}

/** The size to encode at so the long edge is at most `longEdge`, or null to keep it. Never larger. */
export function targetSize(width: number, height: number, longEdge: number): ImageSize | null {
  const longest = Math.max(width, height);
  if (longest <= longEdge) return null;
  const scale = longEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export interface PreparedImages {
  /** The files to upload: JPEG descriptors pointing at the stripped copies. */
  readonly files: readonly SharedFile[];
  /** Every file this made — encoder outputs and stripped copies — for the caller's `finally` to delete. */
  readonly created: readonly string[];
  /** How many metadata segments went, across every picture. A count, never a name. */
  readonly removedSegments: number;
  readonly removedBytes: number;
}

/**
 * Why a share of pictures is not sent.
 *
 * `unreadable_image` is the platform failing to decode it, or this module
 * failing to account for what the encoder wrote — both fail closed, and both
 * tell the user what to do instead. `file_too_large` is every attempt in
 * `ENCODE_ATTEMPTS` coming out over `maxBytes`.
 */
export type PrepareImagesProblem = 'unsupported' | 'unreadable_image' | 'file_too_large';

export type PrepareImagesResult =
  | { readonly ok: true; readonly prepared: PreparedImages }
  | { readonly ok: false; readonly problem: PrepareImagesProblem; readonly created: readonly string[] };

/** What a share may carry as a picture. Anything else is refused before it is decoded. */
const ACCEPTED_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);

/** "IMG_2024.HEIC" → "IMG_2024.jpg": the upload's name says what it now is. */
function renamed(fileName: string, extension: string): string {
  const dot = fileName.lastIndexOf('.');
  return `${dot > 0 ? fileName.slice(0, dot) : fileName}.${extension}`;
}

type Encoded =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly format: 'jpeg' | 'png' }
  | { readonly ok: false; readonly problem: PrepareImagesProblem };

/** Header check, decode once, then encode down the ladder until one fits. Every file written goes into `created`. */
async function encodeWithinBudget(file: SharedFile, ports: ImagePorts, created: string[]): Promise<Encoded> {
  let header: ImageHeader | null;
  try {
    header = imageHeader(ports.bytes.read(file.uri));
  } catch {
    return { ok: false, problem: 'unreadable_image' };
  }
  // Refused before a decode: a header this cannot read, or a picture too big to
  // decode safely. The user is told to share a screenshot, which is neither.
  if (header === null || header.width * header.height > MAX_DECODE_PIXELS) {
    return { ok: false, problem: 'unreadable_image' };
  }
  const ladder: readonly { longEdge: number; format: 'jpeg' | 'png'; quality: number }[] = header.hasAlpha
    ? PNG_ATTEMPTS.map((attempt) => ({ longEdge: attempt.longEdge, format: 'png' as const, quality: 1 }))
    : ENCODE_ATTEMPTS.map((attempt) => ({ ...attempt, format: 'jpeg' as const }));

  let decoded: DecodedImage;
  try {
    decoded = await ports.codec.decode(file.uri);
  } catch {
    // Never logged: the error can carry the path, and a path is a file name.
    return { ok: false, problem: 'unreadable_image' };
  }
  try {
    if (!(decoded.width > 0) || !(decoded.height > 0)) return { ok: false, problem: 'unreadable_image' };
    for (const attempt of ladder) {
      const size = targetSize(decoded.width, decoded.height, attempt.longEdge);
      const uri = await decoded.encode(size, attempt.format, attempt.quality);
      created.push(uri);
      const bytes = ports.bytes.read(uri);
      if (bytes.byteLength <= UPLOAD_IMAGE.maxBytes) return { ok: true, bytes, format: attempt.format };
    }
    return { ok: false, problem: 'file_too_large' };
  } catch {
    return { ok: false, problem: 'unreadable_image' };
  } finally {
    decoded.release();
  }
}

/**
 * Every picture in a share: decoded, downscaled, re-encoded as JPEG, and then
 * stripped (#190, #404).
 *
 * ── The order is the guarantee ───────────────────────────────────
 *
 * Re-encoding converts an iPhone's HEIF into a JPEG and bounds the upload, and
 * it usually drops the photographer's metadata too — but "usually" is a fact
 * about one platform's encoder in one OS version, not a promise. UIKit's JPEG
 * encoder writes APP1 Exif and APP13 Photoshop blocks of its own; a future one
 * could carry the source's GPS across. So the byte-level stripper runs over
 * the encoder's output *unconditionally*, as the last step before the upload,
 * and the second walk checks that nothing is left. Re-encoding is how a HEIF
 * becomes readable; the stripper is the privacy guarantee.
 *
 * Fails the whole share rather than dropping one picture. A user who shared
 * five photographs and got four commitments would have no way to tell which
 * one was left out or why.
 *
 * `created` comes back on both paths, because a failure on the fourth picture
 * still leaves the first three's files on disk and the caller has to delete them.
 */
export async function prepareImages(files: readonly SharedFile[], ports: ImagePorts): Promise<PrepareImagesResult> {
  const prepared: SharedFile[] = [];
  const created: string[] = [];
  let removedSegments = 0;
  let removedBytes = 0;

  for (const file of files) {
    if (!ACCEPTED_IMAGE_TYPES.has(file.mimeType)) return { ok: false, problem: 'unsupported', created };

    const encoded = await encodeWithinBudget(file, ports, created);
    if (!encoded.ok) return { ok: false, problem: encoded.problem, created };

    const mimeType = encoded.format === 'png' ? 'image/png' : 'image/jpeg';
    const extension = encoded.format === 'png' ? 'png' : 'jpg';
    const stripped = (ports.strip ?? stripImageMetadata)(encoded.bytes, mimeType);
    // Fail closed, and checked by a second walk that reports anything it cannot
    // follow as unparsed. An encoder output this could not account for byte by
    // byte is one whose EXIF it cannot promise it removed.
    if (!stripped.ok || metadataSegmentsIn(stripped.bytes, mimeType).length > 0) {
      return { ok: false, problem: 'unreadable_image', created };
    }

    let uri: string;
    try {
      uri = ports.bytes.write(stripped.bytes, extension);
    } catch {
      return { ok: false, problem: 'unreadable_image', created };
    }
    created.push(uri);
    removedSegments += stripped.removedSegments;
    removedBytes += stripped.removedBytes;
    prepared.push({
      ...file,
      uri,
      mimeType,
      fileName: renamed(file.fileName, extension),
      // The size the server will actually receive, so a preview and a limit
      // are both talking about the bytes that exist.
      sizeBytes: stripped.bytes.byteLength,
    });
  }

  return { ok: true, prepared: { files: prepared, created, removedSegments, removedBytes } };
}
