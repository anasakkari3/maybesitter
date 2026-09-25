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
import { metadataMarkersIn, stripCaseBytes } from '../__fixtures__/stripCases';
import { lyingBomb, TRANSCRIPT, zip } from '../__fixtures__/zipFixtures';

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
/**
 * What is actually inside those files, for the cases that read one.
 *
 * Only the archive cases need it. A uri with no entry here reads as empty,
 * which is what an unreadable file looks like to `readSharedFileBytes`.
 */
const mockFileBytes = new Map<string, Uint8Array>();

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

/**
 * What each of those files contains, for the shares that are read rather than
 * only deleted (UC-3.6, #190).
 *
 * A picture is the one kind of share whose bytes this app touches: no EXIF may
 * be in the upload, removing a segment means rewriting the file, and rewriting
 * means reading it. So the mock gained `bytesSync`, `write` and `create`, and
 * the assertion "the upload carries no metadata" is made against what the mock
 * was actually asked to write.
 */

jest.mock('expo-file-system', () => ({
  __esModule: true,
  Paths: { get cache(): string { return 'file:///cache'; } },
  File: class {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts.map((part) => (typeof part === 'string' ? part : part.uri)).join('/');
    }
    get exists(): boolean { return mockFiles.has(this.uri); }
    get size(): number { return mockFileBytes.get(this.uri)?.byteLength ?? 0; }
    // SDK 57's synchronous read. A file with no bytes recorded is one the
    // platform would not hand over, which is a case of its own below.
    bytesSync(): Uint8Array {
      const bytes = mockFileBytes.get(this.uri);
      if (!bytes) throw new Error('the platform would not read that file');
      return bytes;
    }
    delete(): void { mockFiles.delete(this.uri); mockFileBytes.delete(this.uri); }
    create(): void { mockFiles.add(this.uri); }
    write(bytes: Uint8Array): void { mockFiles.add(this.uri); mockFileBytes.set(this.uri, bytes); }
  },
}));

/**
 * `expo-image-manipulator`, over the same in-memory disk (#404).
 *
 * A decode reads the bytes the OS handed over and rejects anything that is not
 * a JPEG, PNG or HEIF — which is what the platform does with a HEIF it cannot
 * decode. Every save writes the *worst* encoder output there is: Exif with a
 * GPS IFD, a thumbnail and an ICC profile. So a clean upload is the stripper's
 * doing, and the saved files are on the disk the "nothing left behind" cases
 * inspect.
 */
const mockManipulator: {
  saves: { width: number; height: number; compress: number | undefined }[];
  picture: { width: number; height: number };
  /** When set, an encode waits for it: the window in which the app can unmount. */
  gate: Promise<void> | null;
} = {
  saves: [],
  gate: null,
  picture: { width: 4032, height: 3024 },
};

/** Read when a save happens, never while the mock factory is hoisted. */
function mockEncoderOutput(png: boolean): Uint8Array {
  return stripCaseBytes(png ? 'poster_he' : 'encoder_exif_gps_thumbnail_icc');
}

jest.mock('expo-image-manipulator', () => {
  const readable = (bytes: Uint8Array | undefined) => Boolean(bytes && bytes.length > 12 && (
    (bytes[0] === 0xff && bytes[1] === 0xd8)
    || (bytes[0] === 0x89 && bytes[1] === 0x50)
    || String.fromCharCode(bytes[4]!, bytes[5]!, bytes[6]!, bytes[7]!) === 'ftyp'));
  const imageRef = (width: number, height: number) => ({
    width,
    height,
    release: () => {},
    saveAsync: async (options: { compress?: number; format?: string }) => {
      if (mockManipulator.gate) await mockManipulator.gate;
      const png = options.format === 'png';
      const uri = `file:///cache/ImageManipulator/${mockManipulator.saves.length}.${png ? 'png' : 'jpg'}`;
      mockManipulator.saves.push({ width, height, compress: options.compress });
      mockFiles.add(uri);
      mockFileBytes.set(uri, mockEncoderOutput(png));
      return { uri, width, height };
    },
  });
  return {
    __esModule: true,
    SaveFormat: { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' },
    ImageManipulator: {
      manipulate: (source: string | { width: number; height: number }) => {
        let size: { width: number; height: number } | null = null;
        const context = {
          resize: (next: { width: number; height: number }) => { size = next; return context; },
          release: () => {},
          renderAsync: async () => {
            if (typeof source === 'string') {
              if (!readable(mockFileBytes.get(source))) throw new Error('Loading bitmap failed');
              return imageRef(mockManipulator.picture.width, mockManipulator.picture.height);
            }
            return imageRef(size?.width ?? source.width, size?.height ?? source.height);
          },
        };
        return context;
      },
    },
  };
});

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

/** The one uri every archive case shares. */
const ARCHIVE_URI = 'file:///tmp/share/chat.zip';

/** An archive share, with the bytes the reader will actually be handed. */
function archiveIntent(bytes: Uint8Array) {
  mockFileBytes.set(ARCHIVE_URI, bytes);
  return { ...mockEmptyIntent, files: [sharedFile({ size: bytes.byteLength })], type: 'file' };
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
  mockFileBytes.clear();
  mockManipulator.saves = [];
  mockManipulator.gate = null;
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
  for (const file of (intent.files as { path: string; bytes?: Uint8Array }[] | null) ?? []) {
    mockFiles.add(file.path);
    if (file.bytes) mockFileBytes.set(file.path, file.bytes);
  }
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

/**
 * The zip-bomb guard, at the only line where it counts (UC-3.5, #189).
 *
 * `whatsappExportReader.ts` has its own unit tests and its own mutation matrix.
 * None of that is worth anything if nothing calls it — which is the failure
 * this repository keeps finding, and which this lane shipped for one revision:
 * a correct, tested, unreachable helper while a bomb crossed the network and
 * was refused by the server.
 *
 * So the property asserted here is not "the reader was called". It is *the
 * archive is refused and `proposeFromShare` is never reached*, which is false
 * for every version of this code that does not call it, and which a spy on the
 * reader would not have caught.
 */
describe('a chat archive is read before it is uploaded', () => {
  it('a zip bomb is refused on the device and never becomes a request', async () => {
    const propose = jest.spyOn(shareEndpoints, 'proposeFromShare');
    await openWithShare(archiveIntent(lyingBomb()));

    // The preview is reached normally: nothing about this archive looks wrong
    // until it is read. Every number in its header is inside the limits.
    await fireEvent.press(screen.getByTestId('share-analyze'));
    await waitFor(() => expect(screen.queryByTestId('share-problem')).not.toBeNull());

    expect(screen.getByTestId('share-problem')).toHaveTextContent(en.shareTooLarge);
    // The whole point. Sixteen megabytes of expansion did not cross the
    // network, and one of the user's thirty daily shares was not spent.
    expect(propose).not.toHaveBeenCalled();
    // And the copy is gone: a refused archive will never be uploaded, so
    // keeping it would be a copy of somebody's chat kept for nothing.
    expect([...mockFiles]).toEqual([]);
  });

  it('an ordinary export is not refused, and is uploaded as a file', async () => {
    const propose = jest.spyOn(shareEndpoints, 'proposeFromShare')
      .mockResolvedValue(shareProposal() as never);
    await openWithShare(archiveIntent(zip([{ name: '_chat.txt', data: new TextEncoder().encode(TRANSCRIPT) }])));

    await fireEvent.press(screen.getByTestId('share-analyze'));
    await waitFor(() => expect(screen.queryByTestId('review-item-i-1')).not.toBeNull());

    expect(propose).toHaveBeenCalledTimes(1);
    // The file, not the transcript this phone just read out of it. The server
    // classifies from the bytes it receives; a client that sent its own
    // transcript would be a client the server had to believe.
    const sent = propose.mock.calls[0]![0];
    expect(sent.files).toEqual([{ uri: ARCHIVE_URI, name: 'WhatsApp Chat with Dana.zip', type: 'application/zip' }]);
  });

  it('a second press does not retry a refused archive', async () => {
    const propose = jest.spyOn(shareEndpoints, 'proposeFromShare');
    await openWithShare(archiveIntent(lyingBomb()));

    await fireEvent.press(screen.getByTestId('share-analyze'));
    await waitFor(() => expect(screen.queryByTestId('share-problem')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('share-analyze'));

    expect(propose).not.toHaveBeenCalled();
  });

  it('an archive the platform will not read is left for the server to judge', async () => {
    const propose = jest.spyOn(shareEndpoints, 'proposeFromShare')
      .mockResolvedValue(shareProposal() as never);
    // No bytes recorded, so `bytesSync` throws the way a revoked uri does. That
    // is not a bomb, it is a file we know nothing about — and refusing it here
    // would refuse every share whose copy the OS moved out from under us.
    await openWithShare({ ...mockEmptyIntent, files: [sharedFile()], type: 'file' });

    await fireEvent.press(screen.getByTestId('share-analyze'));
    await waitFor(() => expect(propose).toHaveBeenCalled());
    expect(propose).toHaveBeenCalledTimes(1);
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

  it('"turn on AI" opens Trust over the share, and back returns to it with the file still there (L6)', async () => {
    grantAi('declined');
    await openWithShare({
      ...mockEmptyIntent,
      files: [sharedFile({ fileName: 'invoice.pdf', mimeType: 'application/pdf', path: 'file:///tmp/share/i.pdf' })],
      type: 'file',
    });
    await waitFor(() => expect(screen.queryByTestId('share-turn-on-ai')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('share-turn-on-ai'));
    await waitFor(() => expect(screen.queryByTestId('trust-ai-processing')).not.toBeNull());
    expect(screen.queryByTestId('share-screen')).toBeNull();

    await fireEvent.press(screen.getByTestId('header-back'));
    await waitFor(() => expect(screen.queryByTestId('share-screen')).not.toBeNull());
    expect(screen.queryByText('invoice.pdf')).not.toBeNull();
    expect([...mockFiles]).toEqual(['file:///tmp/share/i.pdf']);
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

describe('back', () => {
  it('the Back pill is the same step as Android back: it closes the share and keeps the tab as it was (L6)', async () => {
    await openApp();
    await fireEvent.press(screen.getByTestId('tab-calendar'));
    await deliverShare({ ...mockEmptyIntent, text: 'Pay the nursery on Thursday', type: 'text' });
    await fireEvent.press(screen.getByTestId('share-back'));
    await waitFor(() => expect(screen.queryByTestId('share-screen')).toBeNull());
    // Back to the tab the share arrived over, not Today's root.
    await waitFor(() => expect(screen.getByTestId('tab-calendar').props.accessibilityState).toMatchObject({ selected: true }));
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

describe('a picture is stripped before it is uploaded (UC-3.6, #190)', () => {
  /** A photograph the OS handed over, with real EXIF in it. */
  function photograph(name: string, mimeType: string, path: string) {
    return sharedFile({ fileName: name, mimeType, path, size: stripCaseBytes(name).byteLength, bytes: stripCaseBytes(name) });
  }

  it('uploads the stripped copy, and never the file the OS handed over', async () => {
    /*
     * The wiring, asserted where it actually matters: what `proposeFromShare`
     * is handed. `prepareImages` being correct in its own suite proves nothing
     * about a provider that forgot to call it, and a provider that called it
     * and then uploaded `sending.files` anyway would pass every unit test in
     * this repository.
     */
    let uploaded: Uint8Array | undefined;
    let uploadedUri: string | undefined;
    const propose = jest.spyOn(shareEndpoints, 'proposeFromShare')
      .mockImplementation(async (payload: unknown) => {
        const files = (payload as { files: { uri: string }[] }).files;
        uploadedUri = files[0]!.uri;
        // Read here rather than after: the flow deletes both copies the moment
        // the proposal is in memory, which is the behaviour a later test asserts.
        uploaded = mockFileBytes.get(uploadedUri);
        return shareProposal({ share: { channel: 'image', kind: 'images', fileCount: 1, ignoredSegments: 0, suggestedNextAction: null } }) as never;
      });

    await openWithShare({
      ...mockEmptyIntent,
      files: [photograph('poster_ar', 'image/jpeg', 'file:///tmp/share/poster.jpg')],
      type: 'media',
    });
    await fireEvent.press(screen.getByTestId('share-analyze'));
    await waitFor(() => expect(propose).toHaveBeenCalled());

    expect(uploadedUri).not.toBe('file:///tmp/share/poster.jpg');
    expect(uploaded).toBeDefined();
    // The criterion, on the bytes the upload was built from.
    expect(metadataMarkersIn(uploaded!)).toEqual([]);
    // And the original really did carry them, so the line above is a removal.
    expect(metadataMarkersIn(stripCaseBytes('poster_ar')).length).toBeGreaterThan(0);
    // The name still travels, as a JPEG now (#404): the server reads it once for a source hint.
    const sent = propose.mock.calls[0]![0] as unknown as {
      files: readonly { name: string; type: string }[];
    };
    expect(sent.files[0]!.name).toBe('poster_ar.jpg');
    expect(sent.files[0]!.type).toBe('image/jpeg');
  });

  it('leaves neither the photograph nor the stripped copy behind', async () => {
    jest.spyOn(shareEndpoints, 'proposeFromShare').mockResolvedValue(shareProposal() as never);
    await openWithShare({
      ...mockEmptyIntent,
      files: [photograph('poster_he', 'image/png', 'file:///tmp/share/poster.png')],
      type: 'media',
    });
    await fireEvent.press(screen.getByTestId('share-analyze'));
    await waitFor(() => expect(screen.queryByTestId('review-item-i-1')).not.toBeNull());

    // Two copies existed at the moment of upload — the OS's and ours — and
    // neither is still on the device.
    expect([...mockFiles]).toEqual([]);
  });

  it('an iPhone photo in its own format is converted, downscaled and stripped, not refused (#404)', async () => {
    let uploaded: Uint8Array | undefined;
    const propose = jest.spyOn(shareEndpoints, 'proposeFromShare')
      .mockImplementation(async (payload: unknown) => {
        const files = (payload as { files: { uri: string }[] }).files;
        uploaded = mockFileBytes.get(files[0]!.uri);
        return shareProposal({ share: { channel: 'image', kind: 'images', fileCount: 1, ignoredSegments: 0, suggestedNextAction: null } }) as never;
      });
    await openWithShare({
      ...mockEmptyIntent,
      files: [photograph('heic_real_imageio', 'image/heic', 'file:///tmp/share/IMG_2024.HEIC')],
      type: 'media',
    });
    await fireEvent.press(screen.getByTestId('share-analyze'));
    await waitFor(() => expect(propose).toHaveBeenCalled());

    const sent = propose.mock.calls[0]![0] as unknown as { files: readonly { name: string; type: string }[] };
    expect(sent.files[0]!.type).toBe('image/jpeg');
    expect(sent.files[0]!.name).toBe('heic_real_imageio.jpg');
    // Brought down to a 2048 px long edge at q0.8, once.
    expect(mockManipulator.saves).toEqual([{ width: 2048, height: 1536, compress: 0.8 }]);
    // The encoder's file carried GPS and a thumbnail; the upload carries neither.
    expect(metadataMarkersIn(stripCaseBytes('encoder_exif_gps_thumbnail_icc')).length).toBeGreaterThan(0);
    expect(uploaded).toBeDefined();
    expect(metadataMarkersIn(uploaded!)).toEqual([]);
    // The OS's copy, the encoder's output and the stripped copy: all gone.
    await waitFor(() => expect(screen.queryByTestId('review-item-i-1')).not.toBeNull());
    expect([...mockFiles]).toEqual([]);
  });

  it('a retry after a failed upload leaves none of the first attempt’s files behind (#404 review F3)', async () => {
    const propose = jest.spyOn(shareEndpoints, 'proposeFromShare')
      .mockRejectedValueOnce(new NetworkError('nope'))
      .mockResolvedValueOnce(shareProposal() as never);
    await openWithShare({
      ...mockEmptyIntent,
      files: [photograph('poster_ar', 'image/jpeg', 'file:///tmp/share/poster.jpg')],
      type: 'media',
    });
    await fireEvent.press(screen.getByTestId('share-analyze'));
    await waitFor(() => expect(screen.queryByTestId('share-problem')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('share-analyze'));
    await waitFor(() => expect(screen.queryByTestId('review-item-i-1')).not.toBeNull());

    expect(propose).toHaveBeenCalledTimes(2);
    // Two encodes, two stripped copies and the OS's copy: every one is gone.
    expect(mockManipulator.saves).toHaveLength(2);
    expect([...mockFiles]).toEqual([]);
  });

  it('unmounting while a picture is being prepared deletes what it wrote and uploads nothing (#404 review F4)', async () => {
    const propose = jest.spyOn(shareEndpoints, 'proposeFromShare');
    let open: () => void = () => {};
    mockManipulator.gate = new Promise<void>((resolve) => { open = resolve; });
    await openWithShare({
      ...mockEmptyIntent,
      files: [photograph('poster_ar', 'image/jpeg', 'file:///tmp/share/poster.jpg')],
      type: 'media',
    });
    await fireEvent.press(screen.getByTestId('share-analyze'));
    // Signed out mid-encode.
    await act(async () => { screen.unmount(); });
    await act(async () => {
      open();
      for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
    });

    expect(mockManipulator.saves).toHaveLength(1);
    expect(propose).not.toHaveBeenCalled();
    expect([...mockFiles]).toEqual([]);
  });

  it('a picture the phone cannot open is refused here with what to do instead, not uploaded', async () => {
    const propose = jest.spyOn(shareEndpoints, 'proposeFromShare');
    await openWithShare({
      ...mockEmptyIntent,
      files: [photograph('not_an_image', 'image/heic', 'file:///tmp/share/IMG_2024.heic')],
      type: 'media',
    });
    await fireEvent.press(screen.getByTestId('share-analyze'));
    await waitFor(() => expect(screen.queryByTestId('share-problem')).not.toBeNull());

    expect(screen.getByTestId('share-problem')).toHaveTextContent(en.shareImageUnreadable);
    expect(propose).not.toHaveBeenCalled();
  });
});
