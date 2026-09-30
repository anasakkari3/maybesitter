/**
 * Every request whose answer carries a title a model wrote says which
 * language the app is in (owner request 2026-09-30: «لما لغة التطبيق عربي …
 * ينحفظ بالعربي»).
 *
 * The server titles what it proposes in that language, so the language has to
 * be the one the app is showing *when the person sends*, not the device's and
 * not the one it had when the screen mounted. These drive the real hooks and
 * the real endpoints over a mocked `fetch`, switch the language the way
 * `AppContext` does (`setLocale`), and read the request bodies.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Text } from 'react-native';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { createAppQueryClient } from '../queryClient';
import { useCapture, useCaptureChat, useImportAiContext, usePrepareMeeting, useProposeFromShare } from '../queries';
import * as shareEndpoints from '../endpoints/share';
import * as apiClient from '../client';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { setAuthRepository, resetAuthForTests } from '../auth';
import { setLocale } from '../../i18n';
import type { Locale } from '../../i18n/locale';
import proposalFixture from '../__fixtures__/capture.proposal.json';
import chatFixture from '../__fixtures__/capture.chatProposal.json';
import shareFixture from '../__fixtures__/capture.shareProposal.json';
import meetingFixture from '../__fixtures__/meetings.preparedGemini.json';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  // The device says English throughout: the app's language is what is sent.
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

let sent: { path: string; body: Record<string, unknown> }[];
let client: ReturnType<typeof createAppQueryClient>;

/** What each path answers: the real route's fixture, so the schemas accept it. */
function answerFor(path: string): unknown {
  if (path === '/api/mobile/capture') return proposalFixture;
  if (path === '/api/mobile/capture/chat') return chatFixture;
  if (path === '/api/mobile/meetings/prepare') return meetingFixture;
  if (path === '/api/mobile/profile/import') {
    return { success: true, proposalId: 'p1', candidates: [], existingCount: 0, existingTruncated: false };
  }
  return {};
}

beforeEach(() => {
  client = createAppQueryClient();
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3000';
  setAuthRepository(createFakeAuthRepository({
    initialUser: { uid: 'alice', email: null, emailVerified: true, displayName: null, providerIds: ['password'] },
  }));
  sent = [];
  (globalThis as { fetch: unknown }).fetch = jest.fn(async (url: string, init: { body?: string }) => {
    const path = new URL(String(url)).pathname;
    sent.push({ path, body: JSON.parse(init?.body ?? '{}') as Record<string, unknown> });
    return { status: 200, text: async () => JSON.stringify(answerFor(path)) };
  }) as never;
});

afterEach(async () => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  await setLocale('ar');
});

/** One button per request, each through its real hook. */
function Probe() {
  const capture = useCapture();
  const chat = useCaptureChat();
  const share = useProposeFromShare();
  const prepare = usePrepareMeeting();
  const importing = useImportAiContext();
  const settled = [capture, chat, share, prepare, importing].filter(mutation => mutation.isSuccess || mutation.isError).length;
  return (
    <>
      <Text testID="capture" onPress={() => capture.mutate('meeting with Sara tomorrow at 10')}>capture</Text>
      <Text testID="chat" onPress={() => chat.mutate({ conversationId: null, message: 'meeting with Sara tomorrow at 10' })}>chat</Text>
      <Text testID="share" onPress={() => share.mutate({ text: 'Dentist appointment on Tuesday at 4pm', sourceHint: 'email' })}>share</Text>
      <Text testID="prepare" onPress={() => prepare.mutate({ notes: 'Print the report', startAt: '2026-10-01T09:00:00.000Z', endAt: null })}>prepare</Text>
      <Text testID="import" onPress={() => importing.mutate({ text: 'They work 9 to 5.', assistant: 'chatgpt' })}>import</Text>
      <Text testID="settled">{String(settled)}</Text>
    </>
  );
}

async function sendAll(): Promise<void> {
  await render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  );
  for (const id of ['capture', 'chat', 'share', 'prepare', 'import']) await fireEvent.press(screen.getByTestId(id));
  await waitFor(() => expect(screen.getByTestId('settled')).toHaveTextContent('5'));
}

describe('the app language on the requests a model titles', () => {
  it.each<Locale>(['ar', 'en', 'he'])('sends locale %s on capture, chat, share, meeting prep and AI import', async locale => {
    await setLocale(locale);
    const share = jest.spyOn(shareEndpoints, 'proposeFromShare').mockResolvedValue(shareFixture as never);

    await sendAll();

    const bodyOf = (path: string) => sent.find(request => request.path === path)?.body;
    expect(bodyOf('/api/mobile/capture')).toMatchObject({ text: 'meeting with Sara tomorrow at 10', locale });
    expect(bodyOf('/api/mobile/capture/chat')).toMatchObject({ message: 'meeting with Sara tomorrow at 10', locale });
    expect(bodyOf('/api/mobile/meetings/prepare')).toMatchObject({ notes: 'Print the report', locale });
    expect(bodyOf('/api/mobile/profile/import')).toMatchObject({ assistant: 'chatgpt', locale });
    // The share is an upload; the endpoint puts `locale` in its fields.
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ sourceHint: 'email', locale }));
  });

  it('follows a language change made after the screen mounted', async () => {
    await setLocale('en');
    await render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
    await setLocale('ar');
    await fireEvent.press(screen.getByTestId('capture'));
    await waitFor(() => expect(sent.some(request => request.path === '/api/mobile/capture')).toBe(true));
    expect(sent.find(request => request.path === '/api/mobile/capture')!.body.locale).toBe('ar');
  });
});

describe('the share upload', () => {
  it('carries locale as one of its fields', async () => {
    const upload = jest.spyOn(apiClient, 'apiUpload').mockResolvedValue(shareFixture as never);
    await shareEndpoints.proposeFromShare({ text: 'x', timezone: 'Asia/Jerusalem', locale: 'he' });
    expect(upload).toHaveBeenCalledWith('/api/mobile/capture/share', expect.objectContaining({
      fields: expect.objectContaining({ locale: 'he', timezone: 'Asia/Jerusalem' }),
    }));
  });

  it('sends no locale field when none is given, as an older build does', async () => {
    const upload = jest.spyOn(apiClient, 'apiUpload').mockResolvedValue(shareFixture as never);
    await shareEndpoints.proposeFromShare({ text: 'x', timezone: 'Asia/Jerusalem' });
    const fields = (upload.mock.calls[0]![1] as { fields: Record<string, string> }).fields;
    expect(fields).not.toHaveProperty('locale');
  });
});
