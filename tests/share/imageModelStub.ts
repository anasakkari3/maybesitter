/**
 * A stand-in for the model, for the image channel's tests (UC-3.6, #190).
 *
 * ── Why it reads the bytes instead of returning a canned answer ───
 *
 * The same argument as `emailModelStub.ts`, and it matters more here. The
 * obvious stub returns a fixed list of items; every privacy assertion built on
 * one is an assertion about the stub. "No EXIF reached the model" would pass
 * because the canned answer happens not to mention the GPS coordinates, and
 * would go on passing after the stripping stopped happening.
 *
 * So this decodes the inline parts it was handed and finds request-shaped lines
 * in *them*. It can only answer out of what it was shown. Every criterion about
 * something `imageMetadata.ts` removed therefore fails here the moment the
 * removal stops: the fixtures hide a prompt injection in their EXIF, this stub
 * would happily read it, and the suite goes red on an item nobody wanted rather
 * than on a byte comparison nobody can read.
 *
 * It is deliberately naive about which lines are requests, and it is not a
 * specification of a model. It is a reader that can only see what it was given,
 * which is the single property the tests rely on.
 */
import {
  BEGIN_UNTRUSTED_SHARED_CONTENT,
  END_UNTRUSTED_SHARED_CONTENT,
  type LlmPart,
  type ShareStructuredGenerator,
} from '../../lib/services/share/shareTypes.ts';

export interface StubCall {
  readonly system: string;
  /** Every text part, joined. The caption, when one was sent. */
  readonly text: string;
  /** Every line this call could read out of the pictures it was handed. */
  readonly seen: readonly string[];
  readonly mediaTypes: readonly string[];
  readonly inlineBytes: number;
  readonly maxOutputTokens: number | undefined;
}

export interface ImageModelStub {
  readonly generate: ShareStructuredGenerator;
  readonly calls: StubCall[];
}

/** Something is being asked of the reader. */
const REQUEST =
  /\b(?:please|must|need to|needs to|due|return|bring|send|pay|submit|register|registration|transfer|renew|borrow|borrowed)\b|لازم|يرجى|الرجاء|ترجّع|ترجع|تحجز|احضر|ادفع|צריך|נא |יש ל|להעביר|לשלם|להביא/i;

/** The words that name a day, so the stub quotes them rather than inventing a date. */
const DAY_PHRASE =
  /(?:\b(?:by|before|on|this|next)\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b|\b(?:today|tonight|tomorrow)\b|(?:قبل|يوم|بعد)\s+(?:الأحد|الاحد|الإثنين|الاثنين|الثلاثاء|الأربعاء|الاربعاء|الخميس|الجمعة|السبت)|بكرا|بكرة|اليوم|עד\s+יום\s+(?:ראשון|שני|שלישי|רביעי|חמישי|שישי)|מחר|היום)/i;

/**
 * Every run of readable text in a picture's bytes.
 *
 * A model reads the words in a picture; this reads the words in the file, which
 * for these fixtures is the same set — *as long as nothing removed them*. That
 * equivalence is the point: the poster's words live where the container keeps
 * them and the hidden ones live where it does not, so what this can see is
 * exactly what the strip left behind.
 *
 * Non-fatal decoding on purpose. A container's own header bytes are not UTF-8
 * and come back as replacement characters, which split the runs apart the same
 * way a control byte does.
 */
export function readableLinesIn(bytes: Uint8Array): string[] {
  const decoded = new TextDecoder('utf-8').decode(bytes);
  return decoded
    .split(/[\u0000-\u001f\u007f\ufffd]+/)
    .map((run) => run.trim())
    .filter((run) => run.length >= 4);
}

/** The one text part a channel wrapped, unwrapped. '' when there was none. */
export function untrustedContentOf(text: string): string {
  const begin = text.indexOf(BEGIN_UNTRUSTED_SHARED_CONTENT);
  const end = text.lastIndexOf(END_UNTRUSTED_SHARED_CONTENT);
  if (begin < 0 || end < 0) return '';
  return text.slice(begin + BEGIN_UNTRUSTED_SHARED_CONTENT.length, end).trim();
}

function titleOf(line: string, phrase: string | null): string {
  const withoutDay = phrase === null ? line : line.replace(phrase, ' ');
  return withoutDay.replace(/[.!?؟]+$/, '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ');
}

function linesOf(parts: readonly LlmPart[]): string[] {
  const lines: string[] = [];
  for (const part of parts) {
    if (part.kind === 'inlineData') lines.push(...readableLinesIn(part.data));
    else lines.push(...untrustedContentOf(part.text).split('\n').map((line) => line.trim()).filter(Boolean));
  }
  return lines;
}

/**
 * A generator that answers out of the pictures it was given.
 *
 * `override` replaces the items entirely, for the cases that are about what the
 * channel does with an answer it should not believe — an invented day, a title
 * that is a transcription, ten items when four is the cap. `promptTokens` is a
 * function of the call so a test can make a picture expensive and watch the
 * budget stop the next one.
 */
export function imageModelStub(options: {
  override?: (seen: readonly string[]) => unknown;
  fail?: Error | ((call: number) => Error | null);
  promptTokens?: number | ((call: number) => number);
} = {}): ImageModelStub {
  const calls: StubCall[] = [];
  const generate: ShareStructuredGenerator = async (request) => {
    const seen = linesOf(request.parts);
    calls.push({
      system: request.system,
      text: request.parts.map((part) => (part.kind === 'text' ? part.text : '')).join('\n'),
      seen,
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

    const answer = options.override
      ? options.override(seen)
      : {
        items: seen
          .filter((line) => REQUEST.test(line))
          .map((line) => {
            const phrase = DAY_PHRASE.exec(line)?.[0] ?? null;
            return { title: titleOf(line, phrase), evidenceLine: line, dueDayPhrase: phrase };
          }),
      };
    const tokens = typeof options.promptTokens === 'function'
      ? options.promptTokens(index)
      : options.promptTokens ?? 900;
    return {
      text: JSON.stringify(answer),
      model: 'stub-image',
      latencyMs: 3,
      promptTokens: tokens,
      outputTokens: 7,
    };
  };
  return { generate, calls };
}
