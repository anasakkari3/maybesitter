/**
 * «تصدير بياناتي» (#174 step 7): the row fetches the real route's envelope,
 * hands a file to the share sheet, and leaves no file behind.
 *
 * Driven through the real `apiRequest` and the shipped schema, with the
 * fixture `exportMobileApiFixtures.test.ts` records from the route, and the
 * real `shareExportFile` over a mocked filesystem — so "the file is gone after
 * the sheet closes" is asserted against what was actually written.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider } from '../../../state/AppContext';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { ExportDataRow } from '../ExportDataRow';
import { capabilities } from '../../product/capabilities';
import exported from '../../../api/__fixtures__/account.export.json';
import en from '../../../i18n/locales/en.json';

const mockFiles = new Map<string, string>();

jest.mock('expo-file-system', () => {
  class MockFile {
    uri: string;
    name: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts.map((part) => (typeof part === 'string' ? part : part.uri)).join('/');
      this.name = this.uri.split('/').pop() ?? '';
    }
    get exists(): boolean { return mockFiles.has(this.uri); }
    create(): void { mockFiles.set(this.uri, ''); }
    write(text: string): void { mockFiles.set(this.uri, text); }
    delete(): void { mockFiles.delete(this.uri); }
  }
  return {
    __esModule: true,
    File: MockFile,
    Paths: {
      get cache() {
        return {
          uri: 'file:///cache',
          list: () => [...mockFiles.keys()].map((uri) => new MockFile(uri)),
        };
      },
    },
  };
});

const mockShareAsync = jest.fn(async (_uri: string, _options: unknown) => undefined);
jest.mock('expo-sharing', () => ({
  __esModule: true,
  isAvailableAsync: async () => true,
  shareAsync: (uri: string, options: unknown) => mockShareAsync(uri, options),
}));

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
let responses: { status: number; body: unknown }[];
let urls: string[];

beforeEach(() => {
  mockFiles.clear();
  urls = [];
  setAuthRepository(createFakeAuthRepository({ initialUser: { uid: 'u1', email: null, emailVerified: true, displayName: null, providerIds: ['password'] } }));
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3000';
  responses = [{ status: 200, body: exported }];
  (globalThis as { fetch: unknown }).fetch = jest.fn(async (url: string) => {
    urls.push(url);
    const next = responses.shift() ?? { status: 500, body: {} };
    return { status: next.status, headers: { get: () => null }, text: async () => JSON.stringify(next.body) };
  }) as never;
});

afterEach(() => {
  cleanup();
  resetAuthForTests();
  jest.restoreAllMocks();
});

async function show(share?: (uri: string, options: { mimeType: string; UTI: string; dialogTitle: string }) => Promise<void>) {
  await render(
    <SafeAreaProvider initialMetrics={metrics}>
      <AppProvider>
        <ExportDataRow share={share} />
      </AppProvider>
    </SafeAreaProvider>,
  );
}

describe('export my data', () => {
  it('is live, and pressing it shares the server\'s export as a JSON file that is then deleted', async () => {
    expect(capabilities.export).toBe('LIVE');
    const shared: { uri: string; contents: string | undefined; mimeType: string }[] = [];
    await show(async (uri, options) => {
      // What the sheet is handed is the file as it stands while it is open.
      shared.push({ uri, contents: mockFiles.get(uri), mimeType: options.mimeType });
    });

    await fireEvent.press(screen.getByTestId('export-my-data'));

    await waitFor(() => expect(shared).toHaveLength(1));
    expect(urls).toEqual(['http://localhost:3000/api/mobile/account/export']);
    expect(shared[0]!.mimeType).toBe('application/json');
    expect(shared[0]!.uri).toMatch(/^file:\/\/\/cache\/maybesitter-export-\d{4}-\d{2}-\d{2}\.json$/);
    expect(JSON.parse(shared[0]!.contents!)).toEqual(exported);
    // Gone once the sheet closed: no copy of the account stays on the phone.
    await waitFor(() => expect(mockFiles.size).toBe(0));
    expect(screen.getByText(en.exportDataBody)).toBeTruthy();
  });

  it('removes the file even when the share sheet fails, and says the export did not work', async () => {
    await show(async () => { throw new Error('sheet refused'); });
    await fireEvent.press(screen.getByTestId('export-my-data'));
    await waitFor(() => expect(screen.getByText(en.exportDataFailed)).toBeTruthy());
    expect(mockFiles.size).toBe(0);
  });

  it('says the account is too large on a 413, and writes nothing', async () => {
    responses = [{ status: 413, body: { success: false, error: 'export too large', reason: 'export_too_large' } }];
    const share = jest.fn(async () => undefined);
    await show(share);
    await fireEvent.press(screen.getByTestId('export-my-data'));
    await waitFor(() => expect(screen.getByText(en.exportDataTooLarge)).toBeTruthy());
    expect(share).not.toHaveBeenCalled();
    expect(mockFiles.size).toBe(0);
  });

  it('says the daily limit is reached on a 429 export_rate_limited, and writes nothing', async () => {
    responses = [{ status: 429, body: { success: false, error: 'too many exports today', reason: 'export_rate_limited', maxPerDay: 3 } }];
    const share = jest.fn(async () => undefined);
    await show(share);
    await fireEvent.press(screen.getByTestId('export-my-data'));
    await waitFor(() => expect(screen.getByText(en.exportDataRateLimited)).toBeTruthy());
    expect(share).not.toHaveBeenCalled();
    expect(mockFiles.size).toBe(0);
  });

  it('sweeps an export a killed process left behind before writing the next', async () => {
    mockFiles.set('file:///cache/maybesitter-export-2026-01-01.json', '{"left":"behind"}');
    mockFiles.set('file:///cache/someone-elses-file.json', 'keep');
    await show(async () => undefined);
    await fireEvent.press(screen.getByTestId('export-my-data'));
    await waitFor(() => expect([...mockFiles.keys()]).toEqual(['file:///cache/someone-elses-file.json']));
  });

  it('a second press while one export runs does not start another', async () => {
    let release: () => void = () => undefined;
    const share = jest.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    await show(share);
    await fireEvent.press(screen.getByTestId('export-my-data'));
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect(screen.getByText(en.exportDataPreparing)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('export-my-data'));
    release();
    await waitFor(() => expect(screen.getByText(en.exportDataBody)).toBeTruthy());
    expect(urls).toHaveLength(1);
    expect(share).toHaveBeenCalledTimes(1);
  });

  it('opens the system share sheet through expo-sharing when nothing is injected', async () => {
    mockShareAsync.mockClear();
    await show();
    await fireEvent.press(screen.getByTestId('export-my-data'));
    await waitFor(() => expect(mockShareAsync).toHaveBeenCalledTimes(1));
    const [uri, options] = mockShareAsync.mock.calls[0]!;
    expect(uri).toMatch(/maybesitter-export-.*\.json$/);
    expect(options).toEqual({ mimeType: 'application/json', UTI: 'public.json', dialogTitle: en.exportDataShareTitle });
    await waitFor(() => expect(mockFiles.size).toBe(0));
  });
});
