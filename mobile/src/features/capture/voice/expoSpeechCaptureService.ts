import { joinSegments } from './dictationText';
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
 * ── The user decides when it stops ───────────────────────────────
 *
 * Recognition runs in continuous mode: a pause to think is not the end of the
 * sentence. It stops when the user taps Stop, or at `MAX_DICTATION_MS` if they
 * never do — a safety cap so a phone left on a table does not hold the
 * microphone indefinitely. The microphone is held only for that span, and what
 * leaves it is still only the transcript: nothing is recorded or stored.
 *
 * ── A transcript is never submitted ──────────────────────────────
 *
 * `onFinal` hands the whole dictation to the caller once, when it ends. `VoiceButton` puts them in
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

export type SpeechEventName = 'result' | 'error' | 'end' | 'nomatch';

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
 * The longest one dictation runs without the user stopping it: two minutes.
 *
 * Long enough for somebody to talk through their whole day with pauses; short
 * enough that a forgotten mic does not listen to a room for long. When it
 * fires, the recogniser is stopped (not aborted), so what it heard still lands
 * in the field.
 */
export const MAX_DICTATION_MS = 120_000;

/**
 * Which of our statuses an error code means.
 *
 * `not-allowed` is the user; `language-not-supported` is this language on this
 * device; `no-speech` is a quiet room. Everything else — audio busy, the
 * speech service restarting, the network, Siri's service being unreachable —
 * is this attempt failing, and the next tap may well work. Those are `failed`
 * (retryable), never `unavailable`: a mic that vanishes after one hiccup cannot
 * be tried again until the screen is reopened.
 */
export function statusForErrorCode(code: string | undefined): SpeechStatus {
  switch (code) {
    case 'not-allowed':
      return 'permissionDenied';
    case 'language-not-supported':
      return 'localeUnavailable';
    case 'no-speech':
      return 'noSpeech';
    default:
      return 'failed';
  }
}

export class ExpoSpeechCaptureService implements SpeechCaptureService {
  locale = '';
  status: SpeechStatus = 'idle';

  private unsubscribers: (() => void)[] = [];
  private supported: { locales: string[]; installedLocales: string[] } | null = null;
  /** The start in flight, returned to a second caller instead of a second start. */
  private starting: Promise<void> | null = null;
  /** Bumped by `cancel`, so a start that was waiting on permission gives up. */
  private generation = 0;
  private cap: ReturnType<typeof setTimeout> | null = null;

  /** This dictation: finished segments, and the segment still being spoken. */
  private done = '';
  private pending = '';
  private lastSegment = '';
  private heardNothing = false;

  constructor(
    private readonly module: SpeechRecognitionModuleLike,
    private readonly subscribe: SpeechEventSubscriber,
    private readonly language: () => SpeechLanguage,
  ) {}

  private set(status: SpeechStatus, callbacks: SpeechCaptureCallbacks): void {
    this.status = status;
    callbacks.onStatus?.(status);
  }

  start(callbacks: SpeechCaptureCallbacks): Promise<void> {
    // A second press while the first is still asking for permission is the
    // same press. Starting again would detach the first session's listeners
    // while its recogniser kept running — words spoken into nothing.
    if (this.starting) return this.starting;
    if (this.status === 'listening') return Promise.resolve();
    const run = this.run(callbacks, this.generation).finally(() => {
      if (this.starting === run) this.starting = null;
    });
    this.starting = run;
    return run;
  }

  private async run(callbacks: SpeechCaptureCallbacks, generation: number): Promise<void> {
    this.detach();
    this.set('requestingPermission', callbacks);
    const cancelled = () => generation !== this.generation;

    let granted = false;
    try {
      granted = (await this.module.requestPermissionsAsync()).granted;
    } catch {
      // A module that cannot even be asked is a device without dictation.
      if (!cancelled()) this.set('unavailable', callbacks);
      return;
    }
    if (cancelled()) return;
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
      if (cancelled()) return;
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
    this.done = '';
    this.pending = '';
    this.lastSegment = '';
    this.heardNothing = false;
    this.attach(callbacks);
    try {
      this.module.start({
        lang: resolution.localeId,
        interimResults: true,
        // Continuous: a pause to think is not the end. Non-continuous arms a
        // 3 s no-result timer on iOS 17 and finalises at the first pause on
        // iOS 18. The user stops it (Stop), or the safety cap does.
        continuous: true,
        addsPunctuation: true,
        requiresOnDeviceRecognition: resolution.onDevice,
      });
      this.set('listening', callbacks);
      this.cap = setTimeout(() => { void this.stop(); }, MAX_DICTATION_MS);
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

  async cancel(): Promise<void> {
    this.generation += 1;
    const active = this.starting !== null || this.status === 'listening';
    this.detach();
    if (!active) return;
    this.status = 'idle';
    try {
      this.module.abort();
    } catch {
      // Already gone.
    }
  }

  /** Everything heard so far in this dictation. */
  private heard(): string {
    return joinSegments(this.done, this.pending);
  }

  /** The dictation is over: hand over what was heard, once, then let go. */
  private finish(callbacks: SpeechCaptureCallbacks, status: SpeechStatus | null): void {
    const text = this.heard();
    this.detach();
    if (text) {
      callbacks.onFinal?.(text);
      // Silence after words is just the end of the dictation.
      this.set(status === null || status === 'noSpeech' ? 'reviewingTranscript' : status, callbacks);
      return;
    }
    if (status !== null) this.set(status, callbacks);
    else if (this.heardNothing) this.set('noSpeech', callbacks);
    else if (this.status === 'listening') this.set('idle', callbacks);
  }

  private attach(callbacks: SpeechCaptureCallbacks): void {
    this.unsubscribers.push(this.subscribe('result', (event) => {
      const transcript = event.results?.[0]?.transcript ?? '';
      if (!transcript.trim()) return;
      if (event.isFinal) {
        // In continuous mode a final result is one finished segment (iOS 18
        // after a pause, Android per utterance); iOS 17 sends one at the end.
        // A segment reported twice at the close, with nothing said between,
        // is the same words — not a repeat the user spoke.
        const segment = transcript.trim();
        if (!(this.pending === '' && segment === this.lastSegment)) {
          this.done = joinSegments(this.done, segment);
          this.lastSegment = segment;
        }
        this.pending = '';
      } else {
        this.pending = transcript;
      }
      callbacks.onPartial?.(this.heard());
    }));

    this.unsubscribers.push(this.subscribe('nomatch', () => {
      this.heardNothing = true;
    }));

    this.unsubscribers.push(this.subscribe('error', (event) => {
      this.finish(callbacks, statusForErrorCode(event.error));
    }));

    this.unsubscribers.push(this.subscribe('end', () => {
      this.finish(callbacks, null);
    }));
  }

  private detach(): void {
    if (this.cap !== null) {
      clearTimeout(this.cap);
      this.cap = null;
    }
    for (const off of this.unsubscribers) {
      try { off(); } catch { /* a listener already gone is fine */ }
    }
    this.unsubscribers = [];
  }
}
