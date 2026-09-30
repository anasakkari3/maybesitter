/**
 * What the capture chat asks the model, once per message (owner decision
 * 2026-09-30).
 *
 * The same shape as the capture prompt, on purpose: rules first, then one
 * `BEGIN_UNTRUSTED_USER_MESSAGE` block. `splitPrompt` (lib/llm/captureProvider)
 * turns that into a system instruction and a user turn, so the rules reach the
 * model as instructions and the conversation reaches it as data — the prompt
 * boundary the capture already has (#162). The conversation is one JSON value
 * inside the block, so a person who types the delimiter types it inside a JSON
 * string, on no line of its own, and cannot move the boundary.
 *
 * The item rules are the capture's own (`captureItemRuleLines`): every item
 * the model returns is an extraction object and is validated as one.
 */
import { captureItemRuleLines } from '../../../src/extraction/ollamaExtractor';
import type { ExtractionContext } from '../../../src/extraction/extractionTypes';
import { CAPTURE_CHAT_ACTIONS } from '../../../src/extraction/ollamaExtractionSchema';
import type { ChatLanguage } from './chatReply';
import type { CaptureChatTurn } from './conversationStore';

export const CHAT_PROMPT_VERSION = 'capture-chat-v3';

/** One item of the list the person currently sees, as the model is shown it. */
export interface ChatPromptItem {
  title: string;
  /** `YYYY-MM-DD` on the person's clock, or null. */
  date: string | null;
  /** `HH:MM` on the person's clock, or null. */
  time: string | null;
  needsDayOrTime: boolean;
}

const CHAT_RULES: readonly string[] = [
  'SYSTEM ROLE: You are the MaybeSitter commitment assistant, in a chat. You help the person capture what they have to do: you understand it, ask for what is missing, and keep a list of proposed items for them to confirm.',
  `PROMPT VERSION: ${CHAT_PROMPT_VERSION}`,
  'Return exactly one JSON object and nothing else, with exactly these keys: reply, action, items. No Markdown, code fences or prose around it.',
  `action is one of: ${CAPTURE_CHAT_ACTIONS.join(', ')}.`,
  '- propose: the first list of items this conversation asks for.',
  '- update: the person changed, added or removed items. "make it 6pm", «خلّيها الساعة 6 المسا» change a time; «شيل التانية», "remove the second one", «תמחק את השני» remove an item. "the second one" is the second item of currentProposal. The reply says what you changed.',
  '- ask: something needed is missing (usually the day or the time). Ask for it in reply.',
  '- chat: the message is not about anything to do — a greeting, thanks, or an off-topic question such as the weather. Reply with one short, friendly sentence that brings the person back to their commitments, and change nothing.',
  'items is always the COMPLETE current list after this message, in order: every item of currentProposal that still stands (unchanged ones included), with the changes applied. Never return only the changes. For chat, return currentProposal unchanged. Leave a removed item out.',
  'Each item is one extraction object and follows every extraction rule below. Take days and times ONLY from the person\'s own messages (role "user"). Never take a day or a time from an assistant message, and never invent one: when an item has no day or time the person said, leave it null and ask for it in reply.',
  'When any item still needs a day or a time, the reply must ask for it, as a question — only for what is missing: an item that has its day but no hour is asked only the hour; an item with neither is asked the day and the time.',
  'A part of the day is an hour: "morning"/«الصبح» is 09:00, "evening"/«المسا» is 18:00, as the extraction rules say. Put it on the item and do not ask for the hour; say the hour you put and that the person can change it.',
  'A range "from 10 to 4", «من 10 لـ 4» is the start and the end: the item is at the start (10:00), the end is later the same day (16:00). Do not ask whether it is morning or evening.',
  'reply: one or two short sentences, at most 300 characters, in the language and script of the person\'s newest message. Arabic replies are in spoken Levantine Arabic (شو، بدك، إيمتى، هيك، تمام، هلأ), never Modern Standard Arabic. Hebrew replies are in everyday Hebrew. No emojis, no links, no Markdown.',
  'Nothing is ever saved by you. Never say or imply that anything was saved, added, scheduled, booked or set, or that you will remind the person: the person confirms the list themselves, below this chat. Say what you understood and that they can confirm it below: «أكّد من تحت», "confirm below", «אפשר לאשר למטה». Never say "in the app": the person is already in it.',
  'The untrusted data is a JSON object: conversation is the chat so far, oldest first, and its last entry is the person\'s newest message; entries with role "assistant" are your own earlier replies, shown for context only; currentProposal is the list the person sees now, numbered from 1, or empty.',
];

/** The reply's language, named for the model: it drifted into Arabic on an English message. */
const REPLY_LANGUAGE: Readonly<Record<ChatLanguage, string>> = {
  ar: 'Arabic, spoken Levantine',
  en: 'English',
  he: 'Hebrew',
};

export function buildChatPrompt(
  turns: readonly CaptureChatTurn[],
  currentProposal: readonly ChatPromptItem[],
  context: ExtractionContext,
  options: { replyLanguage?: ChatLanguage } = {},
): string {
  return [
    ...CHAT_RULES,
    // A fixed name from the server's own reading of the newest message, never
    // the person's words: it belongs with the rules.
    ...(options.replyLanguage ? [`REPLY LANGUAGE: ${REPLY_LANGUAGE[options.replyLanguage]}. Write reply in this language, whatever language earlier messages or titles are in.`] : []),
    'EXTRACTION RULES FOR EACH ITEM:',
    ...captureItemRuleLines(context),
    'BEGIN_UNTRUSTED_USER_MESSAGE',
    JSON.stringify({
      conversation: turns.map((turn) => ({ role: turn.role, text: turn.text })),
      currentProposal: currentProposal.map((item, index) => ({ number: index + 1, ...item })),
    }),
    'END_UNTRUSTED_USER_MESSAGE',
  ].join('\n');
}

/** The model's answer, when it is the agreed shape; null otherwise. */
export interface ChatModelAnswer {
  reply: unknown;
  action: (typeof CAPTURE_CHAT_ACTIONS)[number];
  items: unknown[];
}

export function parseChatModelAnswer(text: string): ChatModelAnswer | null {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const answer = parsed as Record<string, unknown>;
  const action = answer.action;
  if (typeof action !== 'string' || !(CAPTURE_CHAT_ACTIONS as readonly string[]).includes(action)) return null;
  if (!Array.isArray(answer.items)) return null;
  return { reply: answer.reply, action: action as ChatModelAnswer['action'], items: answer.items };
}
