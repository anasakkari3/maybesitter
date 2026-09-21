/**
 * Writes `tests/fixtures/share/pdf/*.pdf` (UC-3.7, #191).
 *
 *   node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/fixtures/build-syllabus-pdfs.ts
 *
 * The outputs are committed, and `tests/share/documentShare.test.ts` asserts
 * they still match what this produces — so a fixture cannot drift away from the
 * words in `tests/fixtures/share/pdf/syllabusSource.ts` without a red suite.
 * Deterministic: no date, no id, no random number goes into a PDF here.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYLLABUS_FIXTURES } from '../../tests/fixtures/share/pdf/syllabusSource';
import { buildSyllabusPdf } from '../../tests/fixtures/share/pdf/buildSyllabusPdf';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', '..', 'tests', 'fixtures', 'share', 'pdf');

mkdirSync(out, { recursive: true });
for (const fixture of SYLLABUS_FIXTURES) {
  const bytes = buildSyllabusPdf(fixture);
  writeFileSync(join(out, `${fixture.name}.pdf`), bytes);
  // A count and a name this repository wrote itself. Nothing a user shared.
  console.log(`${fixture.name}.pdf  ${bytes.byteLength} bytes`);
}
