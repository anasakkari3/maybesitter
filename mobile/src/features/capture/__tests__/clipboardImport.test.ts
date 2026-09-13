import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';
import { MAX_CAPTURE_LENGTH, captureReducer, initialCaptureState } from '../captureMachine';
import { normalizeClipboardText, readClipboardText } from '../clipboardImport';

/**
 * The read itself (UC-2.R2 #172, step 3).
 *
 * The screen-level behaviour is `captureClipboard.test.tsx`; this is the part
 * that has to be true before a screen is involved at all — what an empty or
 * hostile pasteboard turns into, and that the module holding somebody else's
 * text neither logs it, stores it, nor sends it anywhere.
 */
describe('reading the clipboard', () => {
  it('gives back the text that was on it', async () => {
    await expect(readClipboardText(async () => 'Hand in the report tomorrow at 3'))
      .resolves.toEqual({ kind: 'text', text: 'Hand in the report tomorrow at 3' });
  });

  it('normalises desktop line endings, so the field does not render blank lines', async () => {
    const result = await readClipboardText(async () => 'call Sami\r\nthen the clinic');
    expect(result).toEqual({ kind: 'text', text: 'call Sami\nthen the clinic' });
  });

  it('truncates to exactly what the composer will hold', async () => {
    const long = 'ب'.repeat(MAX_CAPTURE_LENGTH + 500);
    const result = await readClipboardText(async () => long);
    expect(result.kind).toBe('text');
    const pasted = result.kind === 'text' ? result.text : '';
    expect(pasted).toHaveLength(MAX_CAPTURE_LENGTH);
    // The point of truncating here rather than leaving it to the reducer: the
    // sheet shows this string, and the user must be agreeing to what actually
    // lands. If the two limits ever disagreed, this goes red.
    expect(captureReducer(initialCaptureState(), { type: 'textChanged', text: pasted }).text).toBe(pasted);
  });
});

describe('an empty clipboard is not a failure', () => {
  it('reads nothing at all as empty', async () => {
    await expect(readClipboardText(async () => '')).resolves.toEqual({ kind: 'empty' });
  });

  it('reads whitespace as empty, rather than putting a blank draft in the field', async () => {
    await expect(readClipboardText(async () => '   \n\t  ')).resolves.toEqual({ kind: 'empty' });
  });

  it('reads a non-text clipboard as empty', async () => {
    // What `getStringAsync` gives for an image on iOS.
    await expect(readClipboardText(async () => null)).resolves.toEqual({ kind: 'empty' });
  });

  it('turns a pasteboard the OS refused into empty, not an error', async () => {
    await expect(readClipboardText(async () => { throw new Error('pasteboard unavailable'); }))
      .resolves.toEqual({ kind: 'empty' });
  });
});

describe('what it does with somebody else’s text', () => {
  it('never logs it', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const)
      .map((level) => jest.spyOn(console, level).mockImplementation(() => {}));
    try {
      await readClipboardText(async () => 'a password, probably');
      await readClipboardText(async () => { throw new Error('refused'); });
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('imports nothing that could write it down or send it', () => {
    // Asserted against the source, the way `captureMachine.test.ts` asserts the
    // draft never reaches disk: a mock only proves this module behaved today,
    // while the import graph is what would make it possible tomorrow.
    const source = readFileSync(join(__dirname, '..', 'clipboardImport.ts'), 'utf8');
    for (const forbidden of [
      'async-storage', 'AsyncStorage', 'expo-file-system', 'expo-secure-store', 'SecureStore',
      'localStorage', 'writeFile', 'JSON.stringify',
      // No route to the server from here. Pasted text reaches it only by the
      // composer's own analyze, like typed text.
      'api/endpoints', 'api/client', 'apiRequest', 'proposeCapture', 'fetch(', 'console.',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it('normalises without keeping a copy anywhere', () => {
    expect(normalizeClipboardText('  private thing  ')).toBe('private thing');
    expect(normalizeClipboardText('')).toBe('');
  });
});
