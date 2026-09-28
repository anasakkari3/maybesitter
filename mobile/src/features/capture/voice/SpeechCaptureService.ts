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
  /**
   * The recogniser works, but not in this language (UC-2.3, #163).
   *
   * Distinct from `unavailable`, which is "no recogniser here at all". The two
   * need different words: one is a device without dictation, the other is a
   * device that will happily dictate English at somebody speaking Arabic, and
   * the second is the one where offering the button anyway would be worse than
   * hiding it.
   */
  | 'localeUnavailable'
  | 'unavailable'
  /**
   * The recogniser listened and heard nothing it could use. Retryable, and
   * said out loud: going quiet after a tap reads as a broken button.
   */
  | 'noSpeech'
  /**
   * Dictation is switched off on this phone (Siri & Dictation off, speech
   * recognition restricted, or its assets missing). Not retryable by tapping
   * again, and not the app's microphone permission: the fix is in Settings,
   * so the mic stays and a short line points there.
   */
  | 'dictationOff'
  /**
   * This attempt failed (audio busy, network, the speech service restarted).
   * Retryable: the mic stays, with a short "try again" line. Only a device with
   * no recogniser (`unavailable`) or without this language
   * (`localeUnavailable`) hides it.
   */
  | 'failed';

export interface SpeechCaptureCallbacks {
  /** Interim words, for the live display. Never submitted. */
  onPartial?(transcript: string): void;
  /**
   * The whole dictation, once, when it ends — by the user's Stop, by the
   * safety cap, or by the recogniser giving up part-way (whatever was heard by
   * then is not thrown away).
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
  /**
   * Starts one dictation. Re-entrancy safe: a call while a start is still in
   * flight returns that same start, and a call while listening does nothing —
   * neither detaches the running session's listeners.
   */
  start(callbacks: SpeechCaptureCallbacks): Promise<void>;
  /** Ends the dictation; what was heard still arrives through `onFinal`. */
  stop(): Promise<void>;
  /**
   * Drops the dictation: the microphone is released and nothing more is
   * handed over. For a screen that is going away mid-sentence — a transcript
   * arriving after it closed would write into a draft the user discarded.
   */
  cancel?(): Promise<void>;
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

  async cancel(): Promise<void> {
    // Nothing was started.
  }
}

export const noopSpeechCaptureService = new NoopSpeechCaptureService();
