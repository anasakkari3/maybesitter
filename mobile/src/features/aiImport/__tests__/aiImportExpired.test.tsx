/**
 * QA CA1.5: a confirm answered 404 `proposal_not_found` (the review was open
 * past its thirty minutes, or a lost response after the server had saved)
 * said «ما انحفظ. ولا إشي تغيّر.» and offered the same doomed retry forever.
 * It now says the review can no longer be saved from, where to check, and
 * goes back to the paste step.
 */
import React from 'react';
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider } from '../../../state/AppContext';
import { strings } from '../../../i18n/strings';
import { NetworkError, NotFoundError } from '../../../api/errors';
import { AiImportFlow } from '../AiImportFlow';

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(async () => true),
  getStringAsync: jest.fn(async () => 'I am a nurse.\nI swim on Mondays.'),
}));
jest.mock('../../../../modules/universal-link', () => ({
  universalLinkNativeModule: () => ({ openUniversalLink: async () => false }),
}));
let mockConfirmError: unknown = null;
const mockConfirm = jest.fn();
jest.mock('../../../api/queries', () => ({
  useMemory: () => ({ data: undefined }),
  useImportAiContext: () => ({
    isPending: false, error: null,
    mutate: (_vars: unknown, handlers: { onSuccess: (proposal: unknown) => void }) => handlers.onSuccess({
      success: true, proposalId: 'p-1', assistant: 'other',
      candidates: [{ kind: 'fact', category: 'work_study', content: 'Works as a nurse', confidence: 0.9, relation: 'new', relatesToId: null }],
      summary: { new: 1, updates: 0, conflicts: 0 },
      existingConsidered: 0, existingTotal: 0, existingTruncated: false,
      createdAt: '2026-11-12T08:00:00.000Z', promptVersion: 'ai-context-import-v2', model: null,
    }),
  }),
  useConfirmAiContextImport: () => ({
    isPending: false, error: null,
    mutate: (vars: unknown, handlers: { onError: (error: unknown) => void }) => { mockConfirm(vars); handlers.onError(mockConfirmError); },
  }),
}));

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const copy = () => Object.values(strings).find(t => screen.queryAllByText(t.aiImportPickTitle).length > 0
  || screen.queryAllByText(t.aiImportReviewTitle).length > 0)!;

beforeEach(() => { mockConfirm.mockClear(); });
afterEach(async () => { await cleanup(); });

async function reachReviewAndSave() {
  await render(<SafeAreaProvider initialMetrics={metrics}><AppProvider><AiImportFlow onDone={() => undefined} onCancel={() => undefined} /></AppProvider></SafeAreaProvider>);
  const t = copy();
  await fireEvent.press(screen.getByTestId('ai-import-pick-other'));
  await fireEvent.press(screen.getByTestId('ai-import-go'));
  await waitFor(() => expect(screen.getByTestId('ai-import-paste')).toBeTruthy());
  await fireEvent.press(screen.getByTestId('ai-import-paste'));
  await waitFor(() => expect(screen.getByTestId('ai-import-paste-preview')).toBeTruthy());
  await fireEvent.press(screen.getByTestId('ai-import-read'));
  await waitFor(() => expect(screen.getByTestId('ai-import-keep-all')).toBeTruthy());
  await fireEvent.press(screen.getByTestId('ai-import-keep-all'));
  await waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(1));
  return t;
}

it('a review that is gone sends the person back to paste, saying so, instead of a retry that cannot work', async () => {
  mockConfirmError = new NotFoundError('proposal not found');
  const t = await reachReviewAndSave();
  await waitFor(() => expect(screen.getByTestId('ai-import-expired')).toBeTruthy());
  expect(screen.getByText(t.aiImportExpired)).toBeTruthy();
  expect(screen.queryByTestId('ai-import-save-failed')).toBeNull();
  expect(screen.queryByTestId('ai-import-keep-all')).toBeNull();
  expect(screen.getByTestId('ai-import-paste')).toBeTruthy();
});

it('any other failure keeps the review and its retry', async () => {
  mockConfirmError = new NetworkError('no signal');
  await reachReviewAndSave();
  await waitFor(() => expect(screen.getByTestId('ai-import-save-failed')).toBeTruthy());
  expect(screen.getByTestId('ai-import-keep-all')).toBeTruthy();
  expect(screen.queryByTestId('ai-import-expired')).toBeNull();
});
