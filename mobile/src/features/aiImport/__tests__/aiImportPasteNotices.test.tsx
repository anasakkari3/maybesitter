/**
 * The paste step's notices say what happened, and only that (de7fcb84 audit).
 *
 * - CXA8.12: a paste of exactly 20,000 characters was cut by nothing, yet
 *   said «أطول من اللي بنقدر نقراه. منستعمل أول 20000 حرف.» — the check was
 *   `>=` on a text the paste had already sliced, so a real cut and an exact
 *   fit looked the same.
 * - CA8.5: the daily limit (429) showed «جبت سياق كذا مرة اليوم» and, under
 *   it, «ما انحفظ. ولا إشي تغيّر.» for a step that saves nothing.
 */
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true), getStringAsync: jest.fn(async () => '') }));
jest.mock('../../../../modules/universal-link', () => ({
  universalLinkNativeModule: () => ({ openUniversalLink: async () => false }),
}));
const mockImport: { error: unknown; sent: string[]; fail: unknown } = { error: null, sent: [], fail: null };
jest.mock('../../../api/queries', () => ({
  useImportAiContext: () => ({
    mutate: (vars: { text: string }, handlers: { onError?: (e: unknown) => void }) => {
      mockImport.sent.push(vars.text);
      if (mockImport.fail) { mockImport.error = mockImport.fail; handlers.onError?.(mockImport.fail); }
    },
    isPending: false,
    get error() { return mockImport.error; },
  }),
  useConfirmAiContextImport: () => ({ mutate: jest.fn(), isPending: false, error: null }),
}));

import React from 'react';
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { getStringAsync } from 'expo-clipboard';
import { AppProvider } from '../../../state/AppContext';
import { AiImportFlow } from '../AiImportFlow';
import { MAX_IMPORT_LENGTH } from '../importLimits';
import { QuotaExceededError } from '../../../api/errors';

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const pasteboard = getStringAsync as unknown as jest.Mock<() => Promise<string>>;

async function toPasteStep() {
  await render(<SafeAreaProvider initialMetrics={metrics}><AppProvider><AiImportFlow onDone={() => undefined} onCancel={() => undefined} /></AppProvider></SafeAreaProvider>);
  await fireEvent.press(screen.getByTestId('ai-import-pick-other'));
  await fireEvent.press(screen.getByTestId('ai-import-go'));
  await waitFor(() => expect(screen.getByTestId('ai-import-paste')).toBeTruthy());
}

async function paste(text: string) {
  pasteboard.mockImplementation(async () => text);
  await act(async () => { await fireEvent.press(screen.getByTestId('ai-import-paste')); });
  await waitFor(() => expect(screen.getByTestId('ai-import-paste-preview')).toBeTruthy());
}

beforeEach(() => { mockImport.error = null; mockImport.sent = []; mockImport.fail = null; });
afterEach(async () => { await cleanup(); pasteboard.mockReset(); });

it('CXA8.12: a paste of exactly the limit is not called cut', async () => {
  await toPasteStep();
  await paste('a'.repeat(MAX_IMPORT_LENGTH));
  expect(screen.queryByTestId('ai-import-paste-truncated')).toBeNull();
});

it('CXA8.12: a paste over the limit is said to be cut, and only its first part is read', async () => {
  await toPasteStep();
  await paste('a'.repeat(MAX_IMPORT_LENGTH) + 'bbbbb');
  expect(screen.getByTestId('ai-import-paste-truncated')).toBeTruthy();
  expect(String(screen.getByTestId('ai-import-paste-preview').props.children)).toHaveLength(MAX_IMPORT_LENGTH);
  await act(async () => { await fireEvent.press(screen.getByTestId('ai-import-read')); });
  expect(mockImport.sent).toEqual(['a'.repeat(MAX_IMPORT_LENGTH)]);
});

it('CA8.5: the daily limit is said once, without «not saved» under it', async () => {
  await toPasteStep();
  await paste('I live in Haifa.');
  mockImport.fail = new QuotaExceededError('feature_daily' as never, 3600);
  await act(async () => { await fireEvent.press(screen.getByTestId('ai-import-read')); });
  await waitFor(() => expect(screen.getByTestId('ai-import-refused')).toBeTruthy());
  expect(screen.queryByTestId('ai-import-read-failed')).toBeNull();
});

it('CA8.5: any other failure still says it did not go through', async () => {
  await toPasteStep();
  await paste('I live in Haifa.');
  mockImport.fail = new Error('boom');
  await act(async () => { await fireEvent.press(screen.getByTestId('ai-import-read')); });
  await waitFor(() => expect(screen.getByTestId('ai-import-read-failed')).toBeTruthy());
  expect(screen.queryByTestId('ai-import-refused')).toBeNull();
});
