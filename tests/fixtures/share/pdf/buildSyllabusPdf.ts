/**
 * A real PDF out of a list of lines, with no library (UC-3.7, #191).
 *
 * ── Why this exists rather than a dependency ─────────────────────
 *
 * #191 forbids a PDF library outright — `pdf-lib`'s last release is from 2022 —
 * and this product deliberately has no PDF code: a shared PDF goes to Vertex as
 * bytes and is read there. Adding a parser to *build a fixture* would put the
 * very dependency the issue refuses into the tree through the back door. A PDF
 * is a text format, four objects long for a page of text, so the fixture writer
 * is fifty lines of string building.
 *
 * ── The bytes really are a PDF ───────────────────────────────────
 *
 * `%PDF-1.4` (which `mediaType.ts` sniffs), a catalogue, a page tree, a font,
 * one uncompressed content stream per page, a real `xref` table with byte
 * offsets, and `%%EOF`. It opens in a viewer.
 *
 * ── Two honest limits, recorded rather than hidden ───────────────
 *
 * 1. The font is Helvetica with `WinAnsiEncoding`, so the Arabic and Hebrew
 *    fixtures' glyphs will **not** render in a viewer. Embedding a CID font
 *    with a real Unicode TrueType subset is a different order of work and the
 *    bytes for it cannot be written down in a reviewable way. What the
 *    fixtures are for is the deterministic CI mapping test, whose model stub
 *    reads the text out of the content stream exactly as it is written — so
 *    the Arabic and Hebrew *content* is genuinely under test, and only the
 *    rendering is not. The live eval (`scripts/run-share-document-eval.ts`) is
 *    manual and is where a real rendering would be judged.
 * 2. The content stream is uncompressed, on purpose. A reviewer can `strings`
 *    the fixture and see exactly what is on the page, including the white text.
 */
import { SYLLABUS_FIXTURES, type SyllabusFixture } from './syllabusSource';

const encoder = new TextEncoder();

/** A PDF literal string: `\`, `(` and `)` are the three that must be escaped. */
function literal(line: string): string {
  return `(${line.replace(/([\\()])/g, '\\$1')})`;
}

/**
 * One page's content stream.
 *
 * `1 1 1 rg` before the hidden lines is the criterion in one operator: white
 * fill on a white page. A reader sees nothing; a model reads it as text.
 */
function contentStream(page: { lines: readonly string[] }, hidden: readonly string[]): string {
  const lines: string[] = ['BT', '/F1 12 Tf', '50 780 Td', '0 0 0 rg'];
  for (const line of page.lines) {
    lines.push(`${literal(line)} Tj`, '0 -20 Td');
  }
  if (hidden.length > 0) {
    lines.push('1 1 1 rg');
    for (const line of hidden) {
      lines.push(`${literal(line)} Tj`, '0 -20 Td');
    }
  }
  lines.push('ET');
  return `${lines.join('\n')}\n`;
}

/**
 * The fixture as PDF bytes.
 *
 * Deterministic: the same input gives the same bytes, with no date, no id and
 * no random number anywhere in it. That is what lets the suite assert the
 * committed file still matches the words it was built from.
 */
export function buildSyllabusPdf(fixture: SyllabusFixture): Uint8Array {
  const pageCount = fixture.pages.length;
  // 1 catalogue, 2 pages, 3 font, then a page object and a content object each.
  const pageObjectNumber = (index: number) => 4 + index * 2;
  const contentObjectNumber = (index: number) => 5 + index * 2;

  const objects: string[] = [];
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  const kids = fixture.pages.map((_, index) => `${pageObjectNumber(index)} 0 R`).join(' ');
  objects.push(`<< /Type /Pages /Kids [ ${kids} ] /Count ${pageCount} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

  fixture.pages.forEach((page, index) => {
    // The hidden lines go on the last page, where a reader has stopped looking.
    const hidden = index === pageCount - 1 ? fixture.hidden ?? [] : [];
    const stream = contentStream(page, hidden);
    const streamBytes = encoder.encode(stream).byteLength;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 595 842 ] `
      + `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjectNumber(index)} 0 R >>`,
    );
    objects.push(`<< /Length ${streamBytes} >>\nstream\n${stream}endstream`);
  });

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(encoder.encode(body).byteLength);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = encoder.encode(body).byteLength;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return encoder.encode(body + xref + trailer);
}

/** Every fixture, by name, as bytes. Built once per process. */
export function syllabusPdfs(): ReadonlyMap<string, Uint8Array> {
  return new Map(SYLLABUS_FIXTURES.map((fixture) => [fixture.name, buildSyllabusPdf(fixture)]));
}
