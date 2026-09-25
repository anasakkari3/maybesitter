/**
 * What another app handed us, turned into something this one can reason about
 * (UC-3.0, #183).
 *
 * ── A pure function on purpose ───────────────────────────────────
 *
 * Nothing here touches a native module, the network or the filesystem. It takes
 * the `ShareIntent` shape `expo-share-intent` produces and returns either a
 * payload or a reason for refusing one, so every client-side limit in #183 —
 * five images, 15 MB each, 10 MB of PDF, 1 MB of text file, 20 000 characters —
 * is arithmetic a test can check without a device.
 *
 * That matters because of the criterion it serves: *"oversized or disallowed
 * input is rejected on device (no network call)"*. "No network call" is a claim
 * about a decision made before one is started, and the decision is here.
 *
 * ── The type is imported, the module is not ──────────────────────
 *
 * `import type` only. This file must stay loadable in a plain Jest environment
 * with no native module present; `shareIntentBridge.tsx` is the one place the
 * runtime import lives.
 */
import type { ShareIntent, ShareIntentFile } from 'expo-share-intent';
import { looksLikeEmail } from './emailTextDetector';

/** The same six the server classifies into. */
export type SharedKind = 'text' | 'images' | 'pdf' | 'textFile' | 'chatArchive' | 'calendarFile';

export type ShareSourceHint = 'whatsapp' | 'email' | 'unknown';

export interface SharedFile {
  uri: string;
  mimeType: string;
  sizeBytes: number;
  fileName: string;
}

export interface SharedPayload {
  kind: SharedKind;
  /** The shared text, when there was any. */
  text?: string;
  files: SharedFile[];
  sourceHint: ShareSourceHint;
}

/**
 * Why a share is not going to be uploaded.
 *
 * A fixed vocabulary, mapped to one locale key each by the screen. Never a
 * sentence, and never the file's name.
 */
export type SharePayloadProblem =
  | 'empty'
  | 'too_many_files'
  | 'file_too_large'
  | 'text_too_long'
  | 'unsupported';

export type NormalizedShare =
  | { ok: true; payload: SharedPayload }
  | { ok: false; problem: SharePayloadProblem };

/* ── The client-side limits (#183 step 3) ─────────────────────────── */

export const MAX_TEXT_CHARACTERS = 20_000;
export const MAX_IMAGES = 5;
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_FILE_BYTES = 1024 * 1024;
export const MAX_ARCHIVE_BYTES = 15 * 1024 * 1024;

/**
 * Which extensions mean what, when the OS will not say.
 *
 * Android share sheets hand over `application/octet-stream` more often than
 * they hand over the truth, so the extension is the fallback. It is a *routing*
 * guess only: the server sniffs the bytes and refuses anything whose
 * declaration contradicts them, so the worst this can do is send something that
 * comes back a 415.
 */
const BY_EXTENSION: Readonly<Record<string, string>> = {
  txt: 'text/plain',
  md: 'text/plain',
  eml: 'message/rfc822',
  emlx: 'message/rfc822',
  csv: 'text/plain',
  pdf: 'application/pdf',
  zip: 'application/zip',
  ics: 'text/calendar',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  heic: 'image/heic',
  heif: 'image/heic',
  webp: 'image/webp',
};

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot < 0 ? '' : fileName.slice(dot + 1).toLowerCase();
}

/** The best available guess at a file's type, from the OS then the name. */
export function mimeTypeFor(file: { mimeType?: string | null; fileName?: string | null }): string {
  const declared = (file.mimeType ?? '').split(';')[0]!.trim().toLowerCase();
  if (declared !== '' && declared !== 'application/octet-stream' && declared !== '*/*') return declared;
  return BY_EXTENSION[extensionOf(file.fileName ?? '')] ?? 'application/octet-stream';
}

/** The spellings of a zip that Android file managers and Windows actually send. */
const ZIP_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/zip-compressed',
  'multipart/x-zip',
]);

/**
 * An email, and the two types a mail app declares one as.
 *
 * `.eml` is a UTF-8 text file with headers on the front. Without this branch it
 * falls through to `null` and is refused **on device**, which would leave #192
 * editing this file and `mediaType.ts` — outside the one-file promise made to
 * the four channel lanes.
 */
const EMAIL_TYPES = new Set(['message/rfc822', 'application/mbox']);

function kindFor(mimeType: string): SharedKind | null {
  if (mimeType.startsWith('image/')) return 'images';
  if (mimeType === 'application/pdf') return 'pdf';
  if (ZIP_TYPES.has(mimeType)) return 'chatArchive';
  if (mimeType === 'text/calendar') return 'calendarFile';
  if (EMAIL_TYPES.has(mimeType)) return 'textFile';
  if (mimeType.startsWith('text/')) return 'textFile';
  return null;
}

const LIMIT_FOR: Readonly<Record<SharedKind, number>> = {
  text: MAX_TEXT_CHARACTERS,
  images: MAX_IMAGE_BYTES,
  pdf: MAX_PDF_BYTES,
  textFile: MAX_TEXT_FILE_BYTES,
  chatArchive: MAX_ARCHIVE_BYTES,
  calendarFile: MAX_TEXT_FILE_BYTES,
};

/**
 * Where this probably came from.
 *
 * A hint the server ranks below its own sniffing. It is read off the file name,
 * which is the one moment a name is useful — and the name goes no further than
 * the multipart part it is attached to.
 */
export function sourceHintFor(files: readonly { fileName?: string | null }[], text: string | null): ShareSourceHint {
  const names = files.map((file) => (file.fileName ?? '').toLowerCase());
  if (names.some((name) => name.includes('whatsapp') || name.includes('_chat'))) return 'whatsapp';
  if (names.some((name) => name.endsWith('.eml') || name.endsWith('.emlx'))) return 'email';
  // WhatsApp's own "share text" carries its export header even without a file.
  // The digits are ASCII, Arabic-Indic or Persian and the separator after the
  // date is a comma or «،»: an Arabic-locale iPhone writes
  // «[١٢/٠٨/٢٠٢٦، ١٤:٠٣:١١]», and `\d` never sees it (#401). The server's
  // `whatsappParser` reads all three digit sets; this hint has to agree.
  if (text && /^\s*\[?[\d٠-٩۰-۹]{1,2}[./][\d٠-٩۰-۹]{1,2}[./][\d٠-٩۰-۹]{2,4}[,،\s]/.test(text)) return 'whatsapp';
  /*
   * A selection out of Gmail, Outlook or Apple Mail arrives as bare text with
   * no file and no name to read, so the *shape* is the only thing left to read
   * (UC-3.8, #192). `emailTextDetector.ts` is the same predicate the server
   * runs, held to the same written answers by
   * `__tests__/emailTextDetector.test.ts`, so this hint agrees with what the
   * server would have decided on its own.
   *
   * It stays a hint. The server ranks it below its own reading and re-runs the
   * detector itself, so a wrong answer here costs a tie-break and never a
   * refusal — which is the only reason it is safe to guess from shape at all.
   */
  if (text && looksLikeEmail(text)) return 'email';
  return 'unknown';
}

function fileFrom(file: ShareIntentFile): SharedFile {
  return {
    uri: file.path,
    mimeType: mimeTypeFor(file),
    // `size` is nullable on both platforms. Zero means "the OS would not say",
    // and an unknown size is allowed through: the server measures the bytes it
    // actually receives and is the authority on the limit.
    sizeBytes: file.size ?? 0,
    fileName: file.fileName,
  };
}

/**
 * The payload to upload, or the reason not to.
 *
 * ── A shared URL is text ─────────────────────────────────────────
 *
 * `webUrl` arrives as its own field. It is folded into the text rather than
 * given a kind of its own: a link is a sentence as far as the extractor is
 * concerned ("the invite is at …"), and a `url` kind would be a seventh thing
 * for four channels to have an opinion about for no benefit.
 */
export function normalizeShareIntent(intent: ShareIntent): NormalizedShare {
  const files = (intent.files ?? []).map(fileFrom);
  const rawText = [intent.text ?? '', intent.webUrl ?? ''].filter((part) => part.trim() !== '').join('\n').trim();
  const text = rawText === '' ? null : rawText;

  if (files.length === 0 && text === null) return { ok: false, problem: 'empty' };
  if (text !== null && text.length > MAX_TEXT_CHARACTERS) return { ok: false, problem: 'text_too_long' };

  const sourceHint = sourceHintFor(intent.files ?? [], text);

  if (files.length === 0) {
    return { ok: true, payload: { kind: 'text', text: text as string, files: [], sourceHint } };
  }

  const kinds = files.map((file) => kindFor(file.mimeType));
  if (kinds.some((kind) => kind === null)) return { ok: false, problem: 'unsupported' };
  const unique = new Set(kinds as SharedKind[]);
  // A mixture is refused here as well as on the server. Uploading it to be told
  // no would cost the user a share from their daily allowance and a round trip.
  if (unique.size > 1) return { ok: false, problem: 'unsupported' };
  const kind = (kinds as SharedKind[])[0]!;

  if (kind === 'images') {
    if (files.length > MAX_IMAGES) return { ok: false, problem: 'too_many_files' };
  } else if (files.length > 1) {
    // One PDF, one archive, one calendar at a time. Several would each need
    // their own read, and #183 puts multiple PDFs out of scope explicitly.
    return { ok: false, problem: 'too_many_files' };
  }

  const limit = LIMIT_FOR[kind];
  if (files.some((file) => file.sizeBytes > limit)) return { ok: false, problem: 'file_too_large' };

  return {
    ok: true,
    payload: {
      kind,
      ...(text === null ? {} : { text }),
      files,
      sourceHint,
    },
  };
}

/** Every uri a payload holds, for the cleanup in the screen's `finally`. */
export function urisOf(payload: SharedPayload | null): string[] {
  return (payload?.files ?? []).map((file) => file.uri);
}

/**
 * Every uri the *intent* held, whether or not it became a payload.
 *
 * `urisOf` cannot answer this: a share that is refused on device — six images,
 * a 40 MB PDF, a file type nothing reads — produces no payload, and the copies
 * the OS made are on disk exactly as they are for one that is accepted. A
 * refusal that left them there would fail the criterion for the shares most
 * likely to be repeated.
 */
export function urisOfIntent(intent: ShareIntent): string[] {
  return (intent.files ?? []).map((file) => file.path);
}
