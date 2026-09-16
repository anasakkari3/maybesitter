/**
 * JPEGs laid out the way an encoder writes them, not the way a camera does (#404).
 *
 * #190's stripper was held to camera-shaped posters. #404 puts
 * `expo-image-manipulator` in front of it: every shared picture is decoded,
 * downscaled and re-encoded on the phone, and the stripper then runs over the
 * *encoder's* output. So these are the layouts an encoder emits, and each one
 * carries a location or a thumbnail that must not survive:
 *
 *  - `APP1` Exif with a real TIFF structure: IFD0 → a GPS IFD with latitude and
 *    longitude rationals and an area string, and IFD1 → an embedded JPEG
 *    thumbnail, which is a whole second picture of the scene;
 *  - `APP1` XMP with `exif:GPSLatitude`, `APP13` Photoshop/IPTC with a caption,
 *    and `APP2` ICC — stripped like every other `APPn`, consistently, on both
 *    sides, and never "kept because it looked harmless";
 *  - a primary image followed, after its `EOI`, by a secondary JPEG with its own
 *    Exif: the Multi-Picture / gain-map layout iOS HDR photos and Android Ultra
 *    HDR (`JPEG_R`) use. A stripper that copies "everything from `SOS` on"
 *    unread uploads that second file's GPS untouched;
 *  - a progressive JPEG with a comment and an `APP1` *between* scans, which the
 *    format allows and a scan-then-stop walker never looks at.
 *
 * Two real files sit beside these in `encoder/`, written by ImageIO on macOS and
 * by UIKit's JPEG encoder on the iOS simulator through the manipulator's own
 * transformer code; `encoder/manipulatorHarness.swift` says how.
 */

const encoder = new TextEncoder();

export const HIDDEN_GPS_AREA = 'HIDDEN-GPS-AREA Dana home 32.0853N 34.7818E';
export const HIDDEN_THUMBNAIL = 'HIDDEN-THUMBNAIL of the kitchen table';
export const HIDDEN_XMP_GPS = '32,5.118N';
export const HIDDEN_IPTC_CAPTION = 'HIDDEN-IPTC-CAPTION Dana at the nursery gate';
export const HIDDEN_ICC_DEVICE = 'HIDDEN-ICC iPhone 15 Pro of Dana';
export const HIDDEN_SECONDARY = 'HIDDEN-GAIN-MAP secondary image Exif';
export const HIDDEN_BETWEEN_SCANS = 'HIDDEN-BETWEEN-SCANS editor note';

function ascii(text: string): number[] {
  return Array.from(text, (character) => character.charCodeAt(0));
}

function bytesOf(...parts: readonly (number[] | Uint8Array)[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function be16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

function be32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function segment(code: number, body: Uint8Array | number[]): Uint8Array {
  return bytesOf([0xff, code], be16(body.length + 2), body);
}

/* ── The structural segments every encoder writes ─────────────────── */

const JFIF = segment(0xe0, [...ascii('JFIF'), 0x00, 0x01, 0x01, 0x00, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00]);
const DQT = segment(0xdb, [0x00, ...Array.from({ length: 64 }, (_, index) => 1 + (index % 16))]);
const SOF0 = segment(0xc0, [0x08, ...be16(48), ...be16(64), 0x01, 0x01, 0x11, 0x00]);
const SOF2 = segment(0xc2, [0x08, ...be16(48), ...be16(64), 0x01, 0x01, 0x11, 0x00]);
const DHT = segment(0xc4, [0x00, 0x00, 0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
const DRI = segment(0xdd, be16(4));
const SOS = segment(0xda, [0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
const EOI = [0xff, 0xd9];

/**
 * Entropy-coded bytes with the two things a naive scan trips on: a stuffed
 * `FF 00` and a restart marker. Neither is a segment boundary; the picture goes
 * on after both.
 */
function scan(seed: number): number[] {
  const out: number[] = [];
  for (let index = 0; index < 48; index += 1) out.push((seed * 31 + index * 17) % 0xfe);
  return [...out.slice(0, 16), 0xff, 0x00, ...out.slice(16, 32), 0xff, 0xd0, ...out.slice(32), 0xff, 0x00, 0x2a];
}

/** A tiny but structurally whole JPEG, used as the thumbnail and the secondary image. */
function innerJpeg(text: string, extraSegments: readonly Uint8Array[] = []): Uint8Array {
  return bytesOf([0xff, 0xd8], ...extraSegments, DQT, SOF0, DHT, SOS, scan(text.length), encoder.encode(text), EOI);
}

/* ── A TIFF, laid out the way ImageIO and libexif write one ───────── */

/**
 * IFD0 → GPS IFD, IFD0 → IFD1 → thumbnail, big-endian.
 *
 * Offsets are real: a reader that follows the pointers finds the GPS rationals
 * and the thumbnail's `FF D8`, which is what makes this a fixture of *where a
 * phone actually keeps a location* and not a string pasted into a segment.
 */
function exifTiff(thumbnail: Uint8Array): Uint8Array {
  const rational = (numerator: number, denominator: number) => [...be32(numerator), ...be32(denominator)];
  const area = [...ascii('ASCII'), 0, 0, 0, ...ascii(HIDDEN_GPS_AREA)];
  const header = [0x4d, 0x4d, 0x00, 0x2a, ...be32(8)];

  const ifdSize = (count: number) => 2 + count * 12 + 4;
  const ifd0Count = 3;
  const gpsCount = 5;
  const ifd1Count = 2;
  const ifd0At = 8;
  const gpsAt = ifd0At + ifdSize(ifd0Count);
  const gpsDataAt = gpsAt + ifdSize(gpsCount);
  const latitude = [...rational(32, 1), ...rational(5, 1), ...rational(707, 100)];
  const longitude = [...rational(34, 1), ...rational(46, 1), ...rational(5448, 100)];
  const latitudeAt = gpsDataAt;
  const longitudeAt = latitudeAt + latitude.length;
  const areaAt = longitudeAt + longitude.length;
  const makeText = [...ascii('Apple iPhone HIDDEN-SERIAL'), 0];
  const makeAt = areaAt + area.length;
  const ifd1At = makeAt + makeText.length;
  const thumbnailAt = ifd1At + ifdSize(ifd1Count);

  const entry = (tag: number, type: number, count: number, value: number[]) => [
    ...be16(tag), ...be16(type), ...be32(count), ...value,
  ];
  const ifd0 = [
    ...be16(ifd0Count),
    ...entry(0x010f, 2, makeText.length, be32(makeAt)), // Make
    ...entry(0x0112, 3, 1, [0x00, 0x06, 0x00, 0x00]), // Orientation
    ...entry(0x8825, 4, 1, be32(gpsAt)), // GPS IFD pointer
    ...be32(ifd1At), // next IFD: IFD1, the thumbnail
  ];
  const gps = [
    ...be16(gpsCount),
    ...entry(0x0001, 2, 2, [0x4e, 0x00, 0x00, 0x00]), // GPSLatitudeRef N
    ...entry(0x0002, 5, 3, be32(latitudeAt)), // GPSLatitude
    ...entry(0x0003, 2, 2, [0x45, 0x00, 0x00, 0x00]), // GPSLongitudeRef E
    ...entry(0x0004, 5, 3, be32(longitudeAt)), // GPSLongitude
    ...entry(0x001c, 7, area.length, be32(areaAt)), // GPSAreaInformation
    ...be32(0),
  ];
  const ifd1 = [
    ...be16(ifd1Count),
    ...entry(0x0201, 4, 1, be32(thumbnailAt)), // JPEGInterchangeFormat
    ...entry(0x0202, 4, 1, be32(thumbnail.length)), // JPEGInterchangeFormatLength
    ...be32(0),
  ];
  return bytesOf(header, ifd0, gps, latitude, longitude, area, makeText, ifd1, thumbnail);
}

function exifSegment(thumbnailText: string): Uint8Array {
  return segment(0xe1, bytesOf(ascii('Exif'), [0x00, 0x00], exifTiff(innerJpeg(thumbnailText))));
}

const XMP = segment(0xe1, bytesOf(
  ascii('http://ns.adobe.com/xap/1.0/'), [0x00],
  encoder.encode(
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description '
    + `exif:GPSLatitude="${HIDDEN_XMP_GPS}" exif:GPSLongitude="34,46.908E"/></rdf:RDF></x:xmpmeta>`,
  ),
));

/** Photoshop 3.0 → 8BIM 0x0404 → IPTC 2:120 (caption). */
const IPTC = (() => {
  const caption = encoder.encode(HIDDEN_IPTC_CAPTION);
  const record = [0x1c, 0x02, 0x78, ...be16(caption.length), ...caption];
  const padded = record.length % 2 === 0 ? record : [...record, 0x00];
  return segment(0xed, bytesOf(
    ascii('Photoshop 3.0'), [0x00], ascii('8BIM'), be16(0x0404), [0x00, 0x00], be32(record.length), padded,
  ));
})();

const ICC = (() => {
  const description = encoder.encode(HIDDEN_ICC_DEVICE);
  const profile = bytesOf(be32(128 + description.length), ascii('appl'), be32(0x04000000), ascii('mntrRGB XYZ '),
    new Uint8Array(108), description);
  return segment(0xe2, bytesOf(ascii('ICC_PROFILE'), [0x00, 0x01, 0x01], profile));
})();

/** CIPA DC-007 Multi-Picture Format index, pointing at a second image after `EOI`. */
const MPF = segment(0xe2, bytesOf(ascii('MPF'), [0x00], [0x4d, 0x4d, 0x00, 0x2a], be32(8), be16(1),
  be16(0xb000), be16(7), be32(4), ascii('0100'), be32(0)));

/* ── The layouts ──────────────────────────────────────────────────── */

export interface EncoderLayout {
  readonly name: string;
  readonly bytes: Uint8Array;
  /** Strings that are only in metadata, or in a picture that is not the picture. */
  readonly secrets: readonly string[];
  /** The primary picture, from its first `SOS` to its `EOI`, as it must come out. */
  readonly picture: Uint8Array;
  readonly because: string;
}

export const ENCODER_LAYOUTS: readonly EncoderLayout[] = [
  {
    name: 'encoder_exif_gps_thumbnail_icc',
    bytes: bytesOf([0xff, 0xd8], JFIF, exifSegment(HIDDEN_THUMBNAIL), ICC, DQT, SOF0, DHT, DRI, SOS, scan(1), EOI),
    picture: bytesOf(SOS, scan(1), EOI),
    secrets: [HIDDEN_GPS_AREA, HIDDEN_THUMBNAIL, HIDDEN_ICC_DEVICE, 'HIDDEN-SERIAL'],
    because: 'APP1 Exif with a GPS IFD and an IFD1 thumbnail, and an APP2 ICC profile, ahead of the tables',
  },
  {
    name: 'encoder_xmp_iptc',
    bytes: bytesOf([0xff, 0xd8], JFIF, exifSegment(HIDDEN_THUMBNAIL), XMP, IPTC, DQT, SOF0, DHT, SOS, scan(2), EOI),
    picture: bytesOf(SOS, scan(2), EOI),
    secrets: [HIDDEN_GPS_AREA, HIDDEN_THUMBNAIL, HIDDEN_XMP_GPS, HIDDEN_IPTC_CAPTION],
    because: 'a second APP1 holding XMP GPS and an APP13 IPTC caption, the way an editor re-saves',
  },
  {
    name: 'encoder_mpf_secondary_image',
    bytes: bytesOf(
      [0xff, 0xd8], JFIF, exifSegment(HIDDEN_THUMBNAIL), MPF, DQT, SOF0, DHT, SOS, scan(3), EOI,
      innerJpeg(HIDDEN_SECONDARY, [exifSegment(HIDDEN_SECONDARY), XMP]),
    ),
    picture: bytesOf(SOS, scan(3), EOI),
    secrets: [HIDDEN_GPS_AREA, HIDDEN_THUMBNAIL, HIDDEN_SECONDARY, HIDDEN_XMP_GPS],
    because: 'a gain-map or MPF second picture after EOI carries its own Exif and is not this picture',
  },
  {
    name: 'progressive_metadata_between_scans',
    bytes: bytesOf(
      [0xff, 0xd8], JFIF, DQT, SOF2, DHT, SOS, scan(4),
      DHT, segment(0xfe, encoder.encode(HIDDEN_BETWEEN_SCANS)), exifSegment(HIDDEN_THUMBNAIL),
      SOS, scan(5), EOI,
    ),
    picture: bytesOf(SOS, scan(4), DHT, SOS, scan(5), EOI),
    secrets: [HIDDEN_BETWEEN_SCANS, HIDDEN_GPS_AREA, HIDDEN_THUMBNAIL],
    because: 'a comment and an APP1 between two progressive scans are still metadata',
  },
];
