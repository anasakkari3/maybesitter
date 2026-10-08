import { expect, jest } from '@jest/globals';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import type { AuthUser } from '../../auth/types';
import * as seedEndpoints from '../../api/endpoints/seeds';
import {
  ACCOUNT_A,
  ACCOUNT_B,
  M3aServer,
  defaultReply,
  prepare,
  press,
  renderRoot,
  teardown,
  type M3aHarness,
  type RecordedRequest,
  type RouteReply,
} from '../m3a/harness';

export { ACCOUNT_A, ACCOUNT_B, defaultReply, press, teardown };
export type { M3aHarness, RecordedRequest, RouteReply };

export type M3bHarness = M3aHarness;

export async function prepareM3b(language: 'ar' | 'en' = 'en'): Promise<M3bHarness> {
  const harness = await prepare(language, new M3aServer());
  jest.spyOn(seedEndpoints, 'listSeeds').mockResolvedValue({ items: [] } as never);
  return harness;
}

export async function openThings(harness: M3bHarness): Promise<void> {
  await renderRoot(harness);
  await press('tab-things');
  await screen.findByTestId('things-root');
}

export async function openProduct(harness: M3bHarness, row: 'things-goals' | 'things-habits' | 'things-ideas'): Promise<void> {
  await openThings(harness);
  await press(row);
}

export async function openWatching(harness: M3bHarness): Promise<void> {
  await renderRoot(harness);
  await press('tab-watching');
  await screen.findByTestId('watching-root');
}

export async function openGenericCapture(harness: M3bHarness): Promise<void> {
  await renderRoot(harness);
  await press('tab-capture');
  await screen.findByTestId('capture-input');
}

export async function say(message = 'First message'): Promise<void> {
  await act(async () => {
    await fireEvent.changeText(screen.getByTestId('capture-input'), message);
  });
  await press('capture-analyze');
}

export async function openCards(): Promise<void> {
  const summary = screen.queryByTestId('understood-confirm');
  if (summary) await press('understood-confirm');
}

export function replyFor(path: RegExp, reply: RouteReply, fallback = defaultReply) {
  return (request: RecordedRequest): RouteReply => path.test(request.path) ? reply : fallback(request);
}

export function withKinds(
  entries: readonly ('goal' | 'habit' | 'thought')[],
  next: (request: RecordedRequest) => RouteReply = defaultReply,
) {
  return (request: RecordedRequest): RouteReply => request.method === 'GET' && request.path.endsWith('/capture/kinds')
    ? { status: 200, body: { success: true, entries } }
    : next(request);
}

export function kindsUnavailable(next: (request: RecordedRequest) => RouteReply = defaultReply) {
  return (request: RecordedRequest): RouteReply => request.method === 'GET' && request.path.endsWith('/capture/kinds')
    ? { status: 404, body: { success: false, error: 'not found', reason: 'feature_unavailable' } }
    : next(request);
}

export function lastRequest(harness: M3bHarness, method: string, path: RegExp): RecordedRequest {
  const request = harness.server.matching(method, path).at(-1);
  expect(request).toBeDefined();
  return request!;
}

export async function waitForRequest(harness: M3bHarness, method: string, path: RegExp, count = 1): Promise<void> {
  await waitFor(() => expect(harness.server.matching(method, path)).toHaveLength(count));
}

export function emitAccount(harness: M3bHarness, user: AuthUser): void {
  act(() => harness.repository.emit(user));
}
