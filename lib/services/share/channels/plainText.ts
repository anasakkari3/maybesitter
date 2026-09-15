/**
 * Plain shared text (UC-3.0, #183).
 *
 * The one channel this issue ships, and it exists so the pipeline is reachable
 * end to end rather than as a registry with nothing in it. Share a sentence
 * from any app and it becomes a proposal by the same route a WhatsApp export
 * will take once #189 lands.
 *
 * ── It deliberately does almost nothing ──────────────────────────
 *
 * No parsing, no model call, no cleaning beyond whitespace. Every interesting
 * transformation belongs to a channel that owns a format: #189 knows what a
 * WhatsApp line looks like, #192 knows what a quoted reply looks like, and a
 * "smart" default here would quietly pre-chew their input before they saw it
 * and be impossible to tell apart from their own behaviour when it went wrong.
 *
 * ── Priority 0 ───────────────────────────────────────────────────
 *
 * The floor. Any channel that recognises something specific outranks it, and it
 * claims `text` and `textFile` so that a share nothing else wants still
 * produces something rather than a 415. It does **not** claim `chatArchive`,
 * `images` or `pdf`: handing a zip's raw bytes to a text extractor would turn a
 * WhatsApp export into a page of mojibake and report it as a successful read.
 */
import { decodeUtf8 } from '../mediaType';
import { registerSharePreprocessor } from '../shareRegistry';
import { MAX_EVIDENCE_CHARACTERS, segmentsToResult } from '../shareTypes';
import type {
  SharePreprocessor,
  SharePreprocessResult,
  SharePreprocessorInput,
  ShareSegment,
} from '../shareTypes';

/**
 * Every text this share carries, in order: the shared string first, then any
 * text files.
 *
 * One segment each, attributed to where it came from — `null` for the shared
 * string, the file's index for a file. `segmentsToResult` joins them with the
 * blank line that `splitInput` in the capture boundary reads as a separator, so
 * two sentences shared together become two commitments rather than one run-on
 * title, *and* each of those commitments can say which of the two it came from.
 *
 * Even this channel, which does almost nothing, attributes — because it is the
 * worked example #189–#192 will copy, and an example that skipped the evidence
 * would teach four lanes to skip it too.
 */
function segmentsOf(input: SharePreprocessorInput): { segments: ShareSegment[]; unreadable: number } {
  const segments: ShareSegment[] = [];
  let unreadable = 0;
  const add = (text: string, sourceIndex: number | null) => {
    const trimmed = text.trim();
    if (trimmed === '') return;
    segments.push({
      text: trimmed,
      // The excerpt is the start of the same text. For a channel that does no
      // parsing there is nothing more truthful to say about where a line came
      // from than the line itself; the service truncates it either way.
      evidence: { sourceIndex, excerpt: trimmed.slice(0, MAX_EVIDENCE_CHARACTERS) },
    });
  };

  if (input.text) add(input.text, null);
  input.files.forEach((file, index) => {
    if (file.mediaType !== 'text/plain') {
      unreadable += 1;
      return;
    }
    const decoded = decodeUtf8(file.bytes);
    // Already sniffed as UTF-8, so this cannot normally fail. Counted rather
    // than thrown if it somehow does: one unreadable attachment must not lose
    // the sentence the person shared alongside it.
    if (decoded === null) {
      unreadable += 1;
      return;
    }
    add(decoded, index);
  });
  return { segments, unreadable };
}

/**
 * Exported as well as registered.
 *
 * A test that empties the registry — which is how a test asserts resolution
 * order without the other channels in the way — has to be able to put the
 * built-ins back, and an ESM side-effect import only runs once per process.
 * Every channel should export its preprocessor for the same reason.
 */
export const plainTextPreprocessor: SharePreprocessor = {
  id: 'plain-text',
  kinds: ['text', 'textFile'],
  priority: 0,
  async preprocess(input): Promise<SharePreprocessResult> {
    const { segments, unreadable } = segmentsOf(input);
    // Collapsing to the capture path's own ceiling is *not* done here: the
    // service applies one limit for every channel, so a channel cannot be the
    // one that forgot it.
    return segmentsToResult(segments, {
      ignoredSegments: unreadable,
      metrics: { textFiles: input.files.length, textSegments: segments.length },
    });
  },
};

registerSharePreprocessor(plainTextPreprocessor);
