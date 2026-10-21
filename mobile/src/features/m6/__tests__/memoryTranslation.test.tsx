import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor } from '@testing-library/react-native';
import { MemoryScreen } from '../../memory/MemoryScreen';
import { MemorySection } from '../../memory/MemorySection';
import { translationTargetOf } from '../MemoryTranslation';
import {
  NOW, Providers, fact, prepareM6, press, teardown, waitForRequest,
  type Language, type M6Harness, type RecordedRequest, type RouteReply,
} from '../../../__acceptance__/m6/harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

/** Task A's own tests for «اكتبها بالعربي» (PLAN-M6a-2 R2). Gate A is Codex's. */
let harness: M6Harness | undefined;
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(NOW); });
afterEach(async () => { await teardown(harness); harness = undefined; jest.useRealTimers(); });

const TRANSLATION = /^\/api\/mobile\/memory\/[^/]+\/translation$/;
const PATCH = /^\/api\/mobile\/memory\/[^/]+$/;
// Arabic: «بيروح الجيم مرتين بالأسبوع» ("goes to the gym twice a week").
const PROPOSAL = 'بيروح الجيم مرتين بالأسبوع';
// Arabic: «بحب القهوة» ("I like coffee").
const ARABIC_FACT = 'بحب القهوة';

interface Setup {
  language?: Language;
  capability?: boolean | 'absent' | 'other-version';
  translation?: RouteReply;
  patch?: RouteReply;
  m5b?: boolean;
}

async function setup(options: Setup = {}): Promise<M6Harness> {
  const handler = (request: RecordedRequest): RouteReply | undefined => {
    if (request.path === '/api/mobile/capabilities/m6b') {
      // 'absent' is a server that predates the route.
      return options.capability === 'absent'
        ? { status: 404, body: { success: false, error: 'Not found' } }
        : options.capability === 'other-version'
          ? { status: 200, body: { success: true, memoryTranslation: true, disclosureVersion: 'memory-translation-disclosure-v2' } }
          : { status: 200, body: { success: true, memoryTranslation: options.capability ?? true, disclosureVersion: 'memory-translation-disclosure-v1' } };
    }
    if (request.path === '/api/mobile/capabilities/m5b' && options.m5b === false) {
      return { status: 200, body: { success: true, memoryLearning: false } };
    }
    if (TRANSLATION.test(request.path) && request.method === 'POST') {
      return options.translation ?? {
        status: 200,
        body: { success: true, proposal: { status: 'ready', text: PROPOSAL, from: 'en', to: 'ar', memoryId: 'memory-1' } },
      };
    }
    if (PATCH.test(request.path) && request.method === 'PATCH' && options.patch) return options.patch;
    return undefined;
  };
  return prepareM6(options.language ?? 'ar', {
    memoryItems: [fact('memory-1', 'Goes to the gym twice a week'), fact('memory-2', ARABIC_FACT)],
    handler,
  });
}

async function renderScreen(h: M6Harness) {
  await render(<Providers harness={h}><MemoryScreen onBack={() => {}} /></Providers>);
  await waitFor(() => expect(screen.queryByTestId('memory-screen-item-memory-1')).not.toBeNull());
}

describe('translationTargetOf', () => {
  it('offers the app language only for a fact whose first letter is in another script', () => {
    expect(translationTargetOf('Goes to the gym', 'ar')).toBe('ar');
    expect(translationTargetOf(ARABIC_FACT, 'ar')).toBeNull();
    expect(translationTargetOf(ARABIC_FACT, 'en')).toBe('en');
    expect(translationTargetOf('12:00', 'ar')).toBeNull();
    expect(translationTargetOf('Gym', 'fr')).toBeNull();
    // Another script, or no letter at all, is not offered (M6A2-R3-002). Russian: "likes tea".
    expect(translationTargetOf('\u041b\u044e\u0431\u0438\u0442 \u0447\u0430\u0439', 'ar')).toBeNull();
    expect(translationTargetOf('11:30', 'en')).toBeNull();
  });
});

describe('«اكتبها بالعربي» on the memory screen', () => {
  it('appears on the cross-language fact only, and only when the capability is on', async () => {
    harness = await setup();
    await renderScreen(harness);
    await waitFor(() => expect(screen.queryByTestId('m6-translate-action-memory-1')).not.toBeNull());
    expect(screen.queryByTestId('m6-translate-action-memory-2')).toBeNull();
    expect(screen.getByTestId('m6-translate-action-memory-1').props.accessibilityLabel).toContain('Goes to the gym twice a week');
  });

  it.each([false, 'absent', 'other-version'] as const)('is not offered when the capability is %s', async (capability) => {
    harness = await setup({ capability });
    await renderScreen(harness);
    await waitForRequest(harness, 'GET', /^\/api\/mobile\/capabilities\/m6b$/);
    expect(screen.queryByTestId('m6-translate-action-memory-1')).toBeNull();
  });

  it('shows the disclosure, asks once, and saves the proposal through the ordinary edit of the same id', async () => {
    harness = await setup();
    await renderScreen(harness);
    await waitFor(() => expect(screen.queryByTestId('m6-translate-action-memory-1')).not.toBeNull());
    await press('m6-translate-action-memory-1');
    expect(screen.queryByTestId('m6-translate-disclosure-memory-1')).not.toBeNull();
    // Opening the panel sends nothing (R2-003); the second tap does.
    expect(harness.server.matching('POST', TRANSLATION)).toHaveLength(0);
    await press('m6-translate-request-memory-1');
    const asked = await waitForRequest(harness, 'POST', TRANSLATION);
    expect(asked.path).toBe('/api/mobile/memory/memory-1/translation');
    expect(asked.body).toEqual({ locale: 'ar', disclosureVersion: 'memory-translation-disclosure-v1' });
    await waitFor(() => expect(screen.queryByTestId('m6-translate-proposal-memory-1')).not.toBeNull());
    await press('m6-translate-save-memory-1');
    const saved = await waitForRequest(harness, 'PATCH', PATCH);
    expect(saved.path).toBe('/api/mobile/memory/memory-1');
    expect(saved.body).toEqual({ content: PROPOSAL });
    expect(harness.server.matching('POST', TRANSLATION)).toHaveLength(1);
  });

  it('says it could not, offers no save, and is not retried', async () => {
    harness = await setup({ translation: { status: 200, body: { success: true, proposal: { status: 'unavailable' } } } });
    await renderScreen(harness);
    await waitFor(() => expect(screen.queryByTestId('m6-translate-action-memory-1')).not.toBeNull());
    await press('m6-translate-action-memory-1');
    await press('m6-translate-request-memory-1');
    await waitFor(() => expect(screen.queryByTestId('m6-translate-unavailable-memory-1')).not.toBeNull());
    expect(screen.queryByTestId('m6-translate-save-memory-1')).toBeNull();
    await press('m6-translate-keep-memory-1');
    expect(screen.queryByTestId('m6-translate-panel-memory-1')).toBeNull();
    expect(harness.server.matching('POST', TRANSLATION)).toHaveLength(1);
  });

  it('a record changed meanwhile (409 on save) shows the changed line and stores nothing else', async () => {
    harness = await setup({ patch: { status: 409, body: { success: false, error: 'memory_changed', reason: 'memory_changed' } } });
    await renderScreen(harness);
    await waitFor(() => expect(screen.queryByTestId('m6-translate-action-memory-1')).not.toBeNull());
    await press('m6-translate-action-memory-1');
    await press('m6-translate-request-memory-1');
    await waitFor(() => expect(screen.queryByTestId('m6-translate-save-memory-1')).not.toBeNull());
    await press('m6-translate-save-memory-1');
    await waitFor(() => expect(screen.queryByTestId('m6-translate-changed-memory-1')).not.toBeNull());
    expect(harness.server.matching('PATCH', PATCH)).toHaveLength(1);
  });

  it('a proposal made for another id is not offered', async () => {
    harness = await setup({
      translation: { status: 200, body: { success: true, proposal: { status: 'ready', text: PROPOSAL, from: 'en', to: 'ar', memoryId: 'memory-9' } } },
    });
    await renderScreen(harness);
    await waitFor(() => expect(screen.queryByTestId('m6-translate-action-memory-1')).not.toBeNull());
    await press('m6-translate-action-memory-1');
    await press('m6-translate-request-memory-1');
    await waitFor(() => expect(screen.queryByTestId('m6-translate-unavailable-memory-1')).not.toBeNull());
    expect(screen.queryByTestId('m6-translate-save-memory-1')).toBeNull();
  });

  it('in English, an Arabic fact is offered as "Write it in English"', async () => {
    harness = await setup({ language: 'en' });
    await renderScreen(harness);
    await waitFor(() => expect(screen.queryByTestId('m6-translate-action-memory-2')).not.toBeNull());
    expect(screen.queryByTestId('m6-translate-action-memory-1')).toBeNull();
    expect(screen.getByText('Write it in English')).toBeTruthy();
  });
});

describe('«اكتبها بالعربي» on the Settings card', () => {
  it('is on the rows when they are shown (M5b off)', async () => {
    harness = await setup({ m5b: false });
    await render(<Providers harness={harness}><MemorySection /></Providers>);
    await waitFor(() => expect(screen.queryByTestId('m6-translate-action-memory-1')).not.toBeNull());
  });

  it('is absent while the summary replaces the rows (M5B-1 rule kept, R005)', async () => {
    harness = await setup();
    await render(<Providers harness={harness}><MemorySection /></Providers>);
    await waitFor(() => expect(screen.queryByTestId('memory-summary')).not.toBeNull());
    expect(screen.queryByTestId('m6-translate-action-memory-1')).toBeNull();
  });
});
