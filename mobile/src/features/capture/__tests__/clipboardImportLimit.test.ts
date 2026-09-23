/**
 * The paste limit, now that two features paste.
 *
 * ── The defect this file is for ──────────────────────────────────
 *
 * `normalizeClipboardText` truncated to `MAX_CAPTURE_LENGTH`, which is 2,000 —
 * right for a captured sentence, and half of what an AI context import accepts.
 * A 4,000-character profile pasted into the import screen was silently cut in
 * two, and the user would have been shown candidates from the first half of
 * their life with no indication the rest was dropped.
 *
 * The fix is a parameter with the old value as its default, so capture's
 * behaviour is byte-identical and only the caller that asked for more gets it.
 */
import { describe, expect, it } from '@jest/globals';
import { normalizeClipboardText, readClipboardText } from '../clipboardImport';
import { MAX_CAPTURE_LENGTH } from '../captureMachine';

describe('the default limit is still capture-s', () => {
  it('truncates to the capture length when nothing is asked for', () => {
    expect(normalizeClipboardText('x'.repeat(5_000))).toHaveLength(MAX_CAPTURE_LENGTH);
  });

  it('reads through to the same default', async () => {
    const read = async () => 'x'.repeat(5_000);
    const result = await readClipboardText(read);
    expect(result.kind).toBe('text');
    expect(result.kind === 'text' && result.text).toHaveLength(MAX_CAPTURE_LENGTH);
  });
});

describe('a caller that needs a longer paste', () => {
  it('gets the length it asked for', () => {
    expect(normalizeClipboardText('x'.repeat(5_000), 4_000)).toHaveLength(4_000);
  });

  it('gets it through the reader too', async () => {
    const read = async () => 'x'.repeat(5_000);
    const result = await readClipboardText(read, { maxLength: 4_000 });
    expect(result.kind === 'text' && result.text).toHaveLength(4_000);
  });

  it('still normalises line endings and trims', () => {
    expect(normalizeClipboardText('  a\r\nb  ', 4_000)).toBe('a\nb');
  });

  it('still reports an empty clipboard as empty', async () => {
    expect((await readClipboardText(async () => '   ', { maxLength: 4_000 })).kind).toBe('empty');
  });

  it('still treats a refusing pasteboard as empty', async () => {
    const read = async () => { throw new Error('no'); };
    expect((await readClipboardText(read, { maxLength: 4_000 })).kind).toBe('empty');
  });
});
