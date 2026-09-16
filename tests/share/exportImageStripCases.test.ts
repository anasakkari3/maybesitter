/**
 * The two metadata strippers, held to one answer (UC-3.6, #190).
 *
 * The same idea as `exportEmailDetectorCases.test.ts`, and the same reason: a
 * thing that exists twice is written down once and both copies are checked
 * against the writing. There the two copies are a detector; here they are
 * `stripImageMetadata` on the server and `stripImageMetadata` in the app, which
 * cannot import each other across the workspace boundary.
 *
 * This file does two things, and the order is the point:
 *
 *  1. asserts the **backend** stripper against properties declared here — the
 *     fixture carried metadata, the output carries none, nothing hidden in the
 *     input survives into the output, and a file with nothing to remove comes
 *     back unchanged;
 *  2. writes the inputs and the outputs to
 *     `mobile/src/features/share/__fixtures__/imageStripCases.json`, which
 *     `mobile/src/features/share/__tests__/prepareImages.test.ts` runs the
 *     **RN** stripper over byte for byte.
 *
 * A backend stripper that disagreed with the declared properties therefore
 * cannot launder its disagreement into the fixture and make the RN suite green
 * against a defect. The criterion is that no APP1/EXIF is in the upload, and
 * the upload is built by the device — so the device's copy is the one that has
 * to be right, and this is what keeps it in step with the one the server also
 * runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { metadataSegmentsIn, stripImageMetadata } from '../../lib/services/share/imageMetadata.ts';
import { HIDDEN_ATTACK, HIDDEN_LOCATION, INJECTION_POSTER, POSTERS } from '../fixtures/share/images/posters.ts';
import type { ShareMediaType } from '../../lib/services/share/shareTypes.ts';
import { ENCODER_LAYOUTS } from '../fixtures/share/images/encoderLayouts.ts';

const ENCODER_FILES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'share', 'images', 'encoder');

/** A real file an encoder wrote. See `encoder/manipulatorHarness.swift` for how each was made. */
function encoderFile(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(ENCODER_FILES, name)));
}

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'mobile', 'src', 'features', 'share', '__fixtures__',
);

interface StripCase {
  readonly name: string;
  readonly mediaType: ShareMediaType | 'image/heif' | 'text/plain';
  readonly bytes: Uint8Array;
  /** Declared, never computed: what a person says should happen to this file. */
  readonly expected: 'stripped' | 'unchanged' | 'refused';
  /**
   * Strings that are in this file's metadata and must not be in its output.
   *
   * Per case rather than one list, because `injection_en` has the attack
   * *printed on the poster* as well as hidden in its EXIF — and the printed
   * copy is meant to survive the strip. It is the model's answer that drops it,
   * which is a different guard in a different file.
   */
  readonly secrets: readonly string[];
  readonly because: string;
}

/** A JPEG with nothing to take out: three bytes of marker and a scan. */
const CLEAN_JPEG = new Uint8Array([
  0xff, 0xd8,
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x40, 0x00, 0x40, 0x01, 0x01, 0x11, 0x00,
  0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
  0x41, 0x42, 0x43, 0x44,
  0xff, 0xd9,
]);

/** A PNG with a payload glued on after `IEND`. */
function pngWithTrailer(): Uint8Array {
  const png = POSTERS[1]!.bytes;
  const trailer = new TextEncoder().encode(HIDDEN_ATTACK);
  const out = new Uint8Array(png.length + trailer.length);
  out.set(png, 0);
  out.set(trailer, png.length);
  return out;
}

/* ── JPEGs that try to hide a segment inside a marker that has no payload (#429 review) ── */

const SECRET_GPS = 'GPS-SECRET-31.7683N-35.2137E';
const ascii8 = (text: string) => Array.from(new TextEncoder().encode(text));
function seg8(code: number, body: number[]): number[] {
  const length = body.length + 2;
  return [0xff, code, (length >> 8) & 0xff, length & 0xff, ...body];
}
const APP1_GPS = seg8(0xe1, [...ascii8('Exif\0\0'), ...ascii8(SECRET_GPS)]);
const SOF0_8 = [0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x40, 0x00, 0x40, 0x01, 0x01, 0x11, 0x00];
const SOS_8 = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00];
/** A second `FF D8` whose next two bytes a length-reading walker takes as covering `hidden`. */
function decoySoi(hidden: number[]): number[] {
  const length = hidden.length + 2;
  return [0xff, 0xd8, (length >> 8) & 0xff, length & 0xff, ...hidden];
}
const THUMBNAIL_8 = [0xff, 0xd8, ...APP1_GPS, ...SOF0_8, ...SOS_8, 0x10, 0x20, 0xff, 0xd9];
const bytes8 = (...parts: number[][]) => new Uint8Array(parts.flat());

/** Markers with no payload, repeated before any scan: the shape of a parser-time bomb. */
export function standaloneMarkerFlood(code: number, pairs: number): Uint8Array {
  const out = new Uint8Array(2 + pairs * 2 + SOF0_8.length + SOS_8.length + 4);
  out.set([0xff, 0xd8], 0);
  for (let index = 0; index < pairs; index += 1) out.set([0xff, code], 2 + index * 2);
  out.set([...SOF0_8, ...SOS_8, 0x41, 0x42, 0xff, 0xd9], 2 + pairs * 2);
  return out;
}

const DECOY_CASES: readonly StripCase[] = [
  {
    name: 'decoy_soi_hides_app1',
    mediaType: 'image/jpeg',
    bytes: bytes8([0xff, 0xd8], decoySoi(APP1_GPS), SOF0_8, SOS_8, [0x41, 0x42], [0xff, 0xd9]),
    expected: 'refused',
    secrets: [],
    because: 'a second SOI has no length; reading one hides an Exif GPS block inside it',
  },
  {
    name: 'decoy_soi_after_scan',
    mediaType: 'image/jpeg',
    bytes: bytes8([0xff, 0xd8], SOF0_8, SOS_8, [0x41, 0x42], decoySoi(APP1_GPS), [0xff, 0xd9]),
    expected: 'refused',
    secrets: [],
    because: 'the same decoy after a scan, where the entropy walk hands it back to the marker loop',
  },
  {
    name: 'decoy_soi_hides_thumbnail',
    mediaType: 'image/jpeg',
    bytes: bytes8([0xff, 0xd8], decoySoi(THUMBNAIL_8), SOF0_8, SOS_8, [0x41, 0x42], [0xff, 0xd9]),
    expected: 'refused',
    secrets: [],
    because: 'a whole thumbnail with its own GPS hidden behind a decoy SOI',
  },
  {
    name: 'tem_before_scan',
    mediaType: 'image/jpeg',
    bytes: standaloneMarkerFlood(0x01, 64),
    expected: 'refused',
    secrets: [],
    because: 'TEM outside a scan is not in a picture an encoder writes; refusing it bounds the walk',
  },
  {
    name: 'restart_marker_before_scan',
    mediaType: 'image/jpeg',
    bytes: standaloneMarkerFlood(0xd0, 64),
    expected: 'refused',
    secrets: [],
    because: 'a restart marker only means something inside a scan',
  },
  {
    name: 'unknown_length_marker',
    mediaType: 'image/jpeg',
    bytes: bytes8([0xff, 0xd8], seg8(0xf7, [...APP1_GPS]), SOF0_8, SOS_8, [0x41, 0x42], [0xff, 0xd9]),
    expected: 'refused',
    secrets: [],
    because: 'a segment code outside the known list is refused rather than copied (JPEG-LS SOF55 here)',
  },
  {
    name: 'jpeg_without_eoi',
    mediaType: 'image/jpeg',
    bytes: bytes8([0xff, 0xd8], SOF0_8, SOS_8, [0x41, 0x42, 0x43]),
    expected: 'refused',
    secrets: [],
    because: 'a picture that never ends is one this cannot account for to the last byte',
  },
];

/** What an iPhone photograph's first bytes look like. */
const HEIC_HEADER = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
  0x00, 0x00, 0x00, 0x00, 0x6d, 0x69, 0x66, 0x31, 0x68, 0x65, 0x69, 0x63,
]);

export const STRIP_CASES: readonly StripCase[] = [
  ...[...POSTERS, INJECTION_POSTER].map((poster): StripCase => ({
    name: poster.name,
    mediaType: poster.mediaType,
    bytes: poster.bytes,
    expected: 'stripped',
    secrets: poster === INJECTION_POSTER ? [HIDDEN_LOCATION] : [HIDDEN_ATTACK, HIDDEN_LOCATION],
    because: 'a poster with EXIF, a comment and an XMP block in it',
  })),
  {
    name: 'clean_jpeg',
    mediaType: 'image/jpeg',
    bytes: CLEAN_JPEG,
    expected: 'unchanged',
    secrets: [],
    because: 'a JPEG with no APPn at all comes back byte for byte, so this is not "always shrink"',
  },
  {
    name: 'png_with_trailer',
    mediaType: 'image/png',
    bytes: pngWithTrailer(),
    expected: 'stripped',
    secrets: [HIDDEN_ATTACK, HIDDEN_LOCATION],
    because: 'a payload glued on after IEND is not part of the picture',
  },
  {
    name: 'heic_photo',
    mediaType: 'image/heic',
    bytes: HEIC_HEADER,
    expected: 'refused',
    secrets: [],
    because: 'HEIF keeps EXIF as an item located by iloc, and a rewrite nobody can test is not a promise',
  },
  /*
   * ── What the manipulator hands the stripper (#404) ──────────────
   *
   * Every picture is now re-encoded on the phone before it is stripped, so the
   * stripper's input is an encoder's output. The synthesized layouts carry a
   * GPS IFD, an IFD1 thumbnail, XMP, IPTC, ICC, a second picture after EOI and
   * metadata between progressive scans; the two real files are UIKit's encoder
   * on the iOS simulator and ImageIO writing a camera JPEG with a thumbnail.
   */
  ...ENCODER_LAYOUTS.map((layout): StripCase => ({
    name: layout.name,
    mediaType: 'image/jpeg',
    bytes: layout.bytes,
    expected: 'stripped',
    secrets: layout.secrets,
    because: layout.because,
  })),
  {
    name: 'ios_uikit_encoder_output',
    mediaType: 'image/jpeg',
    bytes: encoderFile('ios-uikit-encoder-from-heic.jpg'),
    expected: 'stripped',
    // UIKit writes APP1 Exif (orientation, resolution, colour space, size) and
    // APP13 Photoshop 3.0 even for a picture that has nothing to say.
    secrets: ['Exif', 'Photoshop 3.0'],
    because: 'the real bytes UIImage.jpegData writes after the manipulator decoded a GPS-tagged HEIC',
  },
  {
    name: 'imageio_camera_gps_thumbnail',
    mediaType: 'image/jpeg',
    bytes: encoderFile('imageio-camera-gps-thumbnail.jpg'),
    expected: 'stripped',
    secrets: ['HIDDEN-SERIAL', 'HIDDEN-OWNER', 'HIDDEN-EXIF-COMMENT', 'HIDDEN-IPTC-CAPTION'],
    because: 'a real ImageIO JPEG with a GPS IFD and an embedded thumbnail',
  },
  {
    name: 'heic_real_imageio',
    mediaType: 'image/heic',
    bytes: encoderFile('imageio-gps.heic'),
    expected: 'refused',
    secrets: [],
    because: 'a real GPS-tagged HEIF is still never byte-stripped; the phone converts it to JPEG first',
  },
  ...DECOY_CASES,
  {
    name: 'truncated_png',
    mediaType: 'image/png',
    bytes: POSTERS[1]!.bytes.slice(0, 40),
    expected: 'refused',
    secrets: [],
    because: 'a file that ends mid-chunk is one this cannot account for',
  },
  {
    name: 'not_an_image',
    mediaType: 'image/jpeg',
    bytes: new TextEncoder().encode('Parents evening on Thursday at seven.'),
    expected: 'refused',
    secrets: [],
    because: 'bytes that are not the container they claim are refused rather than guessed at',
  },
];

function assertDeclaredProperties(): void {
  for (const shared of STRIP_CASES) {
    const result = stripImageMetadata(shared.bytes, shared.mediaType as ShareMediaType);
    if (shared.expected === 'refused') {
      assert.equal(result.ok, false, `${shared.name}: ${shared.because}`);
      continue;
    }
    assert.equal(result.ok, true, `${shared.name}: ${shared.because}`);
    if (!result.ok) continue;

    // Nothing is left that a second walk can find.
    assert.deepEqual(
      metadataSegmentsIn(result.bytes, shared.mediaType as ShareMediaType),
      [],
      `${shared.name}: a metadata segment survived`,
    );

    if (shared.expected === 'unchanged') {
      assert.equal(result.removedSegments, 0, shared.name);
      assert.deepEqual(Array.from(result.bytes), Array.from(shared.bytes), `${shared.name}: it was changed`);
      continue;
    }

    // It really did carry something, and that something really is gone.
    assert.ok(result.removedSegments > 0, `${shared.name}: nothing was removed`);
    assert.ok(result.bytes.length < shared.bytes.length, `${shared.name}: nothing got smaller`);
    const before = new TextDecoder().decode(shared.bytes);
    const after = new TextDecoder().decode(result.bytes);
    assert.ok(shared.secrets.length > 0, `${shared.name}: nothing declared to disappear`);
    for (const secret of shared.secrets) {
      assert.ok(before.includes(secret), `${shared.name}: the fixture never had "${secret}"`);
      assert.ok(!after.includes(secret), `${shared.name}: "${secret}" survived`);
    }

    if (shared.mediaType === 'image/jpeg') {
      // No second picture: an embedded thumbnail or a secondary image is a
      // whole JPEG, and its `FF D8 FF` is how it is found without a parser.
      assert.deepEqual(nestedJpegStarts(result.bytes), [], `${shared.name}: a second picture survived`);
      assert.deepEqual(nestedJpegStarts(shared.bytes).length > 0 || !shared.name.includes('thumbnail'), true,
        `${shared.name}: the fixture never had a thumbnail`);
      // No GPS: a GPS IFD lives in APP1 Exif, and there is no APPn left to hold one.
      for (const label of ['Exif', 'http://ns.adobe.com/xap', 'Photoshop 3.0', 'ICC_PROFILE', 'MPF']) {
        assert.ok(!after.includes(label), `${shared.name}: "${label}" survived`);
      }
      // Still a whole picture: it ends where a JPEG ends.
      assert.deepEqual(Array.from(result.bytes.subarray(result.bytes.length - 2)), [0xff, 0xd9], shared.name);
    }
  }
}

test('the backend stripper does to every case what a person said it should', () => {
  assertDeclaredProperties();
});

/** Every offset past the first at which a JPEG starts. */
function nestedJpegStarts(bytes: Uint8Array): number[] {
  const found: number[] = [];
  for (let at = 1; at + 2 < bytes.length; at += 1) {
    if (bytes[at] === 0xff && bytes[at + 1] === 0xd8 && bytes[at + 2] === 0xff) found.push(at);
  }
  return found;
}

test('an encoder layout keeps every byte of the picture it strips around (#404)', () => {
  // The other half of "nothing survived": a stripper that returned a bare SOI
  // and EOI would pass every assertion above. The scan, its stuffed FF 00 and
  // its restart markers, and the tables in front of it are all still there.
  for (const layout of ENCODER_LAYOUTS) {
    const result = stripImageMetadata(layout.bytes, 'image/jpeg');
    assert.equal(result.ok, true, layout.name);
    if (!result.ok) continue;
    const after = Buffer.from(result.bytes).toString('latin1');
    assert.ok(after.endsWith(Buffer.from(layout.picture).toString('latin1')), `${layout.name}: the picture was changed`);
    for (const marker of ['\xff\xdb', '\xff\xc4', '\xff\xda', '\xff\x00', '\xff\xd0']) {
      assert.ok(after.includes(marker), `${layout.name}: lost ${JSON.stringify(marker)}`);
    }
  }
});

test('the case list is worth running', () => {
  // A list that is all posters passes against a stripper that only reads
  // JPEG; a list with no `unchanged` case passes against one that truncates
  // every file to its header; a list with no `refused` case passes against one
  // that never fails closed.
  const by = (expected: StripCase['expected']) => STRIP_CASES.filter((shared) => shared.expected === expected).length;
  assert.ok(by('stripped') >= 5, 'too few files with something to remove');
  assert.ok(STRIP_CASES.filter((shared) => shared.name.startsWith('encoder_')).length >= 3,
    'nothing proves the stripper against what an encoder writes (#404)');
  assert.ok(by('unchanged') >= 1, 'nothing proves a clean file is left alone');
  assert.ok(by('refused') >= 3, 'nothing proves this fails closed');
  assert.ok(new Set(STRIP_CASES.map((shared) => shared.mediaType)).size >= 3, 'one container is not a test');
  assert.equal(new Set(STRIP_CASES.map((shared) => shared.name)).size, STRIP_CASES.length, 'two cases share a name');
});

test('the backend stripper refuses a flood of payload-less markers without walking it', () => {
  // 10 MB of `FF 01` / `FF D0` before any scan. Each used to be pushed as its
  // own kept piece — seconds and gigabytes on the server for a 15 MB upload.
  // Refused at the first one now, so the refusal is the whole assertion.
  for (const code of [0x01, 0xd0, 0xd7]) {
    const flood = standaloneMarkerFlood(code, 5 * 1024 * 1024);
    assert.equal(stripImageMetadata(flood, 'image/jpeg').ok, false);
    assert.ok(metadataSegmentsIn(flood, 'image/jpeg').includes('unparsed'));
  }
});

test('the post-check is fail-closed: what it cannot walk to EOI is not called clean', () => {
  for (const shared of DECOY_CASES) {
    assert.notDeepEqual(metadataSegmentsIn(shared.bytes, 'image/jpeg'), [], shared.name);
  }
  assert.deepEqual(metadataSegmentsIn(CLEAN_JPEG, 'image/jpeg'), []);
  assert.deepEqual(metadataSegmentsIn(new Uint8Array([0xff, 0xd8]), 'image/jpeg'), ['unparsed']);
});

test('the cases are exported for the RN suite to run the app stripper over', () => {
  // Written only from a stripper that has just passed every declared property:
  // a failing run must not leave a wrong answer in the committed fixture.
  assertDeclaredProperties();
  mkdirSync(FIXTURES, { recursive: true });
  const exported = STRIP_CASES.map((shared) => {
    const result = stripImageMetadata(shared.bytes, shared.mediaType as ShareMediaType);
    return {
      name: shared.name,
      mediaType: shared.mediaType,
      // Declared, never computed. See the note at the top of this file.
      expected: shared.expected,
      because: shared.because,
      input: Buffer.from(shared.bytes).toString('base64'),
      /*
       * The backend's *output*, which — unlike `expected` — is computed.
       *
       * Safe to compute because `expected` is not: the assertions above have
       * already refused to let a wrong backend reach here. The RN suite
       * compares its own output against this byte for byte, so a rule edited on
       * one side and not the other is a red run rather than two strippers that
       * quietly stopped being the same function.
       */
      output: result.ok ? Buffer.from(result.bytes).toString('base64') : null,
      removedSegments: result.ok ? result.removedSegments : 0,
      removedBytes: result.ok ? result.removedBytes : 0,
    };
  });
  writeFileSync(join(FIXTURES, 'imageStripCases.json'), `${JSON.stringify(exported, null, 2)}\n`, 'utf8');
  assert.equal(exported.length, STRIP_CASES.length);
});
