/**
 * No EXIF leaves this phone (UC-3.6, #190).
 *
 * ── Two strippers, one set of answers ────────────────────────────
 *
 * `imageStripCases.json` is written by `tests/share/exportImageStripCases.test.ts`
 * at the repository root, which first asserts the backend stripper against
 * properties a person declared — this file carried EXIF, that one had nothing
 * to remove, this one must be refused — and only then exports the bytes. So the
 * fixture cannot carry a wrong answer into this suite, and this suite going
 * green means the app and the server do the same thing to the same file, byte
 * for byte.
 *
 * ── The oracle here is not the implementation ────────────────────
 *
 * `metadataMarkersIn` — in `__fixtures__/stripCases.ts` — scans the output for
 * the raw byte patterns: an `APPn` marker, the ASCII `Exif`, `eXIf`, `EXIF`,
 * `XMP`. It does not re-walk the container with the code under test, because a
 * structural re-walk agrees with the stripper by construction; a byte scan does
 * not, so a stripper that "removed" a segment by mislabelling it still fails
 * here.
 *
 * ── What this cannot prove ───────────────────────────────────────
 *
 * That `expo-file-system` writes what it was handed, and what
 * `expo-image-manipulator` really emits on a given phone. The codec here is a
 * fake that writes the *worst* encoder output there is — Exif with a GPS IFD, a
 * thumbnail and an ICC profile — so the upload being clean is the stripper's
 * doing and not the encoder's courtesy. What UIKit's encoder really writes is
 * a strip case of its own (`ios_uikit_encoder_output`, #404).
 */
import { describe, expect, it } from '@jest/globals';
import {
  STRIP_CASES,
  decodeBase64,
  metadataMarkersIn,
  stripCaseBytes,
  stripCaseNamed,
  type StripCase,
} from '../__fixtures__/stripCases';
import {
  ENCODE_ATTEMPTS,
  UPLOAD_IMAGE,
  metadataSegmentsIn,
  prepareImages,
  stripImageMetadata,
  targetSize,
  type DecodedImage,
  type ImageBytesPort,
  type ImageCodecPort,
  type ImageSize,
} from '../prepareImages';
import type { SharedFile } from '../intake';

const CASES = STRIP_CASES;

describe('the app stripper and the server stripper are the same function', () => {
  it('has a fixture worth running', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(9);
    const by = (expected: StripCase['expected']) => CASES.filter((shared) => shared.expected === expected);
    expect(by('stripped').length).toBeGreaterThanOrEqual(5);
    expect(by('unchanged').length).toBeGreaterThanOrEqual(1);
    expect(by('refused').length).toBeGreaterThanOrEqual(3);
    expect(new Set(CASES.map((shared) => shared.mediaType)).size).toBeGreaterThanOrEqual(3);
    // Five identical files would let a size or format mutation through.
    expect(new Set(CASES.map((shared) => shared.input.length)).size).toBeGreaterThanOrEqual(6);
  });

  it.each(CASES.map((shared) => [shared.name, shared] as const))(
    'answers %s the way the server did',
    (_name, shared) => {
      const input = decodeBase64(shared.input);
      const result = stripImageMetadata(input, shared.mediaType);

      if (shared.expected === 'refused') {
        expect(result.ok).toBe(false);
        expect(shared.output).toBeNull();
        return;
      }

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(Array.from(result.bytes)).toEqual(Array.from(decodeBase64(shared.output!)));
      expect(result.removedSegments).toBe(shared.removedSegments);
      expect(result.removedBytes).toBe(shared.removedBytes);
      expect(metadataSegmentsIn(result.bytes, shared.mediaType)).toEqual([]);
    },
  );

  it('leaves no APP1, no EXIF chunk and no XMP in anything it stripped', () => {
    let checked = 0;
    for (const shared of CASES) {
      if (shared.expected === 'refused') continue;
      const input = decodeBase64(shared.input);
      const result = stripImageMetadata(input, shared.mediaType);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      // The scan finds them in the input, so the empty answer below is a
      // removal and not a scan that never worked.
      if (shared.expected === 'stripped') expect(metadataMarkersIn(input).length).toBeGreaterThan(0);
      expect(metadataMarkersIn(result.bytes)).toEqual([]);
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(6);
  });
});

/* ── The share flow's half (#190, #404) ──────────────────────────── */

function fileOf(name: string, mimeType: string, uri: string): SharedFile {
  return { uri, mimeType, sizeBytes: 999_999, fileName: name };
}

/** A port over an in-memory disk, so the codec's output and the upload can both be inspected. */
function fakePort(): ImageBytesPort & {
  store: Map<string, Uint8Array>;
  written: { uri: string; bytes: Uint8Array }[];
} {
  const store = new Map<string, Uint8Array>();
  const written: { uri: string; bytes: Uint8Array }[] = [];
  return {
    store,
    written,
    read(uri: string): Uint8Array {
      const bytes = store.get(uri);
      if (!bytes) throw new Error('no such file');
      return bytes;
    },
    write(bytes: Uint8Array, extension: string): string {
      const uri = `file:///cache/stripped-${written.length}.${extension}`;
      written.push({ uri, bytes });
      store.set(uri, bytes);
      return uri;
    },
  };
}

/**
 * The encoder at its worst: every JPEG it writes carries Exif with a GPS IFD,
 * an embedded thumbnail and an ICC profile, taken from the strip cases. A real
 * encoder writes less (see `ios_uikit_encoder_output`); a test that passes
 * against this one does not depend on that.
 */
const ENCODER_OUTPUT = stripCaseBytes('encoder_exif_gps_thumbnail_icc');
const MB = 1024 * 1024;

/** The encoder output padded inside its scan to `size` bytes, still a whole JPEG. */
function encodedOfSize(size: number): Uint8Array {
  const body = ENCODER_OUTPUT.subarray(0, ENCODER_OUTPUT.length - 2);
  const out = new Uint8Array(Math.max(size, ENCODER_OUTPUT.length));
  out.set(body, 0);
  out[out.length - 2] = 0xff;
  out[out.length - 1] = 0xd9;
  return out;
}

interface Picture {
  readonly width: number;
  readonly height: number;
}

type Encode = { uri: string; size: ImageSize | null; quality: number };

function fakeCodec(
  port: ReturnType<typeof fakePort>,
  pictures: Readonly<Record<string, Picture>>,
  bytesFor: (size: ImageSize | null, quality: number) => Uint8Array = () => ENCODER_OUTPUT,
): ImageCodecPort & { encodes: Encode[]; released: string[]; decoded: string[] } {
  const encodes: Encode[] = [];
  const released: string[] = [];
  const decoded: string[] = [];
  return {
    encodes,
    released,
    decoded,
    async decode(uri: string): Promise<DecodedImage> {
      decoded.push(uri);
      const picture = pictures[uri];
      // What the manipulator does with a HEIF on an Android below API 28, or
      // with bytes that are not a picture: the promise rejects.
      if (!picture) throw new Error('Loading bitmap failed');
      return {
        width: picture.width,
        height: picture.height,
        async encodeJpeg(size: ImageSize | null, quality: number): Promise<string> {
          const out = `file:///cache/ImageManipulator/${encodes.length}.jpg`;
          encodes.push({ uri, size, quality });
          port.store.set(out, bytesFor(size, quality));
          return out;
        },
        release(): void {
          released.push(uri);
        },
      };
    },
  };
}

const IPHONE_HEIC = 'file:///share/IMG_2024.HEIC';
const SCREENSHOT = 'file:///share/Screenshot.png';
const SMALL = 'file:///share/small.webp';
const PICTURES: Record<string, Picture> = {
  [IPHONE_HEIC]: { width: 4032, height: 3024 },
  [SCREENSHOT]: { width: 1170, height: 2532 },
  [SMALL]: { width: 800, height: 600 },
};

function nestedJpegStarts(bytes: Uint8Array): number[] {
  const found: number[] = [];
  for (let at = 1; at + 2 < bytes.length; at += 1) {
    if (bytes[at] === 0xff && bytes[at + 1] === 0xd8 && bytes[at + 2] === 0xff) found.push(at);
  }
  return found;
}

describe('the size a picture is sent at (#404)', () => {
  it('brings the long edge down to 2048 and keeps the shape', () => {
    expect(targetSize(4032, 3024, 2048)).toEqual({ width: 2048, height: 1536 });
    expect(targetSize(3024, 4032, 2048)).toEqual({ width: 1536, height: 2048 });
    expect(targetSize(1170, 2532, 2048)).toEqual({ width: 946, height: 2048 });
  });

  it('never makes a picture bigger than it was', () => {
    expect(targetSize(800, 600, 2048)).toBeNull();
    expect(targetSize(2048, 1000, 2048)).toBeNull();
    expect(targetSize(1600, 1200, 1600)).toBeNull();
  });

  it('never rounds a very thin picture down to nothing', () => {
    expect(targetSize(10_000, 1, 2048)).toEqual({ width: 2048, height: 1 });
  });

  it('tries 2048 at q0.8 first, gives up quality before pixels, and never goes below 1600', () => {
    /*
     * The legibility condition: text on a flyer is what this feature reads, so
     * pixels are the last thing given up. Every attempt at the full edge comes
     * before any attempt at a smaller one, and no attempt is smaller than the
     * documented minimum.
     */
    expect(UPLOAD_IMAGE).toEqual({ longEdge: 2048, minimumLongEdge: 1600, maxBytes: 6 * MB });
    expect(ENCODE_ATTEMPTS[0]).toEqual({ longEdge: 2048, quality: 0.8 });
    expect(ENCODE_ATTEMPTS.length).toBeGreaterThanOrEqual(3);
    expect(ENCODE_ATTEMPTS.length).toBeLessThanOrEqual(6);
    const fullEdge = ENCODE_ATTEMPTS.filter((attempt) => attempt.longEdge === UPLOAD_IMAGE.longEdge).length;
    expect(fullEdge).toBeGreaterThanOrEqual(3);
    ENCODE_ATTEMPTS.forEach((attempt, index) => {
      expect(attempt.longEdge).toBeGreaterThanOrEqual(UPLOAD_IMAGE.minimumLongEdge);
      expect(attempt.longEdge).toBeLessThanOrEqual(UPLOAD_IMAGE.longEdge);
      expect(attempt.quality).toBeGreaterThan(0);
      expect(attempt.quality).toBeLessThanOrEqual(0.8);
      if (index === 0) return;
      const before = ENCODE_ATTEMPTS[index - 1]!;
      // Each attempt gives something up, and only one thing at a time.
      expect(attempt.longEdge <= before.longEdge && attempt.quality <= before.quality).toBe(true);
      expect(attempt.longEdge < before.longEdge || attempt.quality < before.quality).toBe(true);
      if (index < fullEdge) expect(attempt.longEdge).toBe(UPLOAD_IMAGE.longEdge);
    });
  });
});

describe('prepareImages (#190, #404)', () => {
  it('an iPhone photo is decoded, downscaled, re-encoded as JPEG, and then stripped', async () => {
    const port = fakePort();
    const codec = fakeCodec(port, PICTURES);
    const result = await prepareImages([fileOf('IMG_2024.HEIC', 'image/heic', IPHONE_HEIC)], { bytes: port, codec });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(codec.encodes).toEqual([{ uri: IPHONE_HEIC, size: { width: 2048, height: 1536 }, quality: 0.8 }]);
    const [file] = result.prepared.files;
    // A JPEG now, and named like one, so the server's sniff and the declaration agree.
    expect(file!.mimeType).toBe('image/jpeg');
    expect(file!.fileName).toBe('IMG_2024.jpg');
    expect(file!.uri).toBe(port.written[0]!.uri);
    expect(file!.sizeBytes).toBe(port.written[0]!.bytes.byteLength);
    expect(codec.released).toEqual([IPHONE_HEIC]);
  });

  it('puts nothing the encoder wrote into the upload: no GPS, no thumbnail, no APPn', async () => {
    const port = fakePort();
    const codec = fakeCodec(port, PICTURES);
    const result = await prepareImages(
      [
        fileOf('IMG_2024.HEIC', 'image/heic', IPHONE_HEIC),
        fileOf('Screenshot.png', 'image/png', SCREENSHOT),
        fileOf('small.webp', 'image/webp', SMALL),
      ],
      { bytes: port, codec },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The encoder output really did carry all of it, so the empty answers below are removals.
    expect(metadataMarkersIn(ENCODER_OUTPUT)).toEqual(expect.arrayContaining(['Exif', 'APPn']));
    expect(nestedJpegStarts(ENCODER_OUTPUT).length).toBeGreaterThan(0);
    expect(port.written).toHaveLength(3);
    for (const entry of port.written) {
      expect(metadataMarkersIn(entry.bytes)).toEqual([]);
      expect(nestedJpegStarts(entry.bytes)).toEqual([]);
      expect(new TextDecoder('utf-8').decode(entry.bytes)).not.toContain('HIDDEN-');
      expect(result.prepared.files.map((file) => file.uri)).toContain(entry.uri);
    }
    expect(result.prepared.removedSegments).toBeGreaterThanOrEqual(3 * 3);
  });

  it('never upscales: a picture already under 2048 is re-encoded at its own size', async () => {
    const port = fakePort();
    const codec = fakeCodec(port, PICTURES);
    await prepareImages(
      [fileOf('small.webp', 'image/webp', SMALL), fileOf('Screenshot.png', 'image/png', SCREENSHOT)],
      { bytes: port, codec },
    );
    expect(codec.encodes).toEqual([
      { uri: SMALL, size: null, quality: 0.8 },
      { uri: SCREENSHOT, size: { width: 946, height: 2048 }, quality: 0.8 },
    ]);
  });

  it('an encode over 6 MB is retried at a lower quality before a smaller size', async () => {
    const port = fakePort();
    // Too big until the quality drops to 0.6 at the full edge.
    const codec = fakeCodec(port, PICTURES, (_size, quality) => encodedOfSize(quality > 0.6 ? 7 * MB : 5 * MB));
    const result = await prepareImages([fileOf('IMG_2024.HEIC', 'image/heic', IPHONE_HEIC)], { bytes: port, codec });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(codec.encodes.map((encode) => [encode.size?.width, encode.quality])).toEqual(
      ENCODE_ATTEMPTS.slice(0, codec.encodes.length).map((attempt) => [attempt.longEdge, attempt.quality]),
    );
    expect(codec.encodes.every((encode) => encode.size!.width === 2048)).toBe(true);
    expect(codec.encodes[codec.encodes.length - 1]!.quality).toBeLessThanOrEqual(0.6);
    expect(result.prepared.files[0]!.sizeBytes).toBeLessThanOrEqual(UPLOAD_IMAGE.maxBytes);
    // Every oversized encode is on disk too, and the caller is told so it can delete them.
    for (const encode of codec.encodes.keys()) {
      expect(result.prepared.created).toContain(`file:///cache/ImageManipulator/${encode}.jpg`);
    }
    expect(result.prepared.created).toContain(port.written[0]!.uri);
  });

  it('refuses as too large rather than go below 1600, and tries a bounded number of times', async () => {
    const port = fakePort();
    const codec = fakeCodec(port, PICTURES, () => encodedOfSize(7 * MB));
    const result = await prepareImages([fileOf('IMG_2024.HEIC', 'image/heic', IPHONE_HEIC)], { bytes: port, codec });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toBe('file_too_large');
    expect(codec.encodes).toHaveLength(ENCODE_ATTEMPTS.length);
    for (const encode of codec.encodes) expect(Math.max(encode.size!.width, encode.size!.height)).toBeGreaterThanOrEqual(1600);
    // Nothing was stripped and written for an upload.
    expect(port.written).toHaveLength(0);
    expect(result.created).toHaveLength(ENCODE_ATTEMPTS.length);
    expect(codec.released).toEqual([IPHONE_HEIC]);
  });

  it('a picture the phone cannot decode is refused with words for it, not a crash', async () => {
    // An Android below API 28 cannot decode HEIF: `minSdk` is 24.
    const port = fakePort();
    const codec = fakeCodec(port, {});
    const result = await prepareImages([fileOf('IMG_2024.HEIC', 'image/heic', IPHONE_HEIC)], { bytes: port, codec });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toBe('unreadable_image');
    expect(result.created).toEqual([]);
    expect(port.written).toHaveLength(0);
  });

  it('an encoder output that is not a JPEG it can account for is refused, not uploaded', async () => {
    const port = fakePort();
    const codec = fakeCodec(port, PICTURES, () => new TextEncoder().encode('not a jpeg at all'));
    const result = await prepareImages([fileOf('IMG_2024.HEIC', 'image/heic', IPHONE_HEIC)], { bytes: port, codec });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toBe('unreadable_image');
    expect(port.written).toHaveLength(0);
    // The encoder's file is still handed back to be deleted.
    expect(result.created).toEqual(['file:///cache/ImageManipulator/0.jpg']);
  });

  it('refuses a type it does not accept without decoding it', async () => {
    const port = fakePort();
    const codec = fakeCodec(port, { 'file:///share/a.gif': { width: 10, height: 10 } });
    const result = await prepareImages([fileOf('a.gif', 'image/gif', 'file:///share/a.gif')], { bytes: port, codec });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toBe('unsupported');
    expect(codec.decoded).toEqual([]);
  });

  it('hands back every copy it already made when a later picture is refused', async () => {
    const port = fakePort();
    const codec = fakeCodec(port, PICTURES);
    const result = await prepareImages(
      [fileOf('IMG_2024.HEIC', 'image/heic', IPHONE_HEIC), fileOf('gone.heic', 'image/heic', 'file:///share/gone')],
      { bytes: port, codec },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The first picture's encoder output and its stripped copy. A caller that
    // could not reach them would leave a photograph in the cache directory.
    expect(result.created).toEqual(['file:///cache/ImageManipulator/0.jpg', port.written[0]!.uri]);
    expect(codec.released).toEqual([IPHONE_HEIC]);
  });

  it('releases the decoded picture even when encoding throws', async () => {
    const port = fakePort();
    const codec = fakeCodec(port, PICTURES);
    const failing: ImageCodecPort = {
      async decode(uri) {
        const decoded = await codec.decode(uri);
        return { ...decoded, encodeJpeg: async () => { throw new Error('out of memory'); } };
      },
    };
    const result = await prepareImages([fileOf('IMG_2024.HEIC', 'image/heic', IPHONE_HEIC)], { bytes: port, codec: failing });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toBe('unreadable_image');
    expect(codec.released).toEqual([IPHONE_HEIC]);
  });
});
