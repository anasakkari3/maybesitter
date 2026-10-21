import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { MemoryScreen } from '../../features/memory/MemoryScreen';
import { KnowsScreen } from '../../features/settings/KnowsScreen';
import {
  DISCLOSURE_VERSION,
  NOW,
  Providers,
  ZONE,
  deferred,
  fact,
  flatStyle,
  prepareM6b,
  teardown,
  translationPath,
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

const ID = 'mem_flow';
// Arabic: "meeting tomorrow".
const ARABIC_FACT = '\u0627\u062c\u062a\u0645\u0627\u0639 \u0628\u0643\u0631\u0629';
const ENGLISH_PROPOSAL = 'Meeting on Sunday';

const ready = (memoryId = ID) => ({
  status: 200,
  body: {
    success: true,
    proposal: { status: 'ready', text: ENGLISH_PROPOSAL, from: 'ar', to: 'en', memoryId },
  },
});

async function renderMemory(): Promise<void> {
  await render(
    <Providers harness={harness!}>
      <MemoryScreen onBack={() => undefined} />
    </Providers>,
  );
  await waitFor(() => expect(screen.queryByTestId(`m6-translate-action-${ID}`)).not.toBeNull());
}

async function openPanel(): Promise<void> {
  await fireEvent.press(screen.getByTestId(`m6-translate-action-${ID}`));
  await waitFor(() => expect(screen.queryByTestId(`m6-translate-panel-${ID}`)).not.toBeNull());
}

async function requestProposal(): Promise<void> {
  await fireEvent.press(screen.getByTestId(`m6-translate-request-${ID}`));
}

describe('M6a-2 disclosed request flow', () => {
  it('R2-003 mounts disclosure before the one exact POST and never sends on panel open', async () => {
    let disclosureMountedAtPost = false;
    harness = await prepareM6b('ar', {
      memoryItems: [fact(ID, 'Meeting tomorrow')],
      handler: request => {
        if (translationPath(ID).test(request.path)) {
          disclosureMountedAtPost = screen.queryByTestId(`m6-translate-disclosure-${ID}`) !== null;
          return { status: 200, body: { success: true, proposal: { status: 'unavailable' } } };
        }
        return undefined;
      },
    });
    await renderMemory();
    await openPanel();

    expect(screen.queryByTestId(`m6-translate-disclosure-${ID}`)).not.toBeNull();
    expect(screen.queryByTestId(`m6-translate-request-${ID}`)).not.toBeNull();
    expect(harness.server.matching('POST', translationPath(ID))).toHaveLength(0);

    await requestProposal();
    await waitFor(() => expect(harness!.server.matching('POST', translationPath(ID))).toHaveLength(1));
    expect(disclosureMountedAtPost).toBe(true);
    expect(harness.server.matching('POST', translationPath(ID))[0]).toMatchObject({
      method: 'POST',
      path: `/api/mobile/memory/${ID}/translation`,
      body: { locale: 'ar', disclosureVersion: DISCLOSURE_VERSION },
    });
  });

  it('R2-003 closing before the request tap closes the panel and sends nothing', async () => {
    harness = await prepareM6b('en', { memoryItems: [fact(ID, ARABIC_FACT)] });
    await renderMemory();
    await openPanel();

    await fireEvent.press(screen.getByTestId(`m6-translate-keep-${ID}`));
    await waitFor(() => expect(screen.queryByTestId(`m6-translate-panel-${ID}`)).toBeNull());
    expect(harness.server.matching('POST', translationPath(ID))).toHaveLength(0);
  });

  it('R2-003 closing while loading aborts the request and does not send another', async () => {
    const pending = deferred<{ status: number; body: unknown }>();
    harness = await prepareM6b('en', {
      memoryItems: [fact(ID, ARABIC_FACT)],
      handler: request => translationPath(ID).test(request.path) ? pending.promise : undefined,
    });
    await renderMemory();
    await openPanel();
    await requestProposal();

    await waitFor(() => expect(screen.queryByTestId(`m6-translate-loading-${ID}`)).not.toBeNull());
    await waitFor(() => expect(harness!.translationSignals).toHaveLength(1));
    expect(harness.translationSignals[0]?.signal?.aborted).toBe(false);

    await fireEvent.press(screen.getByTestId(`m6-translate-keep-${ID}`));
    await waitFor(() => expect(harness!.translationSignals[0]?.signal?.aborted).toBe(true));
    expect(harness.server.matching('POST', translationPath(ID))).toHaveLength(1);
    pending.resolve(ready());
  });

  it.each(['wire', '422'] as const)('R2 unavailable %s has no Save and is not retried', async responseKind => {
    harness = await prepareM6b('en', {
      memoryItems: [fact(ID, ARABIC_FACT)],
      handler: request => translationPath(ID).test(request.path)
        ? responseKind === 'wire'
          ? { status: 200, body: { success: true, proposal: { status: 'unavailable' } } }
          : { status: 422, body: { success: false, error: 'not_translatable', reason: 'not_translatable' } }
        : undefined,
    });
    await renderMemory();
    await openPanel();
    await requestProposal();

    await waitFor(() => expect(screen.queryByTestId(`m6-translate-unavailable-${ID}`)).not.toBeNull());
    expect(screen.queryByTestId(`m6-translate-save-${ID}`)).toBeNull();
    await act(async () => { jest.advanceTimersByTime(30_000); });
    expect(harness.server.matching('POST', translationPath(ID))).toHaveLength(1);
  });

  it('R2 ready proposal follows content direction and Keep sends no PATCH', async () => {
    harness = await prepareM6b('en', {
      memoryItems: [fact(ID, ARABIC_FACT)],
      handler: request => translationPath(ID).test(request.path) ? ready() : undefined,
    });
    await renderMemory();
    await openPanel();
    await requestProposal();

    await waitFor(() => expect(screen.queryByTestId(`m6-translate-proposal-${ID}`)).not.toBeNull());
    expect(flatStyle(screen.getByTestId(`m6-translate-proposal-${ID}`))).toMatchObject({ writingDirection: 'ltr' });
    expect(screen.queryByTestId(`m6-translate-save-${ID}`)).not.toBeNull();
    await fireEvent.press(screen.getByTestId(`m6-translate-keep-${ID}`));

    await waitFor(() => expect(screen.queryByTestId(`m6-translate-panel-${ID}`)).toBeNull());
    expect(harness.server.matching('PATCH', new RegExp(`/api/mobile/memory/${ID}$`))).toHaveLength(0);
  });

  it('R2 Save PATCHes the same id and proposal text, then refetches list and summary', async () => {
    harness = await prepareM6b('en', {
      memoryItems: [fact(ID, ARABIC_FACT)],
      handler: request => translationPath(ID).test(request.path) ? ready() : undefined,
    });
    await render(
      <Providers harness={harness}>
        <KnowsScreen onBack={() => undefined} onMemory={() => undefined} />
        <MemoryScreen onBack={() => undefined} />
      </Providers>,
    );
    await waitFor(() => expect(screen.queryByTestId('memory-summary')).not.toBeNull());
    await waitFor(() => expect(screen.queryByTestId(`m6-translate-action-${ID}`)).not.toBeNull());
    const listBefore = harness.server.matching('GET', /^\/api\/mobile\/memory$/).length;
    const summaryBefore = harness.server.matching('GET', /^\/api\/mobile\/memory\/summary$/).length;

    await openPanel();
    await requestProposal();
    await waitFor(() => expect(screen.queryByTestId(`m6-translate-save-${ID}`)).not.toBeNull());
    await fireEvent.press(screen.getByTestId(`m6-translate-save-${ID}`));

    await waitFor(() => expect(harness!.server.matching('PATCH', new RegExp(`/api/mobile/memory/${ID}$`))).toHaveLength(1));
    expect(harness.server.matching('PATCH', new RegExp(`/api/mobile/memory/${ID}$`))[0]?.body)
      .toEqual({ content: ENGLISH_PROPOSAL });
    expect(harness.server.matching('POST', translationPath(ID))).toHaveLength(1);
    await waitFor(() => expect(harness!.server.matching('GET', /^\/api\/mobile\/memory$/).length).toBeGreaterThan(listBefore));
    await waitFor(() => expect(harness!.server.matching('GET', /^\/api\/mobile\/memory\/summary$/).length).toBeGreaterThan(summaryBefore));
  });

  it.each([404, 409] as const)('R2 Save %s shows changed, refetches, and never PATCHes twice', async status => {
    harness = await prepareM6b('en', {
      memoryItems: [fact(ID, ARABIC_FACT)],
      handler: request => {
        if (translationPath(ID).test(request.path)) return ready();
        if (request.method === 'PATCH' && request.path === `/api/mobile/memory/${ID}`) {
          return status === 404
            ? { status, body: { success: false, error: 'not_found', reason: 'not_found' } }
            : { status, body: { success: false, error: 'memory_changed', reason: 'memory_changed' } };
        }
        return undefined;
      },
    });
    await renderMemory();
    const listBefore = harness.server.matching('GET', /^\/api\/mobile\/memory$/).length;
    await openPanel();
    await requestProposal();
    await waitFor(() => expect(screen.queryByTestId(`m6-translate-save-${ID}`)).not.toBeNull());
    await fireEvent.press(screen.getByTestId(`m6-translate-save-${ID}`));

    await waitFor(() => expect(screen.queryByTestId(`m6-translate-changed-${ID}`)).not.toBeNull());
    expect(harness.server.matching('PATCH', new RegExp(`/api/mobile/memory/${ID}$`))).toHaveLength(1);
    await waitFor(() => expect(harness!.server.matching('GET', /^\/api\/mobile\/memory$/).length).toBeGreaterThan(listBefore));
  });

  it('R2 POST 404 shows changed, refetches, and sends no PATCH', async () => {
    harness = await prepareM6b('en', {
      memoryItems: [fact(ID, ARABIC_FACT)],
      handler: request => translationPath(ID).test(request.path)
        ? { status: 404, body: { success: false, error: 'not_found', reason: 'not_found' } }
        : undefined,
    });
    await renderMemory();
    const listBefore = harness.server.matching('GET', /^\/api\/mobile\/memory$/).length;
    await openPanel();
    await requestProposal();

    await waitFor(() => expect(screen.queryByTestId(`m6-translate-changed-${ID}`)).not.toBeNull());
    expect(harness.server.matching('PATCH', new RegExp(`/api/mobile/memory/${ID}$`))).toHaveLength(0);
    await waitFor(() => expect(harness!.server.matching('GET', /^\/api\/mobile\/memory$/).length).toBeGreaterThan(listBefore));
  });

  it('R2 never offers Save for a proposal belonging to another memory id', async () => {
    harness = await prepareM6b('en', {
      memoryItems: [fact(ID, ARABIC_FACT)],
      handler: request => translationPath(ID).test(request.path) ? ready('mem_other') : undefined,
    });
    await renderMemory();
    await openPanel();
    await requestProposal();

    await waitFor(() => expect(harness!.server.matching('POST', translationPath(ID))).toHaveLength(1));
    expect(screen.queryByTestId(`m6-translate-save-${ID}`)).toBeNull();
    expect(harness.server.matching('PATCH', new RegExp(`/api/mobile/memory/${ID}$`))).toHaveLength(0);
  });
});

