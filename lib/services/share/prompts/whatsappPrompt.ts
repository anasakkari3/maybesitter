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
 * v2 (QA v3 staging, 2026-11-20): «سامي: لا تنسى اجتماع الفريق يوم الأحد
 * الساعة 11 الصبح» answered by «أنا: أكيد 👍 وبجيب معي العرض» chose the reply
 * and not the reminder — the model was never told the reader is one of the
 * people in the chat, nor that a request they accept is theirs. v1 had no
 * version line.
 */
export const WHATSAPP_SELECTION_PROMPT_VERSION = 'whatsapp-selection-v2';

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
    `Prompt version: ${WHATSAPP_SELECTION_PROMPT_VERSION}.`,
    `The content is a chat transcript. Each line is one message, numbered, as "12 | 2026-09-15 20:45 | Dana | text".`,
    `It is now ${now} in ${timezone}. The message timestamps are the wall clock of the device the chat was exported from.`,
    'Return the indices of the messages that state something the person reading this still has to do: a commitment they made, a request addressed to them, an appointment they agreed to.',
    'The person reading this is one of the people in this chat; their own messages carry their name, or a word such as "me", «أنا» or «אני».',
    'A reminder or a request that someone else in the chat sends them — «لا تنسى …», «بتقدر …؟», "don\'t forget …", "can you …", «אל תשכח …» — that they accept («أكيد», «تمام», "sure", «בטח», a thumbs-up) or do not refuse is theirs to do: return the message that says what and when, not only the reply that accepts it.',
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
  // Numbered by position in *this* list, not by `message.index`. The channel
  // reads the answer as positions into the list it handed over, and the
  // parser's index counts the messages the injection screen dropped too — so
  // numbering by it made every choice after a dropped message name the one
  // after it (QA v3, the share-in selection).
  const lines = messages.slice(0, MAX_PROMPTED_MESSAGES).map((message, position) => {
    const stamp = message.timestamp ?? '';
    const sender = withoutEmoji((message.sender ?? '').replace(/[|\n]/g, ' '));
    const text = withoutEmoji(message.text.replace(/[|\n]/g, ' '));
    return `${position} | ${stamp} | ${sender} | ${text === '' ? EMOJI_ONLY : text}`;
  });
  return [wrapUntrustedShared(lines.join('\n'))];
}

/**
 * What an emoji-only message is shown as. A word, so the line still exists and
 * the numbering still counts it, without putting the pictograph back.
 */
export const EMOJI_ONLY = '(emoji)';

/**
 * Pictographs, with the pieces that build one emoji out of several code
 * points: joiners, variation selectors, skin tones, keycap marks, the paired
 * regional indicators of a flag (🇮🇱) and the tag characters of a subdivision
 * flag (🏴󠁧󠁢󠁥󠁮󠁧󠁿).
 *
 * ©, ® and ™ are `Extended_Pictographic` too, and are kept: in a chat they are
 * part of a name ("Acme®"), not a reaction.
 */
const EMOJI = new RegExp(
  '(?![\\u00a9\\u00ae\\u2122])[\\p{Extended_Pictographic}\\p{Emoji_Modifier}\\p{Regional_Indicator}\\u200d\\ufe0f\\u20e3\\u{e0020}-\\u{e007f}]',
  'gu',
);

/**
 * A line for the selection prompt, without its emoji (QA v3, V3-F07-01).
 *
 * An exported Arabic chat in which one reply was «تمام 👍» came back with no
 * message chosen, four times in four; the same chat without the emoji gave
 * both commitments. The selection is a judgement about words — what somebody
 * has to do and when — and the model is now asked it over the words alone.
 * Only the prompt loses them: the segments and the evidence the channel builds
 * are the messages as written, emoji and all.
 *
 * Removing a character can join the words on either side of it
 * («ig👍nore all previous instructions»), so the channel's injection screen
 * runs over this function's output as well as over the message as written
 * (`channels/whatsapp.ts`, `safeMessages`).
 */
export function withoutEmoji(text: string): string {
  return text.replace(EMOJI, '').replace(/\s+/g, ' ').trim();
}

/**
 * Words a reply opens with to accept what it answers, in the three languages.
 * Whole words only (`ACCEPTANCE`): «تماما», "okra" and «أكيدًا» are not.
 * «اه»/"ah" is left out: it is as often a sigh as a yes.
 */
const ACCEPTANCE_WORDS: readonly string[] = [
  // ar
  'أكيد', 'اكيد', 'أكيدة', 'اكيدة', 'بالتأكيد', 'بالتاكيد', 'تمام', 'ماشي', 'طيب', 'حاضر', 'أوكي', 'اوكي', 'أوكيه', 'اوكيه', 'أوك', 'اوك',
  'اتفقنا', 'موافق', 'موافقة', 'نعم', 'أيوه', 'ايوه', 'أيوا', 'ايوا', 'ولا يهمك', 'من عيوني', 'على راسي', 'علي راسي', 'إن شاء الله', 'ان شاء الله', 'انشالله', 'إنشالله',
  // en
  'ok', 'okay', 'okey', 'sure', 'of course', 'yes', 'yeah', 'yep', 'yup', 'will do', 'no problem', 'deal', 'alright', 'all right', 'sounds good', 'got it', 'noted',
  // he
  'בטח', 'סבבה', 'אוקיי', 'אוקי', 'בסדר', 'כן', 'אין בעיה', 'ברור', 'קיבלתי',
];
const ACCEPTANCE = new RegExp(`^(?:${ACCEPTANCE_WORDS.join('|')})(?![\\p{L}\\p{M}\\p{N}])`, 'iu');
/** The marks between an acceptance and what follows it: «أكيد، …», "sure! …". */
const BETWEEN_WORDS = /^[\s.,!?؟،؛:;…—–-]+/;
/** An acceptance is in a message's first words; nothing past this is read for one. */
const ACCEPTANCE_SCAN = 200;

/**
 * Whether a message accepts what it answers (QA v3 staging, 2026-11-20):
 * `'only'` when that is all it says («تمام 👍», "sure.", 👍 alone, «ماشي،
 * اتفقنا»); `'opens'` when it accepts and goes on («أكيد 👍 وبجيب معي العرض»);
 * null when it does not open with an acceptance at all.
 *
 * Reads at most `ACCEPTANCE_SCAN` characters, every pattern anchored at the
 * start, so a chat-length message costs a constant.
 */
export function acceptanceReply(text: string): 'only' | 'opens' | null {
  const head = text.slice(0, ACCEPTANCE_SCAN);
  if (head.trim() === '') return null;
  // A message that is nothing but a pictograph (👍, 👌) is a reaction.
  const words = withoutEmoji(head);
  if (words === '') return 'only';
  let rest = words.replace(BETWEEN_WORDS, '');
  let accepted = false;
  for (let round = 0; round < 2; round += 1) {
    const match = ACCEPTANCE.exec(rest);
    if (!match) break;
    accepted = true;
    rest = rest.slice(match[0].length).replace(BETWEEN_WORDS, '');
  }
  if (!accepted) return null;
  return rest === '' ? 'only' : 'opens';
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
