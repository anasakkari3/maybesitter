/**
 * Root → composer → provider → client → real HTTP → existing route/services.
 * Endpoint functions and response bodies are not mocked. Only native device
 * modules (the suite's normal setup), Firebase identity and server storage are
 * replaced. The child host refuses all external network access.
 *
 * ── Not in the default mobile run ────────────────────────────────
 *
 * This suite needs the repository ROOT's dependencies: `node-fetch` is not a
 * mobile dependency, and the forked host (`tests/support/mobileCaptureHttpServer.ts`)
 * loads the real Next.js routes and services. CI's mobile jobs install only
 * `mobile/`, so the mobile jest config ignores this file (`testPathIgnorePatterns`
 * in `mobile/package.json`). Run it explicitly, after `npm ci` in the root AND
 * in `mobile/`:
 *
 *     cd mobile && npm run test:capture-http
 */
import React from 'react';
import { fork, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import { createAppQueryClient } from '../../../api/queryClient';
import { captureConfirmationSchema, captureProposalSchema, type CaptureProposal } from '../../../api/schemas/capture';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import { Root } from '../../../Root';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const REPO = resolve(__dirname, '../../../../..');
// jest-expo supplies a device fetch. node-fetch exercises an actual TCP socket
// here, while the app's apiRequest still serializes, authenticates and parses.
const httpFetch = require('node-fetch') as typeof fetch;
const originalFetch = globalThis.fetch;
const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;
const originalMode = process.env.EXPO_PUBLIC_API_MODE;

type Host = { baseUrl: string; uid: string; token: string; otherUid: string; otherToken: string };
type Snapshot = {
  commitments: Array<{ id: string; title: string; status: string; priority: string }>;
  requests: Array<{ method: string; path: string; status: number }>;
};
type Exchange = { path: string; body: Record<string, unknown>; response: unknown; status: number };

let child: ChildProcess | undefined;
let host: Host;
let sequence = 0;
let client: ReturnType<typeof createAppQueryClient>;
let repository: ReturnType<typeof createFakeAuthRepository>;
let exchanges: Exchange[];

function receive<T>(type: string, id?: number): Promise<T> {
  const serverChild = child!;
  return new Promise((resolveMessage, reject) => {
    const finish = () => {
      clearTimeout(timer);
      serverChild.off('message', onMessage);
      serverChild.off('exit', onExit);
      serverChild.off('error', onError);
    };
    const onMessage = (message: unknown) => {
      const value = message as { type?: string; id?: number; error?: string };
      if (value.type !== type || (id !== undefined && value.id !== id)) return;
      finish();
      if (value.error) reject(new Error(value.error));
      else resolveMessage(message as T);
    };
    const onExit = (code: number | null) => { finish(); reject(new Error(`Capture HTTP host exited (${code})`)); };
    const onError = (error: Error) => { finish(); reject(error); };
    const timer = setTimeout(() => { finish(); reject(new Error(`Capture HTTP host timed out waiting for ${type}`)); }, 10_000);
    serverChild.on('message', onMessage);
    serverChild.once('exit', onExit);
    serverChild.once('error', onError);
  });
}

/** Priority is changed per item, in its edit sheet, and nowhere else. */
async function setPriorityHigh(itemId: string) {
  await fireEvent.press(screen.getByTestId(`review-edit-${itemId}`));
  await waitFor(() => expect(screen.queryByTestId('edit-item-save')).not.toBeNull());
  await fireEvent.press(screen.getByTestId('edit-item-priority-high'));
  await fireEvent.press(screen.getByTestId('edit-item-save'));
  await waitFor(() => expect(screen.queryByTestId(`review-item-${itemId}`)).not.toBeNull());
}

async function snapshot(uid = host.uid): Promise<Snapshot> {
  const id = ++sequence;
  const response = receive<Snapshot>('snapshot', id);
  child!.send({ type: 'snapshot', id, uid });
  return response;
}

beforeEach(async () => {
  child = fork(resolve(REPO, 'tests/support/mobileCaptureHttpServer.ts'), [], {
    cwd: REPO,
    execArgv: ['--no-warnings', '--loader', './scripts/ts-resolver.mjs', '--import', './tests/support/isolateProcess.mjs'],
    env: { ...process.env, NODE_ENV: 'test' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  // Drain stderr so a failure cannot block the child; errors surface through
  // bounded startup/IPC waits and HTTP assertions, not potentially sensitive logs.
  child.stderr?.resume();
  host = await receive<Host>('ready');
  process.env.EXPO_PUBLIC_API_BASE_URL = host.baseUrl;
  process.env.EXPO_PUBLIC_API_MODE = 'api';
  exchanges = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== host.baseUrl) throw new Error('Only the isolated local capture host may be contacted');
    const response = await httpFetch(input, init);
    if (url.pathname.startsWith('/api/mobile/capture')) {
      exchanges.push({
        path: url.pathname,
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
        response: await response.clone().json(),
        status: response.status,
      });
    }
    return response;
  }) as typeof fetch;
  onlineManager.setOnline(true);
  client = createAppQueryClient();
  // This short-lived test owns disposal, so there is no five-minute cache
  // garbage-collection timer after a request finishes during unmount.
  client.setDefaultOptions({ queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } });
  repository = createFakeAuthRepository({
    initialUser: { uid: host.uid, email: null, emailVerified: true, displayName: null, providerIds: ['password'] },
    idToken: host.token,
  });
  setAuthRepository(repository);
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
}, 15_000);

afterEach(async () => {
  await cleanup();
  await client?.cancelQueries();
  client?.clear();
  resetAuthForTests();
  globalThis.fetch = originalFetch;
  if (originalBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalBase;
  if (originalMode === undefined) delete process.env.EXPO_PUBLIC_API_MODE;
  else process.env.EXPO_PUBLIC_API_MODE = originalMode;
  await AsyncStorage.clear();
  const serverChild = child;
  child = undefined;
  if (serverChild && serverChild.exitCode === null && serverChild.signalCode === null) {
    await new Promise<void>((done) => {
      const timer = setTimeout(() => { serverChild.kill('SIGKILL'); }, 3_000);
      serverChild.once('exit', () => { clearTimeout(timer); done(); });
      if (serverChild.connected) serverChild.send({ type: 'close' });
      else serverChild.kill('SIGTERM');
    });
  }
  jest.restoreAllMocks();
}, 10_000);

async function openAndAnalyze(text: string): Promise<CaptureProposal> {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}><Root /></QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('tab-capture')).not.toBeNull());
  await fireEvent.press(screen.getByTestId('tab-capture'));
  await waitFor(() => expect(screen.queryByTestId('capture-input')).not.toBeNull());
  expect(screen.queryByTestId('say-it-chat-page')).not.toBeNull();
  await fireEvent.changeText(screen.getByTestId('capture-input'), text);
  expect(exchanges).toHaveLength(0);
  await fireEvent.press(screen.getByTestId('capture-analyze'));
  await waitFor(() => expect(exchanges.some(item => item.path === '/api/mobile/capture')).toBe(true), { timeout: 5_000 });
  const exchange = exchanges.find(item => item.path === '/api/mobile/capture')!;
  expect(exchange.status).toBe(200);
  expect(exchange.body).toMatchObject({ text, timezone: expect.any(String), referenceTime: expect.any(String) });
  return captureProposalSchema.parse(exchange.response);
}

it('sends the composer over HTTP, reviews without saving, then confirms into account-scoped storage', async () => {
  const proposal = await openAndAnalyze('Call the dentist tomorrow at 3pm');
  expect(proposal.status).toBe('proposed');
  const item = proposal.items[0]!;
  await waitFor(() => expect(screen.queryByTestId(`review-item-${item.itemId}`)).not.toBeNull());
  expect(screen.queryByText(item.title)).not.toBeNull();
  expect((await snapshot()).commitments).toEqual([]);
  expect(exchanges.map(item => item.path)).toEqual(['/api/mobile/capture']);

  // The same proposal is not confirmable as another account, even when that
  // caller supplies the first account's scope in the body.
  const foreign = await httpFetch(`${host.baseUrl}/api/mobile/capture/confirm`, {
    method: 'POST', headers: { Authorization: `Bearer ${host.otherToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ proposalId: proposal.proposalId, itemIds: [item.itemId], scopeId: host.uid }),
  });
  expect(foreign.status).toBe(404);
  expect((await snapshot(host.otherUid)).commitments).toEqual([]);

  await fireEvent.press(screen.getByTestId('review-confirm'));
  await waitFor(() => expect(screen.queryByTestId('saved-title')).not.toBeNull(), { timeout: 5_000 });
  const confirmation = exchanges.find(item => item.path === '/api/mobile/capture/confirm')!;
  expect(confirmation.status).toBe(200);
  expect(confirmation.body).toMatchObject({ proposalId: proposal.proposalId, itemIds: [item.itemId] });
  const saved = captureConfirmationSchema.parse(confirmation.response);
  expect(saved.success).toBe(true);
  expect(saved.persisted).toHaveLength(1);
  expect((await snapshot()).commitments).toEqual([
    expect.objectContaining({ id: saved.persisted[0]!.commitmentId, title: item.title, status: 'active' }),
  ]);
  expect(exchanges.filter(item => item.path === '/api/mobile/capture/confirm')).toHaveLength(1);
  expect((await snapshot(host.otherUid)).commitments).toEqual([]);
}, 15_000);

it('routes a typed chat answer to clarification and saves only after the reviewed answer is confirmed', async () => {
  const proposal = await openAndAnalyze('Remind me to call Dana');
  const item = proposal.items.find(candidate => candidate.clarification)!;
  expect(item).toBeDefined();
  await waitFor(() => expect(screen.queryByTestId('clarify-sheet')).not.toBeNull());
  const question = item.clarification!;
  await fireEvent.changeText(screen.getByTestId('capture-input'), 'Tomorrow at 5pm');
  await fireEvent.press(screen.getByTestId('capture-analyze'));
  await waitFor(() => expect(screen.queryByTestId('clarify-sheet')).toBeNull(), { timeout: 5_000 });
  const clarified = exchanges.find(exchange => exchange.path === '/api/mobile/capture/clarify')!;
  expect(clarified.status).toBe(200);
  expect(clarified.body).toMatchObject({ proposalId: proposal.proposalId, itemId: item.itemId, questionId: question.questionId, freeText: 'Tomorrow at 5pm' });
  const updated = captureProposalSchema.parse(clarified.response);
  expect(updated.items.find(candidate => candidate.itemId === item.itemId)?.needsClarification).toBe(false);
  expect((await snapshot()).commitments).toEqual([]);
  expect(screen.getByTestId('review-confirm').props.accessibilityState.disabled).toBe(false);
  await fireEvent.press(screen.getByTestId('review-confirm'));
  await waitFor(() => expect(screen.queryByTestId('saved-title')).not.toBeNull(), { timeout: 5_000 });
  expect((await snapshot()).commitments).toHaveLength(1);
  expect(exchanges.map(exchange => exchange.path)).toEqual([
    '/api/mobile/capture', '/api/mobile/capture/clarify', '/api/mobile/capture/confirm',
  ]);
}, 15_000);

it('a declined draft replacement preserves the reviewed priority until explicit save', async () => {
  const proposal = await openAndAnalyze('Water the plants tomorrow at 3pm');
  const item = proposal.items[0]!;
  expect(item.priority).not.toBe('high');
  await waitFor(() => expect(screen.queryByTestId(`review-item-${item.itemId}`)).not.toBeNull());
  await setPriorityHigh(item.itemId);
  expect(exchanges.map(exchange => exchange.path)).toEqual(['/api/mobile/capture']);

  await fireEvent.changeText(screen.getByTestId('capture-input'), 'Call Dana tomorrow at 5pm');
  expect(screen.queryByTestId(`review-item-${item.itemId}`)).not.toBeNull();
  await fireEvent.press(screen.getByTestId('capture-analyze'));
  await waitFor(() => expect(screen.queryByTestId('chat-replace-draft')).not.toBeNull());
  expect((await snapshot()).commitments).toEqual([]);
  expect(exchanges.map(exchange => exchange.path)).toEqual(['/api/mobile/capture']);
  await fireEvent.press(screen.getByTestId('chat-replace-keep'));
  await waitFor(() => expect(screen.queryByTestId(`review-item-${item.itemId}`)).not.toBeNull());
  await fireEvent.press(screen.getByTestId('review-confirm'));
  await waitFor(() => expect(screen.queryByTestId('saved-title')).not.toBeNull(), { timeout: 5_000 });
  const confirmation = exchanges.find(exchange => exchange.path === '/api/mobile/capture/confirm')!;
  expect(confirmation.body.edits).toEqual(expect.arrayContaining([
    expect.objectContaining({ itemId: item.itemId, priority: 'high' }),
  ]));
  expect((await snapshot()).commitments).toEqual([
    expect.objectContaining({ title: item.title, priority: 'high' }),
  ]);
  expect(exchanges.map(exchange => exchange.path)).toEqual(['/api/mobile/capture', '/api/mobile/capture/confirm']);
}, 15_000);

it('enforces the answer bound and keeps a new draft when a sheet option answers the old item', async () => {
  const proposal = await openAndAnalyze('Remind me to call Dana');
  const item = proposal.items.find(candidate => candidate.clarification)!;
  expect(item).toBeDefined();
  await waitFor(() => expect(screen.queryByTestId('clarify-sheet')).not.toBeNull());
  await fireEvent.changeText(screen.getByTestId('capture-input'), 'x'.repeat(201));
  expect(screen.getByTestId('capture-analyze').props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(screen.getByTestId('capture-analyze'));
  expect(exchanges.map(exchange => exchange.path)).toEqual(['/api/mobile/capture']);

  const newDraft = 'Buy milk on the way home';
  await fireEvent.changeText(screen.getByTestId('capture-input'), newDraft);
  const option = item.clarification!.options.find(candidate => !candidate.value.localTime && !candidate.value.localDate)!;
  expect(option).toBeDefined();
  await fireEvent.press(screen.getByTestId(`clarify-option-${option.optionId}`));
  await waitFor(() => expect(screen.queryByTestId('clarify-sheet')).toBeNull(), { timeout: 5_000 });
  expect(screen.getByTestId('capture-input').props.value).toBe(newDraft);
  const clarified = exchanges.find(exchange => exchange.path === '/api/mobile/capture/clarify')!;
  expect(clarified.status).toBe(200);
  expect(clarified.body).toMatchObject({ proposalId: proposal.proposalId, itemId: item.itemId, optionId: option.optionId });
  expect(clarified.body.freeText).toBeUndefined();

  await fireEvent.press(screen.getByTestId('capture-analyze'));
  await waitFor(() => expect(screen.queryByTestId('chat-replace-draft')).not.toBeNull());
  expect(exchanges.map(exchange => exchange.path)).toEqual(['/api/mobile/capture', '/api/mobile/capture/clarify']);
  expect((await snapshot()).commitments).toEqual([]);
}, 15_000);

it('only an explicitly approved replacement sends the new draft and confirms its new proposal', async () => {
  const original = await openAndAnalyze('Water the plants tomorrow at 3pm');
  const oldItem = original.items[0]!;
  await waitFor(() => expect(screen.queryByTestId(`review-item-${oldItem.itemId}`)).not.toBeNull());
  await setPriorityHigh(oldItem.itemId);
  const replacement = 'Call Dana tomorrow at 5pm';
  await fireEvent.changeText(screen.getByTestId('capture-input'), replacement);
  await fireEvent.press(screen.getByTestId('capture-analyze'));
  await waitFor(() => expect(screen.queryByTestId('chat-replace-draft')).not.toBeNull());
  expect(exchanges).toHaveLength(1);
  expect((await snapshot()).commitments).toEqual([]);
  await fireEvent.press(screen.getByTestId('chat-replace-confirm'));
  await waitFor(() => expect(exchanges.filter(exchange => exchange.path === '/api/mobile/capture')).toHaveLength(2), { timeout: 5_000 });
  const second = exchanges.filter(exchange => exchange.path === '/api/mobile/capture')[1]!;
  expect(second.body.text).toBe(replacement);
  const proposal = captureProposalSchema.parse(second.response);
  expect(proposal.proposalId).not.toBe(original.proposalId);
  const item = proposal.items[0]!;
  await waitFor(() => expect(screen.queryByTestId(`review-item-${item.itemId}`)).not.toBeNull());
  expect(screen.queryByTestId(`review-item-${oldItem.itemId}`)).toBeNull();
  expect((await snapshot()).commitments).toEqual([]);
  await fireEvent.press(screen.getByTestId('review-confirm'));
  await waitFor(() => expect(screen.queryByTestId('saved-title')).not.toBeNull(), { timeout: 5_000 });
  const confirmed = exchanges.find(exchange => exchange.path === '/api/mobile/capture/confirm')!;
  expect(confirmed.body.proposalId).toBe(proposal.proposalId);
  expect((await snapshot()).commitments).toEqual([
    expect.objectContaining({ title: item.title, priority: item.priority }),
  ]);
}, 15_000);
