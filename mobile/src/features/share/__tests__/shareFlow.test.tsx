/**
 * A share, from the moment another app hands it over (UC-3.0, #183).
 *
 * ── Why this renders `Root` ──────────────────────────────────────
 *
 * The same reason `captureFlowReachable.test.tsx` does. A normaliser, a
 * provider and a screen can all be built, unit-tested and green while nothing
 * mounts any of them — which is exactly how UC-2.R2 was found to be
 * unreachable. So this starts where the OS starts: an intent arrives at the
 * native module, and the assertion is that the app ends up somewhere.
 *
 * ── The two native modules are mocked, and they are the two that matter ──
 *
 * `expo-share-intent` because there is no share sheet in a jest run, and
 * `expo-file-system` because the criterion is about files being *gone*. The
 * file mock is a set of paths, so "no copy remains" is an assertion about a set
 * rather than about a mock having been called — a mock that was called proves
 * the code ran, not that the file is not there.
 *
 * What this cannot prove is on the device: that the iOS extension wrote into
 * the App Group at all, that the Android chooser lists MaybeSitter, or that a
 * cold start routes the same way as a warm one. Those need an EAS build.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { Root } from '../../../Root';
import en from '../../../i18n/locales/en.json';
import { NetworkError, UnsupportedShareError, UploadTooLargeError } from '../../../api/errors';
import * as shareEndpoints from '../../../api/endpoints/share';
import * as captureEndpoints from '../../../api/endpoints/capture';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as trustEndpoints from '../../../api/endpoints/trust';
import * as consentEndpoints from '../../../api/endpoints/consents';

/* ── The two native modules ───────────────────────────────────────── */

const mockEmptyIntent = { files: null, text: null, webUrl: null, type: null };

/**
 * The share the mocked native module is currently holding.
 *
 * `emit` is registered by the mocked provider on mount, so a case can deliver a
 * *warm* share — one that arrives while the app is already open — as well as
 * the cold-start one the initial value covers.
 */
const mockShareIntent: {
  value: Record<string, unknown>;
  emit: ((intent: Record<string, unknown>) => void) | null;
  resets: number;
} = { value: mockEmptyIntent, emit: null, resets: 0 };

/** Every file the OS has copied out for us, by uri. Emptied by `delete()`. */
const mockFiles = new Set<string>();

jest.mock('expo-share-intent', () => {
  const R = require('react') as typeof import('react');
  const Ctx = R.createContext<{
    hasShareIntent: boolean;
    shareIntent: Record<string, unknown>;
    resetShareIntent: () => void;
  }>({ hasShareIntent: false, shareIntent: mockEmptyIntent, resetShareIntent: () => {} });
  return {
    __esModule: true,
    ShareIntentProvider: ({ children }: { children: React.ReactNode }) => {
      const [intent, setIntent] = R.useState(mockShareIntent.value);
      R.useEffect(() => {
        mockShareIntent.emit = setIntent;
        return () => { mockShareIntent.emit = null; };
      }, []);
      const value = R.useMemo(() => ({
        hasShareIntent: Boolean(intent.text || intent.webUrl || intent.files),
        shareIntent: intent,
        // The real one nils a key in the App Group's UserDefaults and leaves
        // the files exactly where they are. So does this.
        resetShareIntent: () => { mockShareIntent.resets += 1; setIntent(mockEmptyIntent); },
      }), [intent]);
      return R.createElement(Ctx.Provider, { value }, children);
    },
    useShareIntentContext: () => R.useContext(Ctx),
  };
});

jest.mock('expo-file-system', () => ({
  __esModule: true,
  File: class {
    uri: string;
    constructor(uri: string) { this.uri = uri; }
    get exists(): boolean { return mockFiles.has(this.uri); }
    delete(): void { mockFiles.delete(this.uri); }
  },
}));

/* ── The harness ──────────────────────────────────────────────────── */

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = {
  uid: 'share-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;
let originalFlag: string | undefined;

/**
 * Derived from the clock the test runs on, never written as a literal.
 *
 * A literal instant is a claim about the real calendar, and these fixtures flow
 * into a review screen whose edit guard refuses a time that has passed. #382 is
 * what that costs: three tests that were correct until midnight walked past
 * them and then red every day after.
 */
const inSixHours = () => new Date(Date.now() + 6 * 3_600_000).toISOString();

function shareProposal(over: Record<string, unknown> = {}) {
  return {
    version: 'v1',
    proposalId: 'p-share',
    status: 'proposed',
    items: [{
      itemId: 'i-1',
      title: 'Pay the nursery on Thursday',
      resolvedTime: inSixHours(),
      needsClarification: false,
    }],
    provenance: { requestedEngine: 'rules', executedEngine: 'rule-based', fallbackUsed: false },
    share: { channel: 'plain-text', kind: 'text', fileCount: 0, ignoredSegments: 0, suggestedNextAction: null },
    ...over,
  };
}

function sharedFile(over: Record<string, unknown> = {}) {
  return {
    fileName: 'WhatsApp Chat with Dana.zip',
    mimeType: 'application/zip',
    path: 'file:///tmp/share/chat.zip',
    size: 4096,
    width: null,
    height: null,
    duration: null,
    ...over,
  };
}

beforeEach(() => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  mockShareIntent.value = mockEmptyIntent;
  mockShareIntent.emit = null;
  mockShareIntent.resets = 0;
  mockFiles.clear();
  originalFlag = process.env.EXPO_PUBLIC_FEATURE_SHARE_INTAKE;
  process.env.EXPO_PUBLIC_FEATURE_SHARE_INTAKE = 'true';
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  jest.spyOn(trustEndpoints, 'getTrust')
    .mockResolvedValue({ success: true, participantId: 'share-user', trust: { analyticsConsent: false } } as never);
  grantAi('granted');
});

/**
 * What the server says about this account's AI consent.
 *
 * `asked` matters as much as the state: while the answer is still loading both
 * are falsy, and a gate that refused then would show the notice to somebody who
 * has in fact agreed.
 */
function grantAi(state: 'granted' | 'declined') {
  jest.spyOn(consentEndpoints, 'getConsents').mockResolvedValue({
    aiProcessing: { state, asked: true, version: 'v1', decidedAt: '2026-08-01T00:00:00.000Z' },
    recommendations: { state: 'declined', asked: true, version: 'v1', decidedAt: '2026-08-01T00:00:00.000Z' },
    currentVersions: { aiProcessing: 'v1', recommendations: 'v1' },
  } as never);
}

afterEach(() => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  if (originalFlag === undefined) delete process.env.EXPO_PUBLIC_FEATURE_SHARE_INTAKE;
  else process.env.EXPO_PUBLIC_FEATURE_SHARE_INTAKE = originalFlag;
});

async function openApp() {
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
}

/**
 * Hands the app a share the way the native module does.
 *
 * Cold start and warm start are the *same callback* — `useShareIntent`
 * subscribes to `onChange` and the module fires it either way — so this is both
 * paths as far as JavaScript can tell. Which of the two the OS actually takes,
 * and whether the extension wrote the file at all, is a device question; it is
 * in the manual half of #183's test plan and needs an EAS build.
 */
async function deliverShare(intent: Record<string, unknown>) {
  for (const file of (intent.files as { path: string }[] | null) ?? []) mockFiles.add(file.path);
  await waitFor(() => expect(mockShareIntent.emit).not.toBeNull());
  await act(async () => { mockShareIntent.emit?.(intent); });
  await waitFor(() => expect(screen.queryByTestId('share-screen')).not.toBeNull());
}

/** The whole entry: open the app, then share into it. */
async function openWithShare(intent: Record<string, unknown>) {
  await openApp();
  await deliverShare(intent);
}

/* ── The cases ────────────────────────────────────────────────────── */

describe('a share reaches a screen', () => {
  it('a shared sentence opens the share screen, and nothing has been sent', async () => {
    const propose = jest.spyOn(shareEndpoints, 'proposeFromShare');
    await openWithShare({ ...mockEmptyIntent, text: 'Pay the nursery on Thursday', type: 'text' });

    expect(screen.queryByText('Pay the nursery on Thursday')).not.toBeNull();
    // The screen's whole reason to exist: it says so, and it is true.
    expect(screen.queryByText(en.shareNothingSentYet)).not.toBeNull();
    expect(screen.queryByText(en.suggestionNote)).not.toBeNull();
    expect(propose).not.toHaveBeenCalled();
  });

  it('is not reachable until something is shared, and previews a file by name and size', async () => {
    await openApp();
    // No tab, no button, no deep link: the only way in is an intent.
    expect(screen.queryByTestId('share-screen')).toBeNull();

    await deliverShare({ ...mockEmptyIntent, files: [sharedFile()], type: 'file' });

    expect(screen.queryByText('WhatsApp Chat with Dana.zip')).not.toBeNull();
    // The size, in the user's language, with the digits kept left-to-right.
    expect(screen.getByTestId('share-file-0')).toHaveTextContent(/KB/);
  });
});

describe('analyze', () => {
  it('uploads once and lands on review, where confirm already works', async () => {
    const propose = jest.spyOn(shareEndpoints, 'proposeFromShare').mockResolvedValue(shareProposal() as never);
    await openWithShare({ ...mockEmptyIntent, text: 'Pay the nursery on Thursday', type: 'text' });

    await fireEvent.press(screen.getByTestId('share-analyze'));
    await waitFor(() => expect(screen.queryByTestId('review-item-i-1')).not.toBeNull());

    expect(propose).toHaveBeenCalledTimes(1);
    // The review screen the typed-capture flow uses, unchanged: this is what
    // "the share produces an ordinary capture proposal" buys.
    expect(screen.queryByText('Pay the nursery on Thursday')).not.toBeNull();
    expect(screen.queryByTestId('share-screen')).toBeNull();
  });

  it('sends the text, the file descriptor and the source hint, and no kind', async () => {
    const propose = jest.spyOn(shareEndpoints, 'proposeFromShare').mockResolvedValue(shareProposal() as never);
    await openWithShare({ ...mockEmptyIntent, files: [sharedFile()], type: 'file' });
    await fireEvent.press(screen.getByTestId('share-analyze'));
    await waitFor(() => expect(propose).toHaveBeenCalled());

    const sent = propose.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.files).toEqual([{
      uri: 'file:///tmp/share/chat.zip',
      name: 'WhatsApp Chat with Dana.zip',
      type: 'application/zip',
    }]);
    expect(sent.sourceHint).toBe('whatsapp');
    // The server classifies from the bytes. A `kind` from here would be a claim
    // it has to ignore anyway.
    expect(sent).not.toHaveProperty('kind');
  });

  it('leaves no copy of the shared file behind once it has been read', async () => {
    jest.spyOn(shareEndpoints, 'proposeFromShare').mockResolvedValue(shareProposal() as never);
    await openWithShare({ ...mockEmptyIntent, files: [sharedFile()], type: 'file' });
    expect(mockFiles.has('file:///tmp/share/chat.zip')).toBe(true);

    await fireEvent.press(screen.getByTestId('share-analyze'));
    await waitFor(() => expect(screen.queryByTestId('review-item-i-1')).not.toBeNull());

    expect([...mockFiles]).toEqual([]);
    // And the native module has been told to forget it, which on iOS is the
    // App Group's UserDefaults entry.
    expect(mockShareIntent.resets).toBeGreaterThan(0);
  });

  it('is not retried, and is not replayed by a second press', async () => {
    const propose = jest.spyOn(shareEndpoints, 'proposeFromShare').mockResolvedValue(shareProposal() as never);
    await openWithShare({ ...mockEmptyIntent, text: 'Pay the nursery', type: 'text' });
    await fireEvent.press(screen.getByTestId('share-analyze'));
    await waitFor(() => expect(screen.queryByTestId('review-item-i-1')).not.toBeNull());
    expect(propose).toHaveBeenCalledTimes(1);
  });
});

describe('what the user is told when it will not work', () => {
  it('a refusal on device never reaches the network', async () => {
    const propose = jest.spyOn(shareEndpoints, 'proposeFromShare');
    const images = Array.from({ length: 6 }, (_, index) => sharedFile({
      fileName: `photo-${index}.jpg`, mimeType: 'image/jpeg', path: `file:///tmp/share/${index}.jpg`,
    }));
    await openWithShare({ ...mockEmptyIntent, files: images, type: 'media' });

    expect(screen.getByTestId('share-problem')).toHaveTextContent(en.shareTooManyFiles);
    expect(propose).not.toHaveBeenCalled();
    // Six copies the OS made, and none of them kept.
    expect([...mockFiles]).toEqual([]);
  });

  it('says a 413 in bytes, not in the composer’s characters', async () => {
    jest.spyOn(shareEndpoints, 'proposeFromShare').mockRejectedValue(new UploadTooLargeError(25 * 1024 * 1024));
    await openWithShare({ ...mockEmptyIntent, text: 'a shared thing', type: 'text' });
    await fireEvent.press(screen.getByTestId('share-analyze'));
    await waitFor(() => expect(screen.queryByTestId('share-problem')).not.toBeNull());

    expect(screen.getByTestId('share-problem')).toHaveTextContent(en.shareTooLarge);
    // `aiInputTooLong` counts *characters* and would be a sentence about
    // something the user did not do, with a number that means nothing to them.
    expect(screen.queryByText(en.aiInputTooLong)).toBeNull();
  });

  it('says a 415 is about the file, and never quotes the server’s message', async () => {
    jest.spyOn(shareEndpoints, 'proposeFromShare')
      .mockRejectedValue(new UnsupportedShareError('media_type_mismatch'));
    await openWithShare({ ...mockEmptyIntent, text: 'a shared thing', type: 'text' });
    await fireEvent.press(screen.getByTestId('share-analyze'));
    await waitFor(() => expect(screen.queryByTestId('share-problem')).not.toBeNull());

    expect(screen.getByTestId('share-problem')).toHaveTextContent(en.shareUnsupported);
    // The reason code is ours to switch on and never words on a screen: a
    // provider or parser message on this route can quote what was shared.
    expect(screen.queryByText(/media_type_mismatch/)).toBeNull();
  });

  it('keeps the share after a network failure, so it can be tried again', async () => {
    const propose = jest.spyOn(shareEndpoints, 'proposeFromShare')
      .mockRejectedValueOnce(new NetworkError('nope'))
      .mockResolvedValueOnce(shareProposal() as never);
    await openWithShare({ ...mockEmptyIntent, files: [sharedFile()], type: 'file' });

    await fireEvent.press(screen.getByTestId('share-analyze'));
    await waitFor(() => expect(screen.queryByTestId('share-problem')).not.toBeNull());
    expect(screen.getByTestId('share-problem')).toHaveTextContent(en.errorsNetwork);
    // Deleting the copy here would make Retry a button that cannot work.
    expect(mockFiles.has('file:///tmp/share/chat.zip')).toBe(true);

    await fireEvent.press(screen.getByTestId('share-analyze'));
    await waitFor(() => expect(screen.queryByTestId('review-item-i-1')).not.toBeNull());
    expect(propose).toHaveBeenCalledTimes(2);
    expect([...mockFiles]).toEqual([]);
  });

  it('with the feature flag off it shows the notice, sends nothing and keeps nothing', async () => {
    delete process.env.EXPO_PUBLIC_FEATURE_SHARE_INTAKE;
    const propose = jest.spyOn(shareEndpoints, 'proposeFromShare');
    await openWithShare({ ...mockEmptyIntent, files: [sharedFile()], type: 'file' });

    expect(screen.getByTestId('share-notice')).toHaveTextContent(en.shareUnavailable);
    // There is no Analyze to press, so the bytes cannot leave the phone even by
    // accident — and they are already gone from disk.
    expect(screen.queryByTestId('share-analyze')).toBeNull();
    expect(propose).not.toHaveBeenCalled();
    expect([...mockFiles]).toEqual([]);
  });

  it('a value that is not exactly `true` leaves the feature off', async () => {
    process.env.EXPO_PUBLIC_FEATURE_SHARE_INTAKE = '1';
    await openWithShare({ ...mockEmptyIntent, text: 'a shared thing', type: 'text' });
    expect(screen.getByTestId('share-notice')).toHaveTextContent(en.shareUnavailable);
  });
});

describe('AI consent, before the bytes leave', () => {
  it('a screenshot is not uploaded by somebody who declined', async () => {
    grantAi('declined');
    const propose = jest.spyOn(shareEndpoints, 'proposeFromShare');
    await openWithShare({
      ...mockEmptyIntent,
      files: [sharedFile({ fileName: 'screenshot.png', mimeType: 'image/png', path: 'file:///tmp/share/s.png' })],
      type: 'media',
    });

    // There is no rule-based way to read a picture, so from #190 on a share of
    // one *is* a model call. Uploading it anyway would cross the network, spend
    // one of the thirty daily shares, and come back a refusal the user could
    // have been told about before anything left the phone.
    await waitFor(() => expect(screen.queryByText(en.shareNeedsAi)).not.toBeNull());
    expect(propose).not.toHaveBeenCalled();
    // No Analyze to press, and a way to go and change the answer instead.
    expect(screen.queryByTestId('share-analyze')).toBeNull();
    expect(screen.queryByTestId('share-turn-on-ai')).not.toBeNull();
  });

  it('a shared sentence is unaffected, because text needs no model', async () => {
    grantAi('declined');
    await openWithShare({ ...mockEmptyIntent, text: 'Pay the nursery on Thursday', type: 'text' });

    // The server falls back to the rule-based extractor for text and makes no
    // model call — the same reason `CaptureScreen`'s AI chip says what will
    // happen rather than gating anything (#161). Gating text here would be a
    // rule this product does not have.
    await waitFor(() => expect(screen.queryByTestId('share-analyze')).not.toBeNull());
    expect(screen.queryByText(en.shareNeedsAi)).toBeNull();
  });

  it('a PDF is held back too, and the preview still shows what was shared', async () => {
    grantAi('declined');
    await openWithShare({
      ...mockEmptyIntent,
      files: [sharedFile({ fileName: 'invoice.pdf', mimeType: 'application/pdf', path: 'file:///tmp/share/i.pdf' })],
      type: 'file',
    });

    await waitFor(() => expect(screen.queryByText(en.shareNeedsAi)).not.toBeNull());
    // Seeing what was shared is not the part that needs consent.
    expect(screen.queryByText('invoice.pdf')).not.toBeNull();
  });
});

describe('discard', () => {
  it('deletes the copies, persists nothing and goes home', async () => {
    const propose = jest.spyOn(shareEndpoints, 'proposeFromShare');
    const confirm = jest.spyOn(captureEndpoints, 'confirmCapture');
    await openWithShare({ ...mockEmptyIntent, files: [sharedFile()], type: 'file' });

    await fireEvent.press(screen.getByTestId('share-discard'));
    await waitFor(() => expect(screen.queryByTestId('share-screen')).toBeNull());

    expect([...mockFiles]).toEqual([]);
    expect(propose).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(mockShareIntent.resets).toBeGreaterThan(0);
  });

  it('unmounting the app deletes them too, for a share nobody ever looked at', async () => {
    // Signing out unmounts `Root`. The paths go with it, so if the copies were
    // not deleted here nothing would ever delete them.
    await openWithShare({ ...mockEmptyIntent, files: [sharedFile()], type: 'file' });
    expect(mockFiles.has('file:///tmp/share/chat.zip')).toBe(true);
    await act(async () => { screen.unmount(); });
    expect([...mockFiles]).toEqual([]);
  });
});
