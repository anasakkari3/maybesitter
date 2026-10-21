import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor } from '@testing-library/react-native';
import { MemoryScreen } from '../../features/memory/MemoryScreen';
import { KnowsScreen } from '../../features/settings/KnowsScreen';
import {
  DISCLOSURE_VERSION,
  NOW,
  Providers,
  ZONE,
  deferred,
  fact,
  prepareM6b,
  teardown,
  type M6bHarness,
} from './harness';

process.env.TZ = ZONE;

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

let harness: M6bHarness | undefined;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(async () => {
  await teardown(harness);
  harness = undefined;
  jest.useRealTimers();
});

async function showMemory(): Promise<void> {
  await render(
    <Providers harness={harness!}>
      <MemoryScreen onBack={() => undefined} />
    </Providers>,
  );
  await waitFor(() => expect(harness!.server.matching('GET', /^\/api\/mobile\/memory$/).length).toBeGreaterThan(0));
}

describe('M6a-2 translation eligibility', () => {
  it('R2 / R3-002 / R4-003 offers only a cross-language first-strong fact', async () => {
    harness = await prepareM6b('en', {
      memoryItems: [
        // Arabic: "meeting tomorrow".
        { ...fact('mem_ar', '\u0627\u062c\u062a\u0645\u0627\u0639 \u0628\u0643\u0631\u0629'), language: 'en' as const },
        { ...fact('mem_en', 'Dentist tomorrow'), language: 'ar' as const },
        fact('mem_cyrillic', '\u0412\u0441\u0442\u0440\u0435\u0447\u0430 \u0437\u0430\u0432\u0442\u0440\u0430'),
        fact('mem_letterless', '11:30'),
        // Arabic: "preference in Arabic"; the app action is fact-only.
        { ...fact('mem_preference', '\u062a\u0641\u0636\u064a\u0644 \u0628\u0627\u0644\u0639\u0631\u0628\u064a'), kind: 'preference' as const },
      ],
    });
    await showMemory();

    await waitFor(() => expect(screen.queryByTestId('m6-translate-action-mem_ar')).not.toBeNull());
    expect(screen.queryByTestId('m6-translate-action-mem_en')).toBeNull();
    expect(screen.queryByTestId('m6-translate-action-mem_cyrillic')).toBeNull();
    expect(screen.queryByTestId('m6-translate-action-mem_letterless')).toBeNull();
    expect(screen.queryByTestId('m6-translate-action-mem_preference')).toBeNull();
  });

  const LANGUAGE_CASES: ['ar' | 'en' | 'he', string, string][] = [
    ['ar', 'English fact', '\u062d\u0642\u064a\u0642\u0629 \u0639\u0631\u0628\u064a\u0629'], // Arabic: "Arabic fact".
    ['en', '\u062d\u0642\u064a\u0642\u0629 \u0639\u0631\u0628\u064a\u0629', 'English fact'], // Arabic: "Arabic fact".
    ['he', 'English fact', '\u05e2\u05d5\u05d1\u05d3\u05d4 \u05d1\u05e2\u05d1\u05e8\u05d9\u05ea'], // Hebrew: "fact in Hebrew".
  ];

  it.each(LANGUAGE_CASES)('R2 %s UI offers another script and not its own script', async (language, other, same) => {
    harness = await prepareM6b(language, {
      memoryItems: [fact('mem_other', other), fact('mem_same', same)],
    });
    await showMemory();

    await waitFor(() => expect(screen.queryByTestId('m6-translate-action-mem_other')).not.toBeNull());
    expect(screen.queryByTestId('m6-translate-action-mem_same')).toBeNull();
  });

  it('R2 / R4-002 fails closed while the m6b probe is pending, then enables the known version', async () => {
    const capability = deferred<{ status: number; body: unknown }>();
    harness = await prepareM6b('en', {
      memoryItems: [
        // Arabic: "meeting tomorrow".
        fact('mem_pending', '\u0627\u062c\u062a\u0645\u0627\u0639 \u0628\u0643\u0631\u0629'),
      ],
      capability: capability.promise,
    });
    await showMemory();

    await waitFor(() => expect(harness!.server.matching('GET', /^\/api\/mobile\/capabilities\/m6b$/)).toHaveLength(1));
    expect(screen.queryByTestId('m6-translate-action-mem_pending')).toBeNull();

    capability.resolve({
      status: 200,
      body: { success: true, memoryTranslation: true, disclosureVersion: DISCLOSURE_VERSION },
    });
    await waitFor(() => expect(screen.queryByTestId('m6-translate-action-mem_pending')).not.toBeNull());
  });

  it('R2 / R4-002 keeps off, failed, older-server, and unknown-version probes off', async () => {
    const replies = [
      { status: 200, body: { success: true, memoryTranslation: false, disclosureVersion: DISCLOSURE_VERSION } },
      { status: 500, body: { success: false, error: 'server_error' } },
      { status: 404, body: { success: false, error: 'feature_unavailable', reason: 'feature_unavailable' } },
      { status: 200, body: { success: true, memoryTranslation: true, disclosureVersion: 'memory-translation-disclosure-v2' } },
    ];

    for (const [index, capability] of replies.entries()) {
      harness = await prepareM6b('en', {
        // Arabic: "meeting tomorrow".
        memoryItems: [fact(`mem_off_${index}`, '\u0627\u062c\u062a\u0645\u0627\u0639 \u0628\u0643\u0631\u0629')],
        capability,
      });
      const view = await render(
        <Providers harness={harness}><MemoryScreen onBack={() => undefined} /></Providers>,
      );
      await waitFor(() => expect(harness!.server.matching('GET', /^\/api\/mobile\/capabilities\/m6b$/)).toHaveLength(1));
      expect(screen.queryByTestId(`m6-translate-action-mem_off_${index}`)).toBeNull();
      await view.unmount();
      await teardown(harness);
      harness = undefined;
    }
  });

  it('R2 keeps capabilities/m6 search-only and uses m6b as the translation switch', async () => {
    harness = await prepareM6b('en', {
      searchHistory: false,
      // Arabic: "meeting tomorrow".
      memoryItems: [fact('mem_separate', '\u0627\u062c\u062a\u0645\u0627\u0639 \u0628\u0643\u0631\u0629')],
    });
    await showMemory();

    await waitFor(() => expect(screen.queryByTestId('m6-translate-action-mem_separate')).not.toBeNull());
    expect(harness.server.matching('GET', /^\/api\/mobile\/capabilities\/m6b$/).length).toBeGreaterThan(0);
    expect(harness.server.matching('GET', /^\/api\/mobile\/capabilities\/m6$/)).toHaveLength(0);
  });

  it('M6A2-R005 renders actions on both mounted row surfaces', async () => {
    harness = await prepareM6b('en', {
      // Arabic: "meeting tomorrow".
      memoryItems: [fact('mem_rows', '\u0627\u062c\u062a\u0645\u0627\u0639 \u0628\u0643\u0631\u0629')],
      handler: request => request.path === '/api/mobile/capabilities/m5b'
        ? { status: 200, body: { success: true, memoryLearning: false } }
        : undefined,
    });
    await render(
      <Providers harness={harness}>
        <KnowsScreen onBack={() => undefined} onMemory={() => undefined} />
        <MemoryScreen onBack={() => undefined} />
      </Providers>,
    );

    await waitFor(() => expect(screen.queryAllByTestId('m6-translate-action-mem_rows')).toHaveLength(2));
  });

  it.each(['ready', 'loading'] as const)(
    'M6A2-R005 summary %s hides MemorySection rows while MemoryScreen keeps the action',
    async summaryState => {
      const summary = deferred<{ status: number; body: unknown }>();
      harness = await prepareM6b('en', {
        // Arabic: "meeting tomorrow".
        memoryItems: [fact('mem_summary', '\u0627\u062c\u062a\u0645\u0627\u0639 \u0628\u0643\u0631\u0629')],
        ...(summaryState === 'loading'
          ? { handler: request => request.path === '/api/mobile/memory/summary' ? summary.promise : undefined }
          : {}),
      });
      await render(
        <Providers harness={harness}>
          <KnowsScreen onBack={() => undefined} onMemory={() => undefined} />
          <MemoryScreen onBack={() => undefined} />
        </Providers>,
      );

      await waitFor(() => expect(screen.queryByTestId('memory-screen-item-mem_summary')).not.toBeNull());
      await waitFor(() => expect(screen.queryAllByTestId('m6-translate-action-mem_summary')).toHaveLength(1));
      expect(screen.queryByTestId('memory-item-mem_summary')).toBeNull();
      expect(screen.queryByTestId(summaryState === 'ready' ? 'memory-summary' : 'memory-summary-loading')).not.toBeNull();
      if (summaryState === 'loading') {
        summary.resolve({ status: 200, body: { success: true, summary: { status: 'unavailable' } } });
      }
    },
  );

  it('R2 parity: capability off preserves both memory surfaces and sends no translation request', async () => {
    harness = await prepareM6b('en', {
      capability: {
        status: 200,
        body: { success: true, memoryTranslation: false, disclosureVersion: DISCLOSURE_VERSION },
      },
      // Arabic: "meeting tomorrow".
      memoryItems: [fact('mem_parity', '\u0627\u062c\u062a\u0645\u0627\u0639 \u0628\u0643\u0631\u0629')],
      handler: request => request.path === '/api/mobile/capabilities/m5b'
        ? { status: 200, body: { success: true, memoryLearning: false } }
        : undefined,
    });
    await render(
      <Providers harness={harness}>
        <KnowsScreen onBack={() => undefined} onMemory={() => undefined} />
        <MemoryScreen onBack={() => undefined} />
      </Providers>,
    );

    await waitFor(() => expect(screen.queryByTestId('memory-screen-item-mem_parity')).not.toBeNull());
    expect(screen.queryByTestId('memory-item-mem_parity')).not.toBeNull();
    expect(screen.queryAllByTestId(/^m6-translate-/)).toHaveLength(0);
    expect(harness.server.matching('POST', /\/translation$/)).toHaveLength(0);
  });
});

