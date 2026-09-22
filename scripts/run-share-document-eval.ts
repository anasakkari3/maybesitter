/**
 * The live document eval (UC-3.7, #191). **Manual. Never run in CI.**
 *
 *   node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/run-share-document-eval.ts
 *   → evaluation-reports/share-document-<date>.json
 *
 * ── What it is for, and what CI does instead ─────────────────────
 *
 * `tests/share/documentShare.test.ts` checks the mapping deterministically
 * against a stub that can only read what it was handed, so every rule — the
 * year inference, the past-drop, the injection guard, the token cap — is
 * covered without a network. What a stub cannot tell us is whether *Gemini*
 * reads a page of a syllabus correctly, which is a question about the model and
 * only a real call answers it. That is this script, and it is why it is run by
 * a person who meant to spend the money rather than by a suite.
 *
 * ── It refuses to run by accident ────────────────────────────────
 *
 * `MAYBESITTER_LIVE_DOCUMENT_EVAL=1` is required. Without it this prints what
 * it would have done and exits 0, so a copied command line in CI costs nothing.
 *
 * ── The honest limit of the committed fixtures ───────────────────
 *
 * `tests/fixtures/share/pdf/*.pdf` are built by `scripts/fixtures/build-syllabus-pdfs.ts`
 * with a Helvetica/WinAnsi font, because writing an embedded Unicode font by
 * hand is not reviewable. The Arabic and Hebrew fixtures therefore do not
 * *render* their glyphs, and a real model asked to read one will score badly
 * for a reason that is about the fixture and not about the product. So this
 * script takes `--pdf <path>` and expects a real syllabus for the ar/he runs;
 * the committed fixtures are the English baseline and the shape check.
 *
 * ── Nothing it reads is kept ─────────────────────────────────────
 *
 * The report holds counts, kinds, resolved dates and the fixture's own
 * expectations. Not the document's text, not its title, not a file name.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shareLlmProvider } from '../lib/llm/shareProvider.ts';
import { readDocument } from '../lib/services/share/pdfShare.ts';
import { SYLLABUS_LOCALES } from '../tests/fixtures/share/pdf/syllabusSource.ts';
import type { SharePreprocessorInput } from '../lib/services/share/shareTypes.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The zone the eval reads dates in. A real student's, not a server's. */
const ZONE = 'Asia/Jerusalem';

export interface DocumentEvalCase {
  /** A label this repository wrote. Never a shared file's name. */
  readonly id: string;
  readonly path: string;
  /** How many dated items the document actually has. */
  readonly expectedItems: number;
}

export interface DocumentEvalReport {
  readonly runAt: string;
  readonly zone: string;
  readonly cases: readonly {
    readonly id: string;
    readonly expectedItems: number;
    readonly itemCount: number;
    readonly withDates: number;
    readonly droppedPast: number;
    readonly ignoredSegments: number;
    readonly promptTokens: number;
    readonly kinds: Readonly<Record<string, number>>;
    readonly error: string | null;
  }[];
}

function casesFrom(argv: readonly string[]): DocumentEvalCase[] {
  const explicit: DocumentEvalCase[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--pdf') continue;
    const path = argv[index + 1];
    if (!path) throw new Error('--pdf needs a path');
    explicit.push({ id: `supplied-${basename(path, '.pdf')}`, path, expectedItems: 10 });
  }
  if (explicit.length > 0) return explicit;
  return SYLLABUS_LOCALES.map((name) => ({
    id: name,
    path: resolve(REPO_ROOT, 'tests/fixtures/share/pdf', `${name}.pdf`),
    expectedItems: 10,
  }));
}

async function main(): Promise<void> {
  const cases = casesFrom(process.argv.slice(2));
  if (process.env.MAYBESITTER_LIVE_DOCUMENT_EVAL !== '1') {
    console.log('MAYBESITTER_LIVE_DOCUMENT_EVAL is not 1 — nothing was sent.');
    console.log(`Would have read ${cases.length} document(s): ${cases.map((one) => one.id).join(', ')}`);
    return;
  }

  const uid = process.env.MAYBESITTER_EVAL_UID;
  if (!uid) throw new Error('MAYBESITTER_EVAL_UID must name the account this eval bills to');

  const generateStructured = shareLlmProvider(uid);
  const results: DocumentEvalReport['cases'][number][] = [];

  for (const one of cases) {
    const bytes = new Uint8Array(readFileSync(one.path));
    const input: SharePreprocessorInput = {
      kind: 'pdf',
      sourceHint: 'unknown',
      text: null,
      files: [{ mediaType: 'application/pdf', byteLength: bytes.byteLength, bytes }],
      timezone: ZONE,
      referenceTime: new Date(),
    };
    try {
      const read = await readDocument(input, {
        uid,
        uidHash: 'eval',
        generateStructured,
        readAiConsent: async () => 'granted',
        limits: { maxTotalBytes: 25 * 1024 * 1024, maxFileBytes: 15 * 1024 * 1024, maxFiles: 5, maxTextCharacters: 20_000 },
      });
      const kinds: Record<string, number> = {};
      for (const item of read.items) kinds[item.kind] = (kinds[item.kind] ?? 0) + 1;
      results.push({
        id: one.id,
        expectedItems: one.expectedItems,
        itemCount: read.items.length,
        withDates: read.items.filter((item) => item.dueAt !== null).length,
        droppedPast: read.droppedPast,
        ignoredSegments: read.injectedItems + read.injectedTranscript + read.injectedCaption,
        promptTokens: read.promptTokens,
        kinds,
        error: null,
      });
    } catch (error) {
      // The *name* of the failure. A provider's message can quote the request,
      // and here the request is somebody's syllabus.
      results.push({
        id: one.id,
        expectedItems: one.expectedItems,
        itemCount: 0,
        withDates: 0,
        droppedPast: 0,
        ignoredSegments: 0,
        promptTokens: 0,
        kinds: {},
        error: error instanceof Error ? error.name : 'unknown',
      });
    } finally {
      bytes.fill(0);
    }
  }

  const report: DocumentEvalReport = { runAt: new Date().toISOString(), zone: ZONE, cases: results };
  const out = resolve(REPO_ROOT, 'evaluation-reports');
  mkdirSync(out, { recursive: true });
  const path = resolve(out, `share-document-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`wrote ${path}`);
  for (const result of results) {
    console.log(`${result.id}: ${result.itemCount}/${result.expectedItems} items, ${result.withDates} dated`);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'the eval failed');
  process.exitCode = 1;
});
