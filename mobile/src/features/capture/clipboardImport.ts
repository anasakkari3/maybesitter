/**
 * Reading the clipboard, and only ever because somebody asked (UC-2.R2 #172,
 * step 3).
 *
 * ── Why this is a module and not three lines in the screen ───────
 *
 * A clipboard is the one place on the phone where text belonging to some other
 * app — a password manager, a two-factor code, a colleague's message — is
 * sitting in reach. The rules that keep this honest are small enough to state
 * and easy enough to lose in a screen:
 *
 *   - **Nothing reads it but `readClipboardText`**, and nothing calls
 *     `readClipboardText` but a press handler. There is no read on mount, on
 *     focus, or on the app returning to the foreground. On iOS 14+ a silent
 *     read also raises the system's "pasted from …" banner, so an automatic
 *     one is both a privacy defect and visibly one.
 *   - **Nothing here logs.** Not the text, not its length, not a dev-only
 *     branch. The rule `src/api` lives by (`mobile/AGENTS.md`) is the same rule
 *     here for the same reason: a log line is somebody else's clipboard in the
 *     device log.
 *   - **Nothing here writes.** No storage import, no serialization. What comes
 *     off the clipboard is a draft, and `captureMachine.ts` explains at length
 *     why a draft stays in memory.
 *   - **Nothing here talks to the server.** This returns a string. The only
 *     thing that can do anything with it is `textChanged`, the same event the
 *     keyboard dispatches — see `ClipboardImportSheet`.
 *
 * ── An empty clipboard is not a failure ──────────────────────────
 *
 * A clipboard holding an image, a file, nothing at all, or one the OS declined
 * to hand over are four different facts about the device and none of them is
 * this app malfunctioning. They collapse to one calm outcome — `empty` — which
 * the sheet states in a sentence and closes. An error screen here would blame
 * the user for the contents of their own pasteboard.
 */
import * as Clipboard from 'expo-clipboard';
import { MAX_CAPTURE_LENGTH } from './captureMachine';

/** What a read produced. Never an error: see the note above. */
export type ClipboardImport =
  | { kind: 'text'; text: string }
  | { kind: 'empty' };

/** The one call this module makes, injectable so tests need no native module. */
export type ClipboardReader = () => Promise<string | null>;

/**
 * The pasted text as the composer will actually hold it.
 *
 * Truncated to the same limit `textChanged` truncates to, deliberately: the
 * review sheet shows this string, and if the reducer then cut it further the
 * user would have confirmed one thing and pasted another. Line endings are
 * normalised because a clipboard filled on a desktop carries CRLF, which the
 * field renders as a blank line per break.
 *
 * `maxLength` defaults to capture's limit so capture is unchanged. It exists
 * because the AI context import accepts twice as much: a machine-written profile
 * runs past 2,000 characters easily, and the first version of that screen cut
 * one in half without saying so — the user would have reviewed candidates drawn
 * from the first half of their life and had no way to tell.
 */
export function normalizeClipboardText(raw: string, maxLength: number = MAX_CAPTURE_LENGTH): string {
  return raw.replace(/\r\n?/g, '\n').trim().slice(0, maxLength);
}

/**
 * Reads the clipboard once, now, because the user pressed something.
 *
 * `read` exists so the tests drive every branch — text, whitespace, nothing, a
 * refusing pasteboard — without a native module, and so that the production
 * default is the single line at the bottom of this file rather than something
 * a caller could substitute for a different source.
 */
export async function readClipboardText(
  read: ClipboardReader = () => Clipboard.getStringAsync(),
  options: { maxLength?: number } = {},
): Promise<ClipboardImport> {
  let raw: string | null;
  try {
    raw = await read();
  } catch {
    // An image, a file promise, or a pasteboard the OS refused. Not an error
    // state — the user simply has nothing to paste.
    return { kind: 'empty' };
  }
  const text = normalizeClipboardText(raw ?? '', options.maxLength);
  return text.length > 0 ? { kind: 'text', text } : { kind: 'empty' };
}
