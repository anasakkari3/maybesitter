/**
 * The seam the speech implementation plugs into (UC-2.R2 #172 step 9).
 *
 * Declared here, and deliberately not implemented here. UC-2.3 (#163) supplies
 * the real on-device recogniser; this file is what the composer is written
 * against so that the capture flow can be finished, tested and shipped without
 * it — and so that #163 changes one file rather than the flow.
 *
 * ── Audio never leaves the device for us ─────────────────────────
 *
 * There is no upload in this interface and there will not be one. The contract
 * is transcript-in, and the only thing the capture flow ever receives is text
 * the user can see and edit before anything is sent anywhere. Whatever #163
 * uses for recognition, MaybeSitter receives words, not audio.
 */

export type SpeechStatus =
  | 'idle'
  | 'requestingPermission'
  | 'listening'
  | 'reviewingTranscript'
  | 'permissionDenied'
  | 'unavailable'
  | 'failed';

export interface SpeechCaptureCallbacks {
  /** Interim words, for the live display. Never submitted. */
  onPartial?(transcript: string): void;
  /**
   * The recogniser's final answer.
   *
   * It goes into the text field for the user to read. It is **never**
   * auto-submitted: a recogniser that misheard a time would otherwise create a
   * commitment nobody said, which is the same failure #162 spent its length
   * removing from the extractor.
   */
  onFinal?(transcript: string): void;
  onStatus?(status: SpeechStatus): void;
}

export interface SpeechCaptureService {
  /** The BCP-47 tag actually used, so the UI can show which language is live. */
  readonly locale: string;
  readonly status: SpeechStatus;
  start(callbacks: SpeechCaptureCallbacks): Promise<void>;
  stop(): Promise<void>;
}

/**
 * What ships until #163 lands: a service that reports it cannot help.
 *
 * `unavailable` rather than a throw, because "this device has no recogniser" is
 * an ordinary state the UI already has copy for — the mic button hides itself —
 * and an exception would make a missing feature look like a crash.
 */
export class NoopSpeechCaptureService implements SpeechCaptureService {
  readonly locale = '';
  readonly status: SpeechStatus = 'unavailable';

  async start(callbacks: SpeechCaptureCallbacks): Promise<void> {
    callbacks.onStatus?.('unavailable');
  }

  async stop(): Promise<void> {
    // Nothing was started.
  }
}

export const noopSpeechCaptureService = new NoopSpeechCaptureService();
