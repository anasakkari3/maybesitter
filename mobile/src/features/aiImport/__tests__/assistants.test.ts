/**
 * Which assistant we open, and what we ask it.
 *
 * ── Why https and not a custom scheme ────────────────────────────
 *
 * `canOpenURL` on iOS answers false for any scheme not declared in
 * `LSApplicationQueriesSchemes`, so detecting three competitors' apps would
 * mean naming them in the app config — a store-review surface for nothing. An
 * https URL already reaches the installed app through universal links and
 * Android app links, and falls back to the web app when none is installed. So
 * there is no scheme here to get wrong, and this file asserts there is none.
 */
import { describe, expect, it } from '@jest/globals';
import { ASSISTANTS, IMPORT_ASSISTANTS } from '../assistants';
import { buildAssistantPrompt } from '../importPrompt';
import en from '../../../i18n/locales/en.json';

describe('the assistants', () => {
  it('names every assistant the API accepts', () => {
    expect([...IMPORT_ASSISTANTS]).toEqual(['chatgpt', 'gemini', 'claude', 'other']);
  });

  it('opens only https', () => {
    for (const assistant of IMPORT_ASSISTANTS) {
      for (const url of [ASSISTANTS[assistant].appUrl, ASSISTANTS[assistant].webUrl]) {
        if (url === null) continue;
        expect(url.startsWith('https://')).toBe(true);
      }
    }
  });

  it('tries paths the vendors\' apps claim (AASA, checked 2026-09-25)', () => {
    // chatgpt.com claims /app, not /: the bare domain always opened Safari.
    expect(ASSISTANTS.chatgpt.appUrl).toBe('https://chatgpt.com/app');
    expect(ASSISTANTS.claude.appUrl).toBe('https://claude.ai/new');
  });

  it('falls back to the web chat, not an app path that redirects to the store (CL2b, #21)', () => {
    // Without the app, chatgpt.com/app answers 302 → apps.apple.com.
    expect(ASSISTANTS.chatgpt.webUrl).toBe('https://chatgpt.com/');
    expect(ASSISTANTS.claude.webUrl).toBe('https://claude.ai/new');
    expect(ASSISTANTS.gemini.webUrl).toBe('https://gemini.google.com/app');
  });

  it('has nothing to open for an unnamed assistant', () => {
    // "Another assistant" is a real choice: the prompt is still worth copying.
    expect(ASSISTANTS.other.appUrl).toBeNull();
    expect(ASSISTANTS.other.webUrl).toBeNull();
  });

  it('has a label key for each one', () => {
    for (const assistant of IMPORT_ASSISTANTS) {
      expect(en).toHaveProperty(ASSISTANTS[assistant].labelKey);
    }
  });
});

describe('the prompt we hand the user', () => {
  const t = en as unknown as Parameters<typeof buildAssistantPrompt>[0];

  it('is the copy from the locale file, not a string built here', () => {
    expect(buildAssistantPrompt(t)).toBe(en.aiImportPromptTemplate);
  });

  it('asks for the things a planner can use', () => {
    const prompt = buildAssistantPrompt(t).toLowerCase();
    for (const asked of ['goals', 'routines', 'recurring commitments', 'preferences', 'constraints']) {
      expect(prompt).toContain(asked);
    }
  });

  it('asks the other assistant to leave out what we would refuse anyway', () => {
    const prompt = buildAssistantPrompt(t).toLowerCase();
    // The server's validator drops these regardless. Asking up front means the
    // user never pastes a paragraph about their health for us to silently bin.
    for (const excluded of ['one-off', 'unsure', 'health', 'faith', 'politics']) {
      expect(prompt).toContain(excluded);
    }
  });
});
