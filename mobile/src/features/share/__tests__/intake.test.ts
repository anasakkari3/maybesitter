/**
 * The client-side half of the share limits (UC-3.0, #183).
 *
 * The criterion this file is the evidence for is *"oversized or disallowed
 * input is rejected on device (no network call)"*. "No network call" is a claim
 * about a decision taken before one is started, and `normalizeShareIntent` is
 * where that decision is taken — so it is checked here as arithmetic, with no
 * native module, no device and no share sheet.
 *
 * Every case builds the shape `expo-share-intent` actually produces
 * (`ShareIntent`, `ShareIntentFile`), not a shape this file invented.
 */
import { describe, expect, it } from '@jest/globals';
import type { ShareIntent, ShareIntentFile } from 'expo-share-intent';
import {
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  MAX_PDF_BYTES,
  MAX_TEXT_CHARACTERS,
  MAX_TEXT_FILE_BYTES,
  mimeTypeFor,
  normalizeShareIntent,
  sourceHintFor,
  urisOf,
  urisOfIntent,
} from '../intake';

const MB = 1024 * 1024;

function file(over: Partial<ShareIntentFile> = {}): ShareIntentFile {
  return {
    fileName: 'photo.jpg',
    mimeType: 'image/jpeg',
    path: 'file:///tmp/photo.jpg',
    size: 1024,
    width: null,
    height: null,
    duration: null,
    ...over,
  };
}

function intent(over: Partial<ShareIntent> = {}): ShareIntent {
  return { files: null, text: null, webUrl: null, type: null, ...over } as ShareIntent;
}

describe('what a share is', () => {
  it('a shared sentence is text, with no files', () => {
    const result = normalizeShareIntent(intent({ text: 'Call the dentist tomorrow at 3', type: 'text' }));
    expect(result.ok && result.payload.kind).toBe('text');
    expect(result.ok && result.payload.text).toBe('Call the dentist tomorrow at 3');
    expect(result.ok && result.payload.files).toEqual([]);
  });

  it('a shared link is folded into the text rather than given a kind of its own', () => {
    // A link is a sentence as far as the extractor is concerned. A seventh kind
    // would be one more thing four channel issues have to have an opinion about.
    const result = normalizeShareIntent(intent({ webUrl: 'https://clinic.example/booking', type: 'weburl' }));
    expect(result.ok && result.payload.kind).toBe('text');
    expect(result.ok && result.payload.text).toContain('https://clinic.example/booking');
  });

  it('photos are images, a PDF is a pdf, a zip is a chat archive, an ics is a calendar file', () => {
    const cases: [ShareIntentFile, string][] = [
      [file(), 'images'],
      [file({ fileName: 'invoice.pdf', mimeType: 'application/pdf' }), 'pdf'],
      [file({ fileName: 'chat.zip', mimeType: 'application/zip' }), 'chatArchive'],
      [file({ fileName: 'visit.ics', mimeType: 'text/calendar' }), 'calendarFile'],
      [file({ fileName: 'notes.txt', mimeType: 'text/plain' }), 'textFile'],
    ];
    for (const [shared, kind] of cases) {
      const result = normalizeShareIntent(intent({ files: [shared] }));
      expect({ name: shared.fileName, kind: result.ok ? result.payload.kind : result }).toEqual({
        name: shared.fileName,
        kind,
      });
    }
  });

  it('falls back to the extension when the OS says octet-stream', () => {
    // Android share sheets hand over `application/octet-stream` more often than
    // they hand over the truth.
    expect(mimeTypeFor({ mimeType: 'application/octet-stream', fileName: 'export.zip' })).toBe('application/zip');
    expect(mimeTypeFor({ mimeType: null, fileName: 'scan.HEIC' })).toBe('image/heic');
    // And it is only a routing guess: the server sniffs the bytes.
    expect(mimeTypeFor({ mimeType: null, fileName: 'mystery' })).toBe('application/octet-stream');
  });

  it('a video — or anything else with no kind — is refused, not uploaded', () => {
    const result = normalizeShareIntent(intent({ files: [file({ fileName: 'clip.mp4', mimeType: 'video/mp4' })] }));
    expect(result).toEqual({ ok: false, problem: 'unsupported' });
  });

  it('a mixture is refused here as well as on the server', () => {
    // Uploading it to be told no would cost the user one of their thirty shares
    // and a round trip.
    const result = normalizeShareIntent(intent({
      files: [file(), file({ fileName: 'invoice.pdf', mimeType: 'application/pdf', path: 'file:///tmp/i.pdf' })],
    }));
    expect(result).toEqual({ ok: false, problem: 'unsupported' });
  });

  it('an empty intent is a refusal, not an empty payload', () => {
    expect(normalizeShareIntent(intent())).toEqual({ ok: false, problem: 'empty' });
    expect(normalizeShareIntent(intent({ text: '   ' }))).toEqual({ ok: false, problem: 'empty' });
  });
});

describe('the types real share sheets actually send', () => {
  it('an .eml is a text file rather than a refusal', () => {
    // #192 owns reading an email. What #183 owes it is that one gets through
    // the door — otherwise that lane has to edit this file and `mediaType.ts`,
    // which breaks the one-file promise before it is made.
    const result = normalizeShareIntent(intent({
      files: [file({ fileName: 'thread.eml', mimeType: 'message/rfc822', path: 'file:///tmp/t.eml', size: 2048 })],
      type: 'file',
    }));
    expect(result.ok && result.payload.kind).toBe('textFile');
    expect(result.ok && result.payload.sourceHint).toBe('email');
  });

  it('the zip spellings Android and Windows use are all chat archives', () => {
    // #189's Android WhatsApp export arrives declared `application/x-zip-compressed`.
    for (const mimeType of ['application/zip', 'application/x-zip-compressed', 'application/zip-compressed', 'multipart/x-zip']) {
      const result = normalizeShareIntent(intent({
        files: [file({ fileName: 'WhatsApp Chat with Dana.zip', mimeType, path: 'file:///tmp/c.zip', size: 4096 })],
        type: 'file',
      }));
      expect(result.ok && result.payload.kind).toBe('chatArchive');
    }
  });

  it('an .eml the OS would not type is still read off its extension', () => {
    const result = normalizeShareIntent(intent({
      files: [file({ fileName: 'thread.eml', mimeType: 'application/octet-stream', path: 'file:///tmp/t.eml', size: 2048 })],
      type: 'file',
    }));
    expect(result.ok && result.payload.kind).toBe('textFile');
  });

  it('a video is still refused, so the list did not become a catch-all', () => {
    const result = normalizeShareIntent(intent({
      files: [file({ fileName: 'clip.mp4', mimeType: 'video/mp4', path: 'file:///tmp/c.mp4', size: 2048 })],
      type: 'media',
    }));
    expect(result.ok).toBe(false);
  });
});

describe('the limits, at the boundary', () => {
  it('takes five images and refuses six', () => {
    const five = Array.from({ length: MAX_IMAGES }, (_, index) => file({ path: `file:///tmp/${index}.jpg` }));
    expect(normalizeShareIntent(intent({ files: five })).ok).toBe(true);
    expect(normalizeShareIntent(intent({ files: [...five, file({ path: 'file:///tmp/6.jpg' })] })))
      .toEqual({ ok: false, problem: 'too_many_files' });
  });

  it('takes an image at the limit and refuses one byte over', () => {
    expect(normalizeShareIntent(intent({ files: [file({ size: MAX_IMAGE_BYTES })] })).ok).toBe(true);
    expect(normalizeShareIntent(intent({ files: [file({ size: MAX_IMAGE_BYTES + 1 })] })))
      .toEqual({ ok: false, problem: 'file_too_large' });
  });

  it('holds a PDF to ten megabytes and a text file to one', () => {
    const pdf = (size: number) => file({ fileName: 'a.pdf', mimeType: 'application/pdf', size });
    expect(normalizeShareIntent(intent({ files: [pdf(MAX_PDF_BYTES)] })).ok).toBe(true);
    expect(normalizeShareIntent(intent({ files: [pdf(MAX_PDF_BYTES + 1)] })))
      .toEqual({ ok: false, problem: 'file_too_large' });
    // The PDF ceiling is below the image one, so a 12 MB PDF is refused where a
    // 12 MB photo is not.
    expect(normalizeShareIntent(intent({ files: [pdf(12 * MB)] })))
      .toEqual({ ok: false, problem: 'file_too_large' });
    const txt = (size: number) => file({ fileName: 'a.txt', mimeType: 'text/plain', size });
    expect(normalizeShareIntent(intent({ files: [txt(MAX_TEXT_FILE_BYTES)] })).ok).toBe(true);
    expect(normalizeShareIntent(intent({ files: [txt(MAX_TEXT_FILE_BYTES + 1)] })))
      .toEqual({ ok: false, problem: 'file_too_large' });
  });

  it('takes text at the limit and refuses one character over', () => {
    expect(normalizeShareIntent(intent({ text: 'a'.repeat(MAX_TEXT_CHARACTERS) })).ok).toBe(true);
    expect(normalizeShareIntent(intent({ text: 'a'.repeat(MAX_TEXT_CHARACTERS + 1) })))
      .toEqual({ ok: false, problem: 'text_too_long' });
  });

  it('lets a file through when the OS would not say how big it is', () => {
    // Zero means "unknown" on both platforms, and the server measures the bytes
    // it actually receives. Refusing here would refuse real shares.
    expect(normalizeShareIntent(intent({ files: [file({ size: null })] })).ok).toBe(true);
  });

  it('refuses a second PDF rather than reading one and dropping the other', () => {
    const pdf = (n: number) => file({ fileName: `${n}.pdf`, mimeType: 'application/pdf', path: `file:///tmp/${n}.pdf` });
    expect(normalizeShareIntent(intent({ files: [pdf(1), pdf(2)] })))
      .toEqual({ ok: false, problem: 'too_many_files' });
  });
});

describe('where it came from', () => {
  it('reads WhatsApp and email off the file name', () => {
    expect(sourceHintFor([{ fileName: 'WhatsApp Chat with Dana.zip' }], null)).toBe('whatsapp');
    expect(sourceHintFor([{ fileName: '_chat.txt' }], null)).toBe('whatsapp');
    expect(sourceHintFor([{ fileName: 'Re_ the invoice.eml' }], null)).toBe('email');
    expect(sourceHintFor([{ fileName: 'photo.jpg' }], null)).toBe('unknown');
  });

  it('reads a WhatsApp export header out of shared text with no file at all', () => {
    expect(sourceHintFor([], '12/08/2026, 14:03 - Dana: see you at six')).toBe('whatsapp');
    expect(sourceHintFor([], 'Call the dentist tomorrow')).toBe('unknown');
  });

  it('reads the shape of an email out of shared text with no file at all (#192)', () => {
    // A selection out of Gmail or Apple Mail arrives as bare text: no file, no
    // name, nothing to read but the shape. `emailTextDetector.ts` decides, and
    // it is the same predicate the server runs.
    const selection = [
      'From: Office <office@school.example>',
      'Subject: Consent form',
      '',
      'Dear Anas,',
      '',
      'Please return the form by Monday.',
      '',
      'Best regards,',
      'Dana',
    ].join('\n');
    expect(sourceHintFor([], selection)).toBe('email');
    // And a typed sentence with somebody's address in it is not an email. One
    // signal is not two, which is the whole reason the detector needs two.
    expect(sourceHintFor([], 'Email dana@example.com about the form')).toBe('unknown');
  });

  it('is only ever a hint, and never decides anything on its own', () => {
    // The kind comes from the bytes, on the server. A `.jpg` shared out of
    // WhatsApp is still `images`.
    const result = normalizeShareIntent(intent({ files: [file({ fileName: 'WhatsApp Image.jpg' })] }));
    expect(result.ok && result.payload).toMatchObject({ kind: 'images', sourceHint: 'whatsapp' });
  });
});

describe('the paths the OS left behind', () => {
  it('names every copy a payload holds', () => {
    const result = normalizeShareIntent(intent({
      files: [file({ path: 'file:///tmp/a.jpg' }), file({ path: 'file:///tmp/b.jpg' })],
    }));
    expect(urisOf(result.ok ? result.payload : null)).toEqual(['file:///tmp/a.jpg', 'file:///tmp/b.jpg']);
    expect(urisOf(null)).toEqual([]);
  });

  it('names the copies of a share that was refused, which has no payload at all', () => {
    // The OS made the copies before we had an opinion about the share. A
    // refusal that left them there would fail the criterion for exactly the
    // shares a user is most likely to repeat.
    const refused = intent({ files: [file({ fileName: 'clip.mp4', mimeType: 'video/mp4', path: 'file:///tmp/clip.mp4' })] });
    expect(normalizeShareIntent(refused).ok).toBe(false);
    expect(urisOfIntent(refused)).toEqual(['file:///tmp/clip.mp4']);
  });
});
