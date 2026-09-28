import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { voiceEnabled } from '../../../config/env';
import { speechLanguageForTag, type SpeechLanguage } from './speechLocale';
import { noopSpeechCaptureService, type SpeechCaptureService } from './SpeechCaptureService';
import {
  ExpoSpeechCaptureService,
  type SpeechEventName,
  type SpeechRecognitionEventLike,
  type SpeechRecognitionModuleLike,
} from './expoSpeechCaptureService';

/**
 * Which recogniser the app uses (UC-2.3, #163).
 *
 * The kill switch returns the Noop one, which reports `unavailable` — and
 * `VoiceButton` renders nothing for that. Turning voice off therefore removes
 * the control rather than leaving one that apologises.
 *
 * Everything below is the only place in the app that imports the native module,
 * so the service itself stays testable with a fake and there is one file to
 * read to answer "what does this app do with a microphone".
 */

/** Bridges the module's hook-based events to the plain subscription the service takes. */
const listeners = new Map<SpeechEventName, Set<(event: SpeechRecognitionEventLike) => void>>();

function subscribe(
  name: SpeechEventName,
  listener: (event: SpeechRecognitionEventLike) => void,
): () => void {
  const set = listeners.get(name) ?? new Set();
  set.add(listener);
  listeners.set(name, set);
  return () => { set.delete(listener); };
}

function emit(name: SpeechEventName, event: SpeechRecognitionEventLike): void {
  for (const listener of listeners.get(name) ?? []) listener(event);
}

/**
 * Mounted once, high in the tree, so the module's hooks have a component to
 * live in. It renders nothing; it only forwards.
 */
export function SpeechEventBridge(): null {
  useSpeechRecognitionEvent('result', (event) => emit('result', event as SpeechRecognitionEventLike));
  useSpeechRecognitionEvent('error', (event) => emit('error', event as unknown as SpeechRecognitionEventLike));
  useSpeechRecognitionEvent('end', () => emit('end', {}));
  // "Heard audio, recognised nothing": the service says so instead of going quiet.
  useSpeechRecognitionEvent('nomatch', () => emit('nomatch', {}));
  return null;
}

export function createSpeechCaptureService(language: () => SpeechLanguage): SpeechCaptureService {
  if (!voiceEnabled()) return noopSpeechCaptureService;
  return new ExpoSpeechCaptureService(
    ExpoSpeechRecognitionModule as unknown as SpeechRecognitionModuleLike,
    subscribe,
    language,
  );
}

export { speechLanguageForTag };
