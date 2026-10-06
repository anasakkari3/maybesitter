import React from 'react';
import { expect, jest } from '@jest/globals';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import type { AuthUser } from '../../auth/types';
import type { CaptureChatAnswer, CaptureProposal } from '../../api/schemas/capture';
import * as captureEndpoints from '../../api/endpoints/capture';
import {
  openCapture as openCaptureRoot,
  prepareRoot as prepareRootM2a,
  say,
  type RootHarness,
} from '../m2a/harness';

export { say, type RootHarness };

export const ACCOUNT_A: AuthUser = {
  uid: 'm2b-account-a',
  email: 'a@example.com',
  emailVerified: true,
  displayName: null,
  providerIds: ['password'],
};

export const ACCOUNT_B: AuthUser = {
  ...ACCOUNT_A,
  uid: 'm2b-account-b',
  email: 'b@example.com',
};

export const ITEM_ID = 'm2b-item-1';
export const SEED_ID = 'm2b-seed-1';
export const PROPOSAL_ID = 'm2b-proposal-1';
export const CONVERSATION_ID = 'm2b-conversation-1';
export const START = '2030-01-08T09:00:00.000Z';
export const END = '2030-01-08T10:30:00.000Z';

export async function prepareRoot(language: 'ar' | 'en' = 'en'): Promise<RootHarness> {
  const harness = await prepareRootM2a(language);
  harness.repository.emit(ACCOUNT_A);
  return harness;
}

export async function openCapture(harness: RootHarness): Promise<void> {
  await openCaptureRoot(harness);
}

export function commitmentProposal(overrides: Partial<CaptureProposal> = {}): CaptureProposal {
  return {
    version: 'v1',
    proposalId: PROPOSAL_ID,
    revision: 7,
    status: 'proposed',
    items: [{
      itemId: ITEM_ID,
      title: 'Call Dana',
      resolvedTime: START,
      endTime: END,
      needsClarification: false,
      priority: 'normal',
    }],
    seeds: [],
    understood: [{ kind: 'commitment', itemId: ITEM_ID, text: 'Call Dana tomorrow' }],
    ...overrides,
  };
}

export function seedProposal(
  kind: 'possible_goal' | 'consideration' | 'idea' | 'waiting_for' = 'idea',
  overrides: Partial<CaptureProposal> = {},
): CaptureProposal {
  return {
    version: 'v1',
    proposalId: PROPOSAL_ID,
    revision: 7,
    status: 'unresolved_intent',
    items: [],
    seeds: [{ seedItemId: SEED_ID, kind, summary: 'Learn pottery' }],
    understood: [{ kind, seedItemId: SEED_ID, text: 'Learn pottery' }],
    ...overrides,
  };
}

export function answerFor(
  proposal: CaptureProposal | null,
  message = 'First message',
  conversationId = CONVERSATION_ID,
): CaptureChatAnswer {
  return {
    conversationId,
    reply: proposal ? 'I understood this.' : 'What should I capture?',
    engine: 'rules',
    proposal,
    turns: [
      { role: 'user', text: message },
      { role: 'assistant', text: proposal ? 'I understood this.' : 'What should I capture?' },
    ],
  };
}

export function installChatAnswer(proposal: CaptureProposal | null) {
  return jest.spyOn(captureEndpoints, 'chatCapture').mockImplementation((async (raw: unknown) => {
    const input = raw as { message?: string; conversationId?: string | null };
    return answerFor(proposal, input.message ?? 'First message', input.conversationId ?? CONVERSATION_ID);
  }) as never);
}

export async function showProposal(
  harness: RootHarness,
  proposal: CaptureProposal = commitmentProposal(),
  message = 'First message',
): Promise<ReturnType<typeof installChatAnswer>> {
  const chat = installChatAnswer(proposal);
  await openCapture(harness);
  await say(message);
  await waitFor(() => expect(screen.queryByTestId('understood-line-1')).not.toBeNull());
  return chat;
}

export async function press(testID: string): Promise<void> {
  await act(async () => { await fireEvent.press(screen.getByTestId(testID)); });
}

export async function changeText(testID: string, value: string): Promise<void> {
  await act(async () => { await fireEvent.changeText(screen.getByTestId(testID), value); });
}

export function lastCall(spy: { mock: { calls: readonly unknown[][] } }): Record<string, unknown> {
  const call = spy.mock.calls.at(-1);
  expect(call).toBeDefined();
  return call![0] as Record<string, unknown>;
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
