/**
 * A stand-in for the model, for the email channel's tests (UC-3.8, #192).
 *
 * ── Why it reads the prompt instead of returning a canned answer ──
 *
 * The obvious stub returns a fixed list of items. Every assertion built on one
 * is an assertion about the stub: "the thread fixture yields nothing from
 * quoted history" would pass because the canned answer happens not to mention
 * the thread, and would go on passing after the cleaner stopped removing it.
 *
 * So this reads the untrusted part it was handed and finds request-shaped
 * sentences in *that*. It can only return what the channel showed it. Every
 * criterion about something the cleaner removed — quoted replies, signatures,
 * disclaimers, addresses, phone numbers — therefore fails here the moment the
 * removal stops happening, which is the only way those tests are worth running.
 *
 * It is deliberately naive about which sentences are requests. It is not a
 * model and it is not a specification of one; it is a reader that can only see
 * what it was given, which is the single property the tests rely on.
 */
import {
  BEGIN_UNTRUSTED_SHARED_CONTENT,
  END_UNTRUSTED_SHARED_CONTENT,
  type ShareStructuredGenerator,
} from '../../lib/services/share/shareTypes.ts';

export interface StubCall {
  readonly system: string;
  /** Every text part, joined. What the model could read. */
  readonly text: string;
  readonly responseSchema: object;
  readonly maxOutputTokens: number | undefined;
}

export interface EmailModelStub {
  readonly generate: ShareStructuredGenerator;
  readonly calls: StubCall[];
}

/** Something is being asked of the reader. */
const REQUEST =
  /\b(?:please|must|need to|needs to|due|return|bring|send|pay|submit|sign|registration|register|transfer|book|renew)\b|لازم|يرجى|الرجاء|رجاءً|ترجّع|ادفع|احضر|צריך|נא |יש ל|להעביר|לשלם|להביא/i;

/** The words that name a day, so the stub quotes them rather than inventing a date. */
const DAY_PHRASE =
  /(?:\b(?:by|before|on|this|next)\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b|\b(?:today|tonight|tomorrow)\b|(?:قبل|يوم|بعد)\s+(?:الأحد|الاحد|الإثنين|الاثنين|الثلاثاء|الأربعاء|الاربعاء|الخميس|الجمعة|السبت)|بكرا|بكرة|اليوم|עד\s+יום\s+(?:ראשון|שני|שלישי|רביעי|חמישי|שישי)|מחר|היום)/i;

/** The one text part a channel is expected to hand over, unwrapped. */
export function untrustedContentOf(text: string): string {
  const begin = text.indexOf(BEGIN_UNTRUSTED_SHARED_CONTENT);
  const end = text.lastIndexOf(END_UNTRUSTED_SHARED_CONTENT);
  if (begin < 0 || end < 0) return '';
  return text.slice(begin + BEGIN_UNTRUSTED_SHARED_CONTENT.length, end).trim();
}

/** Sentences, roughly: a full stop, an Arabic comma, or a line break ends one. */
function sentencesOf(body: string): string[] {
  return body
    .split(/(?<=[.!?؟])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '');
}

function titleOf(sentence: string, phrase: string | null): string {
  const withoutDay = phrase === null ? sentence : sentence.replace(phrase, ' ');
  return withoutDay.replace(/[.!?؟]+$/, '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ');
}

/**
 * A generator that answers from the content it was given.
 *
 * `override` replaces the items entirely, for the cases that are about what the
 * channel does with an answer it should not believe — an invented evidence
 * sentence, a title full of links, ten items when eight is the cap.
 */
export function emailModelStub(options: {
  override?: (content: string) => unknown;
  fail?: Error;
} = {}): EmailModelStub {
  const calls: StubCall[] = [];
  const generate: ShareStructuredGenerator = async (request) => {
    const text = request.parts
      .map((part) => (part.kind === 'text' ? part.text : `[${part.mediaType}]`))
      .join('\n');
    calls.push({
      system: request.system,
      text,
      responseSchema: request.responseSchema,
      maxOutputTokens: request.maxOutputTokens,
    });
    if (options.fail) throw options.fail;

    const content = untrustedContentOf(text);
    const answer = options.override
      ? options.override(content)
      : {
        items: sentencesOf(content)
          .filter((sentence) => REQUEST.test(sentence))
          .map((sentence) => {
            const phrase = DAY_PHRASE.exec(sentence)?.[0] ?? null;
            return { title: titleOf(sentence, phrase), evidenceSentence: sentence, dueDayPhrase: phrase };
          }),
      };
    return {
      text: JSON.stringify(answer),
      model: 'stub-email',
      latencyMs: 1,
      promptTokens: 10,
      outputTokens: 5,
    };
  };
  return { generate, calls };
}
