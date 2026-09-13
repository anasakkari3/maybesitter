import { resolveSpeechLocale, type SpeechLanguage } from './speechLocale';
import type {
  SpeechCaptureCallbacks,
  SpeechCaptureService,
  SpeechStatus,
} from './SpeechCaptureService';

/**
 * Dictation on the device's own recogniser (UC-2.3, #163).
 *
 * ── The audio never reaches us ───────────────────────────────────
 *
 * Apple's and Google's recognisers turn speech into text on the device — or, if
 * the language is not installed, on the vendor's service under the OS's own
 * disclosure. Either way MaybeSitter is handed a string and never a recording,
 * which is what the permission prompt says and what `privacyVoice` says on the
 * screen. Nothing here writes audio anywhere, and there is no path that could.
 *
 * ── Every dependency is injected ─────────────────────────────────
 *
 * The native module is passed in rather than imported at the top, so the whole
 * of this file is exercised by tests without a device: permission refusal,
 * an unsupported language, each error code, and the transcript path. A service
 * that can only be tested by speaking into a phone is a service that is tested
 * once.
 *
 * ── A transcript is never submitted ──────────────────────────────
 *
 * `onFinal` hands the words to the caller and stops. `VoiceButton` puts them in
 * the text field, and the user presses Analyze. A recogniser that misheard a
 * time would otherwise create a commitment nobody said.
 */

/** The slice of the native module this uses. Narrow, so a fake is honest. */
export interface SpeechRecognitionModuleLike {
  requestPermissionsAsync(): Promise<{ granted: boolean }>;
  getSupportedLocales(options: { androidRecognitionServicePackage?: string }): Promise<{
    locales: string[];
    installedLocales: string[];
  }>;
  start(options: {
    lang: string;
    interimResults?: boolean;
    continuous?: boolean;
    addsPunctuation?: boolean;
    requiresOnDeviceRecognition?: boolean;
  }): void;
  stop(): void;
  abort(): void;
}

export type SpeechEventName = 'result' | 'error' | 'end';

/** Subscribes to the module's events; returns an unsubscribe. */
export type SpeechEventSubscriber = (
  name: SpeechEventName,
  listener: (event: SpeechRecognitionEventLike) => void,
) => () => void;

export interface SpeechRecognitionEventLike {
  /** `result` events. */
  isFinal?: boolean;
  results?: { transcript: string }[];
  /** `error` events. */
  error?: string;
}

/**
 * Which of our statuses an error code means.
 *
 * `not-allowed` is the user; `language-not-supported` is this language on this
 * device; the rest are the device or the network, and all read the same to
 * somebody holding a phone: dictation is not going to work right now.
 */
export function statusForErrorCode(code: string | undefined): SpeechStatus {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return code === 'not-allowed' ? 'permissionDenied' : 'unavailable';
    case 'language-not-supported':
      return 'localeUnavailable';
    case 'audio-capture':
    case 'network':
      return 'unavailable';
    default:
      return 'failed';
  }
}

export class ExpoSpeechCaptureService implements SpeechCaptureService {
  locale = '';
  status: SpeechStatus = 'idle';

  private unsubscribers: (() => void)[] = [];
  private supported: { locales: string[]; installedLocales: string[] } | null = null;

  constructor(
    private readonly module: SpeechRecognitionModuleLike,
    private readonly subscribe: SpeechEventSubscriber,
    private readonly language: () => SpeechLanguage,
  ) {}

  private set(status: SpeechStatus, callbacks: SpeechCaptureCallbacks): void {
    this.status = status;
    callbacks.onStatus?.(status);
  }

  async start(callbacks: SpeechCaptureCallbacks): Promise<void> {
    this.detach();
    this.set('requestingPermission', callbacks);

    let granted = false;
    try {
      granted = (await this.module.requestPermissionsAsync()).granted;
    } catch {
      // A module that cannot even be asked is a device without dictation.
      this.set('unavailable', callbacks);
      return;
    }
    if (!granted) {
      this.set('permissionDenied', callbacks);
      return;
    }

    // Read once per session: the list does not change while the app is open,
    // and asking on every tap makes the mic feel slow.
    if (!this.supported) {
      try {
        this.supported = await this.module.getSupportedLocales({});
      } catch {
        this.supported = { locales: [], installedLocales: [] };
      }
    }

    const resolution = resolveSpeechLocale(
      this.language(),
      this.supported.locales,
      this.supported.installedLocales,
    );
    if (resolution.kind === 'unsupported') {
      // Not started. A recogniser that will happily dictate English at somebody
      // speaking Arabic is worse than no mic.
      this.set('localeUnavailable', callbacks);
      return;
    }

    this.locale = resolution.localeId;
    this.attach(callbacks);
    try {
      this.module.start({
        lang: resolution.localeId,
        interimResults: true,
        // One utterance. Continuous listening is a recording, and this product
        // holds the microphone for exactly as long as somebody is dictating.
        continuous: false,
        addsPunctuation: true,
        requiresOnDeviceRecognition: resolution.onDevice,
      });
      this.set('listening', callbacks);
    } catch {
      this.detach();
      this.set('failed', callbacks);
    }
  }

  async stop(): Promise<void> {
    try {
      this.module.stop();
    } catch {
      // Stopping something that is not running is not an error worth showing.
    }
  }

  private attach(callbacks: SpeechCaptureCallbacks): void {
    this.unsubscribers.push(this.subscribe('result', (event) => {
      const transcript = event.results?.[0]?.transcript ?? '';
      if (!transcript) return;
      if (event.isFinal) {
        this.set('reviewingTranscript', callbacks);
        callbacks.onFinal?.(transcript);
        this.detach();
      } else {
        callbacks.onPartial?.(transcript);
      }
    }));

    this.unsubscribers.push(this.subscribe('error', (event) => {
      this.set(statusForErrorCode(event.error), callbacks);
      this.detach();
    }));

    this.unsubscribers.push(this.subscribe('end', () => {
      // `end` after a final result is the normal close and must not overwrite
      // `reviewingTranscript` — the words are in the field and the user is
      // reading them.
      if (this.status === 'listening') this.set('idle', callbacks);
      this.detach();
    }));
  }

  private detach(): void {
    for (const off of this.unsubscribers) {
      try { off(); } catch { /* a listener already gone is fine */ }
    }
    this.unsubscribers = [];
  }
}
