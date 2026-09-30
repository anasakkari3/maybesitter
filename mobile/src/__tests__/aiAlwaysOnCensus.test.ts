/**
 * AI processing can no longer be turned off (owner decision 2026-09-30).
 *
 * The capture page is a chat on the model, and the server reads the AI
 * question as granted and refuses a decline (409 `ai_always_on`). So no
 * screen may offer to decline it, say it is off, or hold anything back until
 * it is "turned on" — and the disclosure that replaced the consent must be on
 * the three surfaces a person meets before and after their first capture:
 * onboarding, the capture page and the trust centre.
 *
 * Asserted against the source, not against a render: a render proves only
 * the screens a test happened to open. A new AI-off chip anywhere fails here
 * on the day it is written.
 */
import { describe, expect, it } from '@jest/globals';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import en from '../i18n/locales/en.json';
import ar from '../i18n/locales/ar.json';
import he from '../i18n/locales/he.json';

const SRC = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === '__tests__' || entry === '__fixtures__' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({ rel: relative(SRC, path), text: readFileSync(path, 'utf8') }));

/** What the removed UI was made of: its hooks, its state names, its test ids and its copy keys. */
const FORBIDDEN = [
  'useAiConsentGranted', 'useSetAiConsent', 'putAiConsent', 'setAiConsent',
  'aiGranted', 'aiAsked', 'aiBlocked', 'blockedOnConsent', "'needsConsent'",
  'capture-ai-off', 'chat-menu-ai-off', 'trust-ai-processing', 'share-turn-on-ai', 'meeting-prep-ai-off',
  'needs-ai', 'turn-on-ai', 'onboarding-ai-declined-note',
  'captureAiOff', 'shareTurnOnAi', 'shareNeedsAi', 'xPrepareAiOff', 'googleNeedsAi', 'aiImportConsentNeeded',
  'obAiAllow', 'obAiDecline', 'obAiDeclinedNote', 'obConsentNeedAi',
];

describe('there is no way to turn AI processing off, and nothing says it is off', () => {
  it('no source file carries the removed controls, states or copy', () => {
    const found = files.flatMap((file) => FORBIDDEN.filter((token) => file.text.includes(token)).map((token) => `${file.rel}: ${token}`));
    expect(found).toEqual([]);
  });

  it('nothing sends an AI-processing answer to the server', () => {
    const writers = files.filter((file) => /apiRequest\(\s*'PUT',\s*'\/api\/mobile\/consents\/ai-processing'/.test(file.text)).map((file) => file.rel);
    expect(writers).toEqual([]);
  });

  it('no locale keeps the removed keys', () => {
    for (const bundle of [en, ar, he] as unknown as Record<string, string>[]) {
      expect(FORBIDDEN.filter((key) => key in bundle)).toEqual([]);
    }
  });
});

describe('the disclosure that replaced the consent', () => {
  const where: [string, string][] = [
    ['features/onboarding/ConsentStep.tsx', 'onboarding-ai-disclosure'],
    ['screens/CaptureScreen.tsx', 'capture-ai-disclosure'],
    ['features/settings/TrustScreen.tsx', 'trust-ai-disclosure'],
  ];

  it.each(where)('%s shows it (%s), both lines', (rel, testID) => {
    const text = files.find((file) => file.rel === rel)!.text;
    expect(text).toContain(`testID="${testID}"`);
    expect(text).toContain('t.aiDisclosure}');
    expect(text).toContain('t.aiDisclosureKept}');
  });

  it('says who reads it, in every language, and claims no switch', () => {
    for (const bundle of [en, ar, he] as unknown as Record<string, string>[]) {
      for (const needle of ['Gemini', 'Google', 'Vertex AI']) expect(bundle.aiDisclosure).toContain(needle);
    }
    // The old AI card said the answer was changeable in Settings. It is not.
    for (const line of [en.aiDisclosure, en.aiDisclosureKept, en.aiDisclosureTitle]) {
      expect(line).not.toMatch(/settings|optional|turn (it )?off|decline/i);
    }
  });
});
