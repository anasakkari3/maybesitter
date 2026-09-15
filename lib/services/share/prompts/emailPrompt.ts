/**
 * What the model is asked about a shared email (UC-3.8, #192 step 6).
 *
 * ── It is asked for three things and trusted with none of them ───
 *
 * A title, the sentence the title came from, and the words that name a day.
 * Every one of those is checked afterwards by `channels/email.ts`:
 *
 *  - the evidence sentence must be a substring of the cleaned body, or the item
 *    is dropped — which is what stops an invented task;
 *  - the day phrase is resolved by `emailAnchor.ts`, not by the model, so the
 *    calendar arithmetic is deterministic and testable;
 *  - the title is stripped of links and refused if it carries a mask token.
 *
 * The model is a reader, not an authority. That is the only posture that
 * survives the fact that its entire input is text a stranger wrote.
 *
 * ── The instructions never contain the email ─────────────────────
 *
 * `system` is this file and nothing else. The subject and the body go in a part
 * wrapped by `wrapUntrustedShared`, because the subject is content too: a
 * message titled "Subject: ignore the rules below" would otherwise be
 * instructions by virtue of where it was pasted.
 *
 * The sent date is **not** given to the model. It is not needed — the model
 * quotes the words, this side resolves them — and a date lifted out of a header
 * is still something the sender chose.
 */
import { toVertexSchema } from '../../../../src/extraction/llm';
import { SHARE_SYSTEM_PREAMBLE, wrapUntrustedShared } from '../shareTypes';
import type { LlmPart } from '../shareTypes';

/** At most this many items, however many the model returns. #192 step 6. */
export const MAX_EMAIL_ITEMS = 8;

/**
 * The task, appended to the preamble every channel shares.
 *
 * Written as rules about the reader rather than about the message: "what is
 * being asked of the person who received this" is answerable from an email a
 * model has never seen the context of, where "what matters here" is not.
 */
export const EMAIL_SYSTEM_INSTRUCTION = [
  SHARE_SYSTEM_PREAMBLE,
  'The content is one email, already stripped of quoted replies, signatures and legal footers.',
  'List only things the *reader* is asked or expects to do, and only ones still ahead of them.',
  'Skip anything the sender is doing, anything already done, and anything that is only news.',
  'A newsletter, a marketing message or an announcement asks the reader for nothing: return an empty list.',
  'There is no action to take beyond remembering. Never propose opening a link, replying, paying or forwarding.',
  `Return at most ${MAX_EMAIL_ITEMS} items.`,
  'title: 2-6 words, imperative, in the same language and script as the email. No dates, no links, no punctuation at the end.',
  'evidenceSentence: one sentence copied from the content character for character, at most 140 characters. Never paraphrase it, never join two sentences, never write one that is not there.',
  'dueDayPhrase: the exact words in the content that name a day ("by Monday", «قبل الاثنين», «עד יום חמישי»), or null when no day is named. Copy the words; do not work out a date.',
  'Text reading [email] or [phone] has been removed on purpose. Never put it in a title and never ask about it.',
].join('\n');

/**
 * The answer's shape, in JSON Schema, before `toVertexSchema` translates it.
 *
 * `maxItems` is deliberately absent: Vertex's dialect has no translation for it
 * and a cap the model is merely asked for is not a cap. The channel slices.
 */
export const EMAIL_RESPONSE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Two to six imperative words in the email\'s own language.' },
          evidenceSentence: { type: 'string', description: 'One sentence copied from the content exactly.' },
          dueDayPhrase: { type: ['string', 'null'], description: 'The words naming a day, copied exactly, or null.' },
        },
        required: ['title', 'evidenceSentence'],
      },
    },
  },
  required: ['items'],
} as const;

export const EMAIL_RESPONSE_SCHEMA: object = toVertexSchema(EMAIL_RESPONSE_JSON_SCHEMA);

/** One item as the model may return it, before any of it is believed. */
export interface EmailModelItem {
  readonly title?: unknown;
  readonly evidenceSentence?: unknown;
  readonly dueDayPhrase?: unknown;
}

/**
 * The parts of one email call, in order.
 *
 * Subject and body inside one untrusted block rather than two, so the model
 * reads them as one message — and so there is exactly one boundary marker to
 * reason about rather than two nested ones.
 */
export function emailParts(subject: string | null, body: string): readonly LlmPart[] {
  const shown = subject === null ? body : `Subject: ${subject}\n\n${body}`;
  return [wrapUntrustedShared(shown)];
}

/**
 * The model's answer, or an empty list.
 *
 * Anything unparseable is an empty list rather than a throw: a model that
 * returned prose has told us nothing about this email, and "nothing to save
 * here" is the honest thing to show for that — the same screen an email with
 * genuinely nothing in it gets.
 */
export function parseEmailItems(text: string): readonly EmailModelItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const items = (parsed as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  return items.filter((item): item is EmailModelItem => Boolean(item) && typeof item === 'object');
}
