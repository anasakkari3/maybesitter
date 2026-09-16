/**
 * Asking a model which messages in a chat are worth the user's attention
 * (UC-3.5, #189).
 *
 * ── The model chooses; it never writes ───────────────────────────
 *
 * The only thing this asks for is a list of **indices**. Not titles, not times,
 * not a rewritten sentence — indices into a list the channel built and still
 * holds.
 *
 * That is the whole safety argument for this channel. Whatever comes back is
 * used to *select* from text the parser produced, so a model that hallucinates
 * a commitment can at worst point at a message that exists, and the text that
 * reaches the extractor — and the excerpt that reaches the user's screen as
 * "this is where it came from" — is always a line somebody really wrote. A
 * schema with a `title` in it would make the evidence bubble capable of
 * disagreeing with the message beside it.
 *
 * It is also why the untrusted content and the instructions cannot be confused:
 * the instructions ask for numbers, so the most successful possible injection
 * inside the chat yields a number.
 *
 * ── Why a model at all ───────────────────────────────────────────
 *
 * A year of a group chat is two thousand messages of which three are a
 * commitment. Handing all of them to the capture pipeline would be two thousand
 * extractions and two thousand proposals; a regex for "sounds like a request"
 * is the pre-chewing `plainText.ts`'s header warns four lanes off. Choosing
 * which few messages matter is the judgement a model is actually good at, and
 * the channel falls back to the recent ones when there is no model to ask.
 */
import { toVertexSchema } from '../../../../src/extraction/llm/vertexSchema';
import { SHARE_SYSTEM_PREAMBLE, wrapUntrustedShared } from '../shareTypes';
import type { LlmPart } from '../shareTypes';
import type { WhatsAppMessage } from '../whatsappParser';

/** The shape the model must answer in. Indices and nothing else. */
export const WHATSAPP_SELECTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    commitments: {
      type: 'array',
      description: 'The indices of messages that state something the person must do. Empty when there are none.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: {
            type: 'integer',
            minimum: 0,
            description: 'The index shown in front of the message.',
          },
        },
        required: ['index'],
      },
    },
  },
  required: ['commitments'],
} as const;

export const WHATSAPP_SELECTION_SCHEMA = toVertexSchema(WHATSAPP_SELECTION_JSON_SCHEMA);

/**
 * The instruction, built around the shared preamble.
 *
 * `now` is a wall clock in the user's zone rather than an instant, because the
 * message timestamps beside it are wall clocks too — the export does not say
 * which zone it was written in, so comparing two strings from the same
 * rendering is the only comparison that means anything. See `whatsappParser.ts`.
 */
export function whatsappSystemPrompt(now: string, timezone: string): string {
  return [
    SHARE_SYSTEM_PREAMBLE,
    `The content is a chat transcript. Each line is one message, numbered, as "12 | 2026-09-15 20:45 | Dana | text".`,
    `It is now ${now} in ${timezone}. The message timestamps are the wall clock of the device the chat was exported from.`,
    'Return the indices of the messages that state something the person reading this still has to do: a commitment they made, a request addressed to them, an appointment they agreed to.',
    'Do not return a message that only reports what already happened, only asks a question, or only makes small talk.',
    'Do not return a message whose time has already passed.',
    'Return an empty list when there is nothing left to do. An empty list is a correct answer and is expected for an ordinary conversation.',
    'Return indices only. Never write a title, a time or any other text.',
  ].join(' ');
}

/** The most messages one call puts in front of the model. */
export const MAX_PROMPTED_MESSAGES = 400;

/**
 * The transcript as the model sees it: one numbered line per message.
 *
 * `wrapUntrustedShared` rather than a bare text part, and the numbering is
 * outside the message text so a message that writes "0 |" at its own start
 * cannot claim to be another message's line — the model is told the format, and
 * every line it is shown really does begin with the index the channel assigned.
 */
export function whatsappParts(messages: readonly WhatsAppMessage[]): readonly LlmPart[] {
  const lines = messages.slice(0, MAX_PROMPTED_MESSAGES).map((message) => {
    const stamp = message.timestamp ?? '';
    const sender = (message.sender ?? '').replace(/[|\n]/g, ' ');
    return `${message.index} | ${stamp} | ${sender} | ${message.text.replace(/[|\n]/g, ' ')}`;
  });
  return [wrapUntrustedShared(lines.join('\n'))];
}

/**
 * The indices the model chose, as a set the channel can trust.
 *
 * Everything that is not a whole number pointing at a message this call
 * actually showed is dropped rather than repaired. The answer's only job is to
 * name messages, so a malformed one naming nothing is a model that found
 * nothing — which is a result this channel already has to handle, not an error
 * worth failing a share over.
 */
export function selectedIndices(answer: string, available: number): readonly number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch {
    return [];
  }
  const commitments = (parsed as { commitments?: unknown } | null)?.commitments;
  if (!Array.isArray(commitments)) return [];
  const chosen = new Set<number>();
  for (const entry of commitments) {
    const index = (entry as { index?: unknown } | null)?.index;
    if (typeof index !== 'number' || !Number.isInteger(index)) continue;
    if (index < 0 || index >= available) continue;
    chosen.add(index);
  }
  // Ascending, so the segments the channel builds are in the order the
  // conversation happened in rather than the order the model listed them.
  return Array.from(chosen).sort((left, right) => left - right);
}
