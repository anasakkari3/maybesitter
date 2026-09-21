/**
 * A stand-in for the model, for the document channel's tests (UC-3.7, #191).
 *
 * ── It reads the document it was handed, and nothing else ────────
 *
 * The same argument `imageModelStub.ts` makes, and it matters here for the
 * criterion about hidden text. The obvious stub returns a canned list of items;
 * every claim built on one is a claim about the stub. "The white-on-white
 * instruction produced no item" would pass because the canned answer happens
 * not to contain it, and would go on passing after the injection guard was
 * deleted.
 *
 * So this pulls the text literals out of the PDF content stream it was given —
 * which is exactly what is printed on the page, white text included — or out of
 * the untrusted text block for a `.txt`. It can only answer out of what it was
 * shown. The hidden attack therefore *does* come back as an item and as the
 * transcript sample, the channel's post-model guard is the only thing that
 * stops it, and breaking that guard turns this suite red on a commitment
 * nobody asked for.
 *
 * ── It guesses the year, like a model would ──────────────────────
 *
 * Every date in the fixtures is yearless (`12/10`). This stub stamps
 * `modelYear` on all of them, which is what a model does: it answers with the
 * year it thinks it is. `inferItemDate` is what fixes that, so the suite's
 * date assertions are assertions about the **rules** — and a stub that
 * helpfully guessed the right year would have hidden every one of them.
 */
import {
  BEGIN_UNTRUSTED_SHARED_CONTENT,
  END_UNTRUSTED_SHARED_CONTENT,
  type LlmPart,
  type ShareStructuredGenerator,
} from '../../lib/services/share/shareTypes.ts';
import { TRANSCRIPT_SAMPLE_CHARACTERS } from '../../lib/services/share/prompts/documentPrompt.ts';

export interface DocumentStubCall {
  readonly system: string;
  /** Every text part, joined. The caption, when one was sent. */
  readonly text: string;
  /** Every line this call could read out of the document it was handed. */
  readonly seen: readonly string[];
  readonly mediaTypes: readonly string[];
  readonly inlineBytes: number;
  readonly maxOutputTokens: number | undefined;
}

export interface DocumentModelStub {
  readonly generate: ShareStructuredGenerator;
  readonly calls: DocumentStubCall[];
}

/** The one text part a channel wrapped, unwrapped. '' when there was none. */
export function untrustedContentOf(text: string): string {
  const begin = text.indexOf(BEGIN_UNTRUSTED_SHARED_CONTENT);
  const end = text.lastIndexOf(END_UNTRUSTED_SHARED_CONTENT);
  if (begin < 0 || end < 0) return '';
  return text.slice(begin + BEGIN_UNTRUSTED_SHARED_CONTENT.length, end).trim();
}

/**
 * Every line printed on a PDF's pages, in order, with the page it is on.
 *
 * The content streams these fixtures carry are uncompressed and every line is a
 * `(…) Tj`, so this is a reader of what is on the page rather than a PDF
 * parser. It knows nothing about the colour the text was set in — which is the
 * point: white-on-white comes back exactly like anything else.
 */
export function printedLinesIn(bytes: Uint8Array): { text: string; page: number }[] {
  const decoded = new TextDecoder('utf-8').decode(bytes);
  const lines: { text: string; page: number }[] = [];
  let page = 0;
  // One `BT … ET` block per page in these fixtures.
  for (const block of decoded.split('BT\n').slice(1)) {
    page += 1;
    const body = block.split('\nET')[0] ?? '';
    const literals = /\((?:\\.|[^\\()])*\)\s*Tj/g;
    let match = literals.exec(body);
    while (match !== null) {
      const raw = match[0].slice(1, match[0].lastIndexOf(')'));
      const text = raw.replace(/\\([\\()])/g, '$1').trim();
      if (text !== '') lines.push({ text, page });
      match = literals.exec(body);
    }
  }
  return lines;
}

/** `12/10`, or `20/11 10:00`. Never a year — the fixtures deliberately have none. */
const DATE = /\b(\d{1,2})\/(\d{1,2})\b(?:\s+(\d{1,2}):(\d{2}))?/;
/** `2026/27`, the academic year. Checked first so it is not read as a date. */
const TERM_YEAR = /\b(20\d\d)\/\d\d\b/;
/** `10:00-12:00`, a weekly session's slot. */
const SLOT = /\b(\d{2}):(\d{2})\s*[-–]\s*(\d{2}):(\d{2})\b/;

const KIND_WORDS: readonly (readonly [RegExp, string])[] = [
  [/quiz|اختبار قصير|בוחן/i, 'quiz'],
  [/exam|امتحان|מבחן/i, 'exam'],
  [/presentation|عرض تقديمي|מצגת/i, 'presentation'],
  [/assignment|الوظيفة|מטלה/i, 'assignment'],
  [/deadline|آخر موعد|מועד אחרון/i, 'deadline'],
];

const WEEKDAY_WORDS: readonly (readonly [RegExp, number])[] = [
  [/sunday|الأحد|ראשון/i, 0],
  [/monday|الإثنين|שני/i, 1],
  [/tuesday|الثلاثاء|שלישי/i, 2],
  [/wednesday|الأربعاء|רביעי/i, 3],
  [/thursday|الخميس|חמישי/i, 4],
  [/friday|الجمعة|שישי/i, 5],
  [/saturday|السبت|שבת/i, 6],
];

function kindOf(line: string): string {
  return KIND_WORDS.find(([pattern]) => pattern.test(line))?.[1] ?? 'other';
}

function weekdayOf(line: string): number | null {
  return WEEKDAY_WORDS.find(([pattern]) => pattern.test(line))?.[1] ?? null;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Everything the stub read off a document, as the model's answer would be. */
export function answerFor(lines: readonly { text: string; page: number }[], modelYear: number) {
  const items: unknown[] = [];
  const recurringSessions: unknown[] = [];
  let termYearHint: number | null = null;

  for (const { text, page } of lines) {
    const term = TERM_YEAR.exec(text);
    if (term) {
      termYearHint ??= Number(term[1]);
      continue;
    }
    const slot = SLOT.exec(text);
    const weekday = weekdayOf(text);
    if (slot && weekday !== null) {
      recurringSessions.push({
        weekday,
        start: `${slot[1]}:${slot[2]}`,
        end: `${slot[3]}:${slot[4]}`,
        label: text.split(/[::]/)[0]!.trim(),
      });
      continue;
    }
    const date = DATE.exec(text);
    if (!date) {
      // A line with no date in it. A syllabus's hidden instruction is one of
      // these, and it comes back as an item with a blank date exactly as an
      // ordinary sentence would — which is what makes the guard's job real.
      if (/system\s*:|ignore (?:previous|all)/i.test(text)) {
        items.push({ title: text, kind: 'other', dueAt: null, dateText: text, page, confidence: 0.9 });
      }
      continue;
    }
    const day = Number(date[1]);
    const month = Number(date[2]);
    const hour = date[3] === undefined ? '00' : pad(Number(date[3]));
    const minute = date[4] ?? '00';
    items.push({
      title: text.replace(date[0], '').replace(/\s+/g, ' ').trim(),
      kind: kindOf(text),
      // The year a model would guess, which is usually wrong. See the header.
      dueAt: `${modelYear}-${pad(month)}-${pad(day)}T${hour}:${minute}:00`,
      dateText: date[0],
      page,
      // High enough to be ticked by default, except the two the fixtures make
      // uncertain on purpose — see `lowConfidenceFor`.
      confidence: 0.85,
    });
  }

  return {
    documentTitle: lines[0]?.text ?? null,
    courseName: lines[0]?.text ?? null,
    termYearHint,
    items,
    recurringSessions,
    transcriptSample: lines.map((line) => line.text).join('\n').slice(0, TRANSCRIPT_SAMPLE_CHARACTERS),
  };
}

function linesOf(parts: readonly LlmPart[]): { text: string; page: number }[] {
  const lines: { text: string; page: number }[] = [];
  for (const part of parts) {
    if (part.kind === 'inlineData') {
      lines.push(...printedLinesIn(part.data));
    } else {
      const body = untrustedContentOf(part.text);
      for (const line of body.split('\n')) {
        const text = line.trim();
        if (text !== '') lines.push({ text, page: 1 });
      }
    }
  }
  return lines;
}

/**
 * A generator that answers out of the document it was given.
 *
 * `override` replaces the answer entirely, for the cases that are about what
 * the channel does with an answer it should not believe — fifty items, a
 * session at 25:00, a title that is a whole page. `promptTokens` is a function
 * of the call so a test can make a document expensive and watch the cap discard
 * the result.
 */
export function documentModelStub(options: {
  override?: (seen: readonly { text: string; page: number }[]) => unknown;
  fail?: Error | ((call: number) => Error | null);
  promptTokens?: number | ((call: number) => number);
  /** The year the "model" stamps on every yearless date. */
  modelYear?: number;
} = {}): DocumentModelStub {
  const calls: DocumentStubCall[] = [];
  const generate: ShareStructuredGenerator = async (request) => {
    const seen = linesOf(request.parts);
    calls.push({
      system: request.system,
      text: request.parts.map((part) => (part.kind === 'text' ? part.text : '')).join('\n'),
      seen: seen.map((line) => line.text),
      mediaTypes: request.parts.flatMap((part) => (part.kind === 'inlineData' ? [part.mediaType] : [])),
      inlineBytes: request.parts.reduce(
        (sum, part) => sum + (part.kind === 'inlineData' ? part.data.byteLength : 0),
        0,
      ),
      maxOutputTokens: request.maxOutputTokens,
    });
    const index = calls.length;
    const failure = typeof options.fail === 'function' ? options.fail(index) : options.fail;
    if (failure) throw failure;

    const answer = options.override ? options.override(seen) : answerFor(seen, options.modelYear ?? 2026);
    const tokens = typeof options.promptTokens === 'function'
      ? options.promptTokens(index)
      : options.promptTokens ?? 4_000;
    return {
      text: JSON.stringify(answer),
      model: 'stub-document',
      latencyMs: 5,
      promptTokens: tokens,
      outputTokens: 120,
    };
  };
  return { generate, calls };
}
