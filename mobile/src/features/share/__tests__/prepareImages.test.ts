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
 * That `expo-file-system` writes what it was handed, and that the OS hands over
 * the photograph rather than a re-encoded copy. Both need a device. What it
 * does prove is the thing the criterion is about: the bytes the upload is built
 * from carry no metadata, and a container this cannot account for is refused
 * before an upload starts rather than sent and stripped at the other end.
 */
import { describe, expect, it } from '@jest/globals';
import {
  STRIP_CASES,
  decodeBase64,
  metadataMarkersIn,
  stripCaseNamed,
  type StripCase,
} from '../__fixtures__/stripCases';
import {
  metadataSegmentsIn,
  prepareImages,
  stripImageMetadata,
  type ImageBytesPort,
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

/* ── The share flow's half ───────────────────────────────────────── */

function fileOf(name: string, mimeType: string, uri: string): SharedFile {
  return { uri, mimeType, sizeBytes: 999_999, fileName: name };
}

/** A port that keeps what it was asked to write, so the upload can be inspected. */
function fakePort(): ImageBytesPort & { reads: string[]; written: { uri: string; bytes: Uint8Array }[] } {
  const store = new Map<string, Uint8Array>();
  for (const shared of CASES) store.set(`file:///share/${shared.name}`, decodeBase64(shared.input));
  const written: { uri: string; bytes: Uint8Array }[] = [];
  const reads: string[] = [];
  return {
    reads,
    written,
    read(uri: string): Uint8Array {
      reads.push(uri);
      const bytes = store.get(uri);
      if (!bytes) throw new Error('no such file');
      return bytes;
    },
    write(bytes: Uint8Array, extension: string): string {
      const uri = `file:///cache/stripped-${written.length}.${extension}`;
      written.push({ uri, bytes });
      return uri;
    },
  };
}

describe('prepareImages', () => {
  it('uploads the stripped copy, not the photograph the OS handed over', () => {
    const port = fakePort();
    const posters = ['poster_ar', 'poster_he', 'poster_en', 'notice_en', 'sign_ar'].map(stripCaseNamed);
    const result = prepareImages(
      posters.map((shared) => fileOf(`${shared.name}.img`, shared.mediaType, `file:///share/${shared.name}`)),
      port,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(port.written).toHaveLength(5);
    expect(result.prepared.files.map((file) => file.uri)).toEqual(port.written.map((entry) => entry.uri));
    // Not one of the originals. A descriptor still pointing at the OS's copy is
    // exactly the defect this whole file exists to catch.
    for (const file of result.prepared.files) expect(file.uri.startsWith('file:///cache/')).toBe(true);
    // And the size the upload reports is the size of what will be sent.
    for (const [index, file] of result.prepared.files.entries()) {
      expect(file.sizeBytes).toBe(port.written[index]!.bytes.byteLength);
      expect(file.sizeBytes).toBeLessThan(decodeBase64(posters[index]!.input).byteLength);
    }
    // The name the server reads once for a source hint is unchanged.
    expect(result.prepared.files.map((file) => file.fileName))
      .toEqual(posters.map((shared) => `${shared.name}.img`));
    expect(result.prepared.removedSegments).toBeGreaterThan(0);
  });

  it('puts no metadata in anything it hands to the upload', () => {
    const port = fakePort();
    const posters = ['poster_ar', 'poster_he', 'poster_en'].map(stripCaseNamed);
    prepareImages(
      posters.map((shared) => fileOf('x.img', shared.mediaType, `file:///share/${shared.name}`)),
      port,
    );
    expect(port.written).toHaveLength(3);
    for (const entry of port.written) expect(metadataMarkersIn(entry.bytes)).toEqual([]);
  });

  it('refuses a container it cannot account for, rather than uploading it unstripped', () => {
    for (const name of ['heic_photo', 'truncated_png', 'not_an_image']) {
      const port = fakePort();
      const shared = stripCaseNamed(name);
      const result = prepareImages([fileOf('x.img', shared.mediaType, `file:///share/${name}`)], port);
      expect(result.ok).toBe(false);
      // Nothing was written, so nothing is queued for an upload.
      expect(port.written).toHaveLength(0);
      if (result.ok) continue;
      expect(result.problem).toBe('unsupported');
    }
  });

  it('hands back the copies it already made when a later picture is refused', () => {
    const port = fakePort();
    const result = prepareImages(
      [
        fileOf('a.img', 'image/jpeg', 'file:///share/poster_ar'),
        fileOf('b.img', 'image/heic', 'file:///share/heic_photo'),
      ],
      port,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // One picture was stripped before the second was refused. A caller that
    // could not reach that copy would leave a photograph in the cache directory
    // for the life of the install.
    expect(result.created).toEqual(port.written.map((entry) => entry.uri));
    expect(result.created).toHaveLength(1);
  });

  it('refuses a file it cannot read at all, and says nothing about its path', () => {
    const port = fakePort();
    const result = prepareImages([fileOf('gone.jpg', 'image/jpeg', 'file:///share/not-there')], port);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toBe('unsupported');
    expect(result.created).toEqual([]);
  });

  it('a clean picture still goes through, so this is not "refuse everything"', () => {
    const port = fakePort();
    const shared = stripCaseNamed('clean_jpeg');
    const result = prepareImages([fileOf('x.jpg', 'image/jpeg', 'file:///share/clean_jpeg')], port);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.removedSegments).toBe(0);
    expect(Array.from(port.written[0]!.bytes)).toEqual(Array.from(decodeBase64(shared.input)));
  });
});
