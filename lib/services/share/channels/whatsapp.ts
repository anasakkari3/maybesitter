/**
 * A shared WhatsApp conversation (UC-3.5, #189).
 *
 * Three shapes arrive, and they are the same chat:
 *
 *   text          a few messages selected in WhatsApp and shared as text
 *   textFile      Android's "Export chat · Without media" — one `.txt`
 *   chatArchive   iOS's export — a `.zip` holding `_chat.txt` and attachments
 *
 * All three end up as a list of messages, and the messages worth the user's
 * attention end up as blank-line-separated segments for the ordinary capture
 * pipeline. Nothing about confirm, clarify, edit or undo learns that a share
 * happened; that is the seam `shareTypes.ts` describes and this channel is one
 * file inside it.
 *
 * ── Four things this channel will not do ─────────────────────────
 *
 *  - **It will not let a phone number reach a model.** A group export names
 *    unsaved contacts by number, in the sender field and in the bodies both.
 *    `redactPhoneNumbers` runs inside the parser, before anything downstream
 *    exists, so there is no ordering here that could put it after the call.
 *  - **It will not open an attachment.** `readChatArchive` inflates entries
 *    whose name ends in `.txt` and nothing else, so there is no code path from
 *    here to a photo.
 *  - **It will not reject a chat because one message in it is an attack.** See
 *    below.
 *  - **It will not invent text.** The model returns indices; every character
 *    that leaves here was written by a person in the chat.
 *
 * ── Per message, not per share ───────────────────────────────────
 *
 * `screenForInjection` already exists and already guards every model call the
 * extractor makes — but it guards the *whole input*, and answers a safe
 * negative for all of it on one hit. That granularity is right for one typed
 * sentence and wrong for a year of conversation: somebody who pastes "ignore
 * previous instructions" into a family group at any point in 2026 would
 * otherwise make every share of that chat return nothing, forever, with no
 * explanation the user could act on.
 *
 * So the same boundary is applied per message here. One message fails and is
 * dropped and counted; the other forty-nine are read normally. The dropped one
 * is never put in front of a model, which is the property the whole-input guard
 * was protecting and the only one that was ever load-bearing.
 */
import { screenForInjection } from '../../../../src/extraction/injectionBoundary';
import { LLMUnavailableError } from '../../../../src/extraction/llm';
import { AiConsentRequiredError } from '../../../llm/consentGatedProvider';
import { readChatArchive } from '../chatArchive';
import { decodeUtf8 } from '../mediaType';
import { registerSharePreprocessor } from '../shareRegistry';
import { MAX_EVIDENCE_CHARACTERS, segmentsToResult } from '../shareTypes';
import type {
  SharePreprocessContext,
  SharePreprocessor,
  SharePreprocessorInput,
  SharePreprocessResult,
  ShareSegment,
} from '../shareTypes';
import {
  MAX_PROMPTED_MESSAGES,
  selectedIndices,
  WHATSAPP_SELECTION_SCHEMA,
  whatsappParts,
  whatsappSystemPrompt,
} from '../prompts/whatsappPrompt';
import { looksLikeWhatsAppExport, parseWhatsAppExport, type WhatsAppMessage } from '../whatsappParser';

/**
 * How many messages are kept when there is no model to ask.
 *
 * The user has not agreed to AI processing, or the provider is down. Rather
 * than fail the share or return nothing, the most recent messages go through
 * the rule-based path the capture pipeline already falls back to. Twenty is
 * four times the boundary's own `MAX_MODEL_SEGMENTS`, so nothing here is what
 * decides how many model calls the pipeline below makes.
 */
export const MAX_UNASSISTED_SEGMENTS = 20;

/** How long one selection call may take. Text only, so well under the default. */
const SELECTION_TIMEOUT_MS = 20_000;

/** A prefix long enough to recognise an export by, without decoding a megabyte. */
const PROBE_BYTES = 8 * 1024;

/** The first few kilobytes as text, for `matches` only. Never for content. */
function probe(bytes: Uint8Array): string {
  // Non-fatal on purpose, and only here: the slice can cut a character in half,
  // and the question being asked is "does this look like an export", which a
  // replacement character at the end does not change. Everything that becomes
  // content goes through `decodeUtf8`, which is fatal.
  return new TextDecoder('utf-8').decode(bytes.subarray(0, PROBE_BYTES));
}

/**
 * Whether this share is a WhatsApp conversation.
 *
 * Pure and non-throwing, as `shareRegistry.ts` requires. `sourceHint` is read
 * but never required: a user who re-shares an export out of Files sends exactly
 * the same bytes with no hint attached, and a channel that needed the hint
 * would work for the share sheet and fail for the file manager.
 */
function matchesWhatsApp(input: SharePreprocessorInput): boolean {
  // A zip is claimed outright. Nothing else registers for `chatArchive`, the
  // only archive this product expects is this one, and the alternative would be
  // unzipping inside a predicate that is documented as pure and synchronous.
  if (input.kind === 'chatArchive') return true;
  if (input.text !== null && looksLikeWhatsAppExport(input.text)) return true;
  return input.files.some((file) => file.mediaType === 'text/plain' && looksLikeWhatsAppExport(probe(file.bytes)));
}

interface Source {
  readonly raw: string;
  /** Index into `input.files`, or null when the chat came as shared text. */
  readonly sourceIndex: number | null;
  /** Attachments the archive listed and this never opened. */
  readonly mediaEntries: number;
}

/** The transcript, wherever in the share it was. */
function sourceOf(input: SharePreprocessorInput): Source {
  if (input.kind === 'chatArchive') {
    const index = input.files.findIndex((file) => file.mediaType === 'application/zip');
    // `kindFrom` in the service only produces `chatArchive` for exactly one
    // zip, so this cannot be -1 — but reading `files[-1]` if it ever were
    // would be a crash inside a `finally` that has bytes to zero.
    const archive = input.files[index === -1 ? 0 : index]!;
    const { text, mediaEntries } = readChatArchive(archive.bytes);
    return { raw: text, sourceIndex: index === -1 ? 0 : index, mediaEntries };
  }
  const fileIndex = input.files.findIndex(
    (file) => file.mediaType === 'text/plain' && looksLikeWhatsAppExport(probe(file.bytes)),
  );
  if (fileIndex !== -1) {
    const decoded = decodeUtf8(input.files[fileIndex]!.bytes);
    if (decoded !== null) return { raw: decoded, sourceIndex: fileIndex, mediaEntries: 0 };
  }
  return { raw: input.text ?? '', sourceIndex: null, mediaEntries: 0 };
}

/** `YYYY-MM-DD HH:MM` for an instant, in the share's own zone. */
function wallClock(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}`;
}

/** The messages a model may see: everything the injection boundary allowed. */
function safeMessages(messages: readonly WhatsAppMessage[]): {
  kept: readonly WhatsAppMessage[];
  dropped: number;
} {
  const kept: WhatsAppMessage[] = [];
  let dropped = 0;
  for (const message of messages) {
    // The sender too, not only the body. A display name is user-controlled and
    // is one of the few places a person can write a line that every export of
    // that chat will repeat.
    const surface = `${message.sender ?? ''}\n${message.text}`;
    if (screenForInjection(surface) !== null) {
      dropped += 1;
      continue;
    }
    kept.push(message);
  }
  return { kept, dropped };
}

/**
 * Which of the safe messages the user still has something to do about.
 *
 * Returns the indices *into `kept`*, not into the original export: the model is
 * shown `kept` and is never told the dropped ones existed, so its numbering and
 * this array's are the same numbering by construction.
 */
async function chooseMessages(
  kept: readonly WhatsAppMessage[],
  input: SharePreprocessorInput,
  context: SharePreprocessContext,
): Promise<{ chosen: readonly number[]; modelUsed: boolean }> {
  const shown = kept.slice(0, MAX_PROMPTED_MESSAGES);
  // Asked before the call rather than instead of it. `generateStructured`
  // refuses without consent anyway; asking first means a user who has not
  // agreed gets the unassisted read instead of a failed share.
  let consented = false;
  try {
    consented = (await context.readAiConsent()) === 'granted';
  } catch {
    consented = false;
  }
  if (!consented) return { chosen: recent(shown.length), modelUsed: false };

  try {
    const response = await context.generateStructured({
      system: whatsappSystemPrompt(wallClock(input.referenceTime, input.timezone), input.timezone),
      parts: whatsappParts(shown),
      responseSchema: WHATSAPP_SELECTION_SCHEMA,
      timeoutMs: SELECTION_TIMEOUT_MS,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    return { chosen: selectedIndices(response.text, shown.length), modelUsed: true };
  } catch (error) {
    // The one taxonomy this catches is "the model would not answer", which
    // `shareProvider.ts` promises is always an `LLMUnavailableError`, plus the
    // consent refusal that beats it to the gate. Anything else is a real defect
    // and is not something to degrade quietly over.
    if (!(error instanceof LLMUnavailableError) && !(error instanceof AiConsentRequiredError)) throw error;
    return { chosen: recent(shown.length), modelUsed: false };
  }
}

/** The last `MAX_UNASSISTED_SEGMENTS` indices of a list, oldest first. */
function recent(length: number): readonly number[] {
  const from = Math.max(0, length - MAX_UNASSISTED_SEGMENTS);
  return Array.from({ length: length - from }, (_, offset) => from + offset);
}

export const whatsappPreprocessor: SharePreprocessor = {
  id: 'whatsapp',
  kinds: ['chatArchive', 'textFile', 'text'],
  // Above `plain-text`'s 0. A transcript read as one blob of prose is a single
  // run-on commitment with the encryption notice on the front of it.
  priority: 10,
  matches: matchesWhatsApp,
  async preprocess(input, context): Promise<SharePreprocessResult> {
    const source = sourceOf(input);
    const transcript = parseWhatsAppExport(source.raw);
    const { kept, dropped } = safeMessages(transcript.messages);

    const metrics = {
      messagesParsed: transcript.messages.length,
      messagesKept: kept.length,
      systemLines: transcript.systemLines,
      mediaPlaceholders: transcript.mediaPlaceholders,
      /** Attachments inside the archive. Listed, counted, never inflated. */
      mediaEntries: source.mediaEntries,
      injectionsDropped: dropped,
    };
    const ignoredSegments = dropped + transcript.systemLines + transcript.mediaPlaceholders + source.mediaEntries;

    if (kept.length === 0) {
      // An empty read, not an error. `shareIntakeService` turns `''` into the
      // ordinary `no_commitment` proposal — the same screen a typed sentence
      // with nothing in it gets.
      return segmentsToResult([], { ignoredSegments, metrics: { ...metrics, modelUsed: 0 } });
    }

    const { chosen, modelUsed } = await chooseMessages(kept, input, context);
    const segments: ShareSegment[] = chosen.map((index) => {
      const message = kept[index]!;
      return {
        text: message.text,
        // The excerpt is the message, not a summary of it. It is what the
        // review screen shows beside a commitment as "this is where it came
        // from", so it has to be quotable back to the chat character for
        // character; the service truncates it either way.
        evidence: { sourceIndex: source.sourceIndex, excerpt: message.text.slice(0, MAX_EVIDENCE_CHARACTERS) },
      };
    });

    return segmentsToResult(segments, {
      ignoredSegments,
      metrics: { ...metrics, messagesChosen: segments.length, modelUsed: modelUsed ? 1 : 0 },
    });
  },
};

registerSharePreprocessor(whatsappPreprocessor);
