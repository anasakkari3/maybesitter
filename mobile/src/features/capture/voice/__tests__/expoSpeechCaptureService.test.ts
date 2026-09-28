import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  ExpoSpeechCaptureService,
  MAX_DICTATION_MS,
  statusForErrorCode,
  type SpeechEventName,
  type SpeechRecognitionEventLike,
  type SpeechRecognitionModuleLike,
} from '../expoSpeechCaptureService';
import type { SpeechStatus } from '../SpeechCaptureService';

/**
 * The recogniser, without a device (UC-2.3, #163).
 *
 * Everything the service depends on is injected, so every branch a phone would
 * take is exercised here: a refused microphone, a language the device cannot
 * recognise, each error code, and the transcript path. A service that can only
 * be tested by speaking into a phone is a service that is tested once.
 *
 * What this cannot prove is that Apple's or Google's recogniser behaves as
 * documented. That is device work and is not claimed.
 */

class FakeModule implements SpeechRecognitionModuleLike {
  granted = true;
  locales: string[] = ['ar-JO', 'en-US', 'he-IL'];
  installed: string[] = ['en-US'];
  started: { lang: string; requiresOnDeviceRecognition?: boolean; continuous?: boolean }[] = [];
  stopped = 0;
  aborted = 0;
  /** Held open so a test can press twice while permission is still being asked. */
  permissionGate: Promise<void> | null = null;
  throwOnStart = false;
  throwOnPermissions = false;

  async requestPermissionsAsync() {
    if (this.throwOnPermissions) throw new Error('no module');
    if (this.permissionGate) await this.permissionGate;
    return { granted: this.granted };
  }

  async getSupportedLocales() {
    return { locales: this.locales, installedLocales: this.installed };
  }

  start(options: { lang: string; requiresOnDeviceRecognition?: boolean; continuous?: boolean }) {
    if (this.throwOnStart) throw new Error('start failed');
    this.started.push(options);
  }

  stop() { this.stopped += 1; }
  abort() { this.aborted += 1; }
}

let module_: FakeModule;
let handlers: Map<SpeechEventName, ((event: SpeechRecognitionEventLike) => void)[]>;
let statuses: SpeechStatus[];
let partials: string[];
let finals: string[];

function subscribe(name: SpeechEventName, listener: (event: SpeechRecognitionEventLike) => void) {
  const list = handlers.get(name) ?? [];
  list.push(listener);
  handlers.set(name, list);
  return () => { handlers.set(name, (handlers.get(name) ?? []).filter((l) => l !== listener)); };
}

function emit(name: SpeechEventName, event: SpeechRecognitionEventLike = {}) {
  for (const listener of [...(handlers.get(name) ?? [])]) listener(event);
}

const callbacks = () => ({
  onPartial: (t: string) => { partials.push(t); },
  onFinal: (t: string) => { finals.push(t); },
  onStatus: (s: SpeechStatus) => { statuses.push(s); },
});

function service(language: 'ar' | 'he' | 'en' = 'ar') {
  return new ExpoSpeechCaptureService(module_, subscribe, () => language);
}

beforeEach(() => {
  module_ = new FakeModule();
  handlers = new Map();
  statuses = [];
  partials = [];
  finals = [];
});

afterEach(() => { jest.restoreAllMocks(); });

describe('permission', () => {
  it('does not start the recogniser when the microphone is refused', async () => {
    module_.granted = false;
    await service().start(callbacks());
    expect(statuses).toEqual(['requestingPermission', 'permissionDenied']);
    expect(module_.started).toHaveLength(0);
  });

  it('treats a module that cannot be asked as a device without dictation', async () => {
    module_.throwOnPermissions = true;
    await service().start(callbacks());
    expect(statuses.at(-1)).toBe('unavailable');
  });
});

describe('the language', () => {
  it('starts in the locale the resolver chose', async () => {
    await service('ar').start(callbacks());
    expect(module_.started[0]!.lang).toBe('ar-JO');
    expect(statuses.at(-1)).toBe('listening');
  });

  it('asks for on-device recognition only when the language is installed', async () => {
    await service('ar').start(callbacks());
    expect(module_.started[0]!.requiresOnDeviceRecognition).toBe(false);

    module_.installed = ['ar-JO'];
    const second = service('ar');
    await second.start(callbacks());
    expect(module_.started[1]!.requiresOnDeviceRecognition).toBe(true);
  });

  it('refuses to start rather than dictate the wrong language', async () => {
    // A recogniser that will happily transcribe English at somebody speaking
    // Arabic is worse than no mic at all.
    module_.locales = ['en-US'];
    await service('ar').start(callbacks());
    expect(statuses.at(-1)).toBe('localeUnavailable');
    expect(module_.started).toHaveLength(0);
  });

  it('reads the device locale list once per session', async () => {
    const spy = jest.spyOn(module_, 'getSupportedLocales');
    const instance = service('en');
    await instance.start(callbacks());
    emit('end');
    await instance.start(callbacks());
    // Asking on every tap makes the mic feel slow, and the list does not change
    // while the app is open.
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('what comes back', () => {
  it('hands partials over as they arrive, and the whole dictation once, when it ends', async () => {
    await service('en').start(callbacks());
    emit('result', { isFinal: false, results: [{ transcript: 'remind me' }] });
    emit('result', { isFinal: true, results: [{ transcript: 'remind me to call Dana' }] });
    // Continuous: a finished segment is not the end of the dictation.
    expect(finals).toEqual([]);
    expect(statuses.at(-1)).toBe('listening');
    emit('end');

    expect(partials).toEqual(['remind me', 'remind me to call Dana']);
    expect(finals).toEqual(['remind me to call Dana']);
    expect(statuses.at(-1)).toBe('reviewingTranscript');
  });

  it('ignores an empty transcript rather than clearing the field', async () => {
    await service('en').start(callbacks());
    emit('result', { isFinal: true, results: [{ transcript: '' }] });
    emit('end');
    expect(finals).toEqual([]);
  });

  it('a late `end` does not overwrite the words the user is reading', async () => {
    await service('en').start(callbacks());
    emit('result', { isFinal: true, results: [{ transcript: 'done' }] });
    emit('end');
    emit('end');
    expect(statuses.at(-1)).toBe('reviewingTranscript');
    expect(finals).toEqual(['done']);
  });

  it('returns to idle when the recogniser ends with nothing', async () => {
    await service('en').start(callbacks());
    emit('end');
    expect(statuses.at(-1)).toBe('idle');
  });
});

describe('a pause is not the end (owner, first iPhone run)', () => {
  it('asks the recogniser to keep listening until the user stops it', async () => {
    await service('en').start(callbacks());
    // `continuous: false` arms a 3 s no-result timer on iOS 17 and finalises on
    // the first pause on iOS 18 — the mic stopped by itself mid-thought.
    expect(module_.started[0]!.continuous).toBe(true);
  });

  it('keeps listening after a segment finishes, and appends the next one', async () => {
    await service('en').start(callbacks());
    // iOS 18 / Android continuous: each pause finalises a segment, and the next
    // segment's words arrive on their own (iOS prefixes them with a space).
    emit('result', { isFinal: false, results: [{ transcript: 'remind me' }] });
    emit('result', { isFinal: true, results: [{ transcript: 'remind me' }] });
    emit('result', { isFinal: false, results: [{ transcript: ' to call' }] });
    emit('result', { isFinal: true, results: [{ transcript: ' to call Dana' }] });
    expect(statuses.at(-1)).toBe('listening');
    expect(partials.at(-1)).toBe('remind me to call Dana');

    emit('end');
    expect(finals).toEqual(['remind me to call Dana']);
  });

  it('does not repeat a segment the recogniser reports twice at the close', async () => {
    await service('en').start(callbacks());
    emit('result', { isFinal: false, results: [{ transcript: 'call Dana' }] });
    emit('result', { isFinal: true, results: [{ transcript: 'call Dana' }] });
    emit('result', { isFinal: true, results: [{ transcript: 'call Dana' }] });
    emit('end');
    expect(finals).toEqual(['call Dana']);
  });

  it('hands over what was heard if the recogniser ends before a final result', async () => {
    await service('en').start(callbacks());
    emit('result', { isFinal: false, results: [{ transcript: 'call Dana' }] });
    emit('end');
    expect(finals).toEqual(['call Dana']);
    expect(statuses.at(-1)).toBe('reviewingTranscript');
  });

  it('stops by itself only at the safety cap', async () => {
    jest.useFakeTimers();
    try {
      const instance = service('en');
      await instance.start(callbacks());
      jest.advanceTimersByTime(MAX_DICTATION_MS - 1);
      expect(module_.stopped).toBe(0);
      jest.advanceTimersByTime(1);
      // `stop`, not `abort`: the recogniser still delivers what it heard.
      expect(module_.stopped).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('the cap is two minutes', () => {
    expect(MAX_DICTATION_MS).toBe(120_000);
  });

  it('clears the cap when the dictation ends', async () => {
    jest.useFakeTimers();
    try {
      const instance = service('en');
      await instance.start(callbacks());
      emit('end');
      jest.advanceTimersByTime(MAX_DICTATION_MS);
      expect(module_.stopped).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('pressing twice (double start)', () => {
  it('a second start while the first is asking for permission is the same start', async () => {
    let open!: () => void;
    module_.permissionGate = new Promise<void>((resolve) => { open = resolve; });
    const instance = service('en');
    const first = instance.start(callbacks());
    const second = instance.start(callbacks());
    open();
    await Promise.all([first, second]);

    expect(module_.started).toHaveLength(1);
    // The first session's listeners are still attached: its words arrive.
    emit('result', { isFinal: true, results: [{ transcript: 'still here' }] });
    emit('end');
    expect(finals).toEqual(['still here']);
  });

  it('a start while already listening does not restart the recogniser', async () => {
    const instance = service('en');
    await instance.start(callbacks());
    await instance.start(callbacks());
    expect(module_.started).toHaveLength(1);
    emit('result', { isFinal: true, results: [{ transcript: 'one' }] });
    emit('end');
    expect(finals).toEqual(['one']);
  });

  it('can start again once the last dictation has ended', async () => {
    const instance = service('en');
    await instance.start(callbacks());
    emit('end');
    await instance.start(callbacks());
    expect(module_.started).toHaveLength(2);
  });
});

describe('cancelling (the screen went away)', () => {
  it('aborts, detaches, and hands nothing over', async () => {
    const instance = service('en');
    await instance.start(callbacks());
    emit('result', { isFinal: false, results: [{ transcript: 'half a' }] });
    await instance.cancel();
    expect(module_.aborted).toBe(1);
    emit('result', { isFinal: true, results: [{ transcript: 'half a thought' }] });
    emit('end');
    expect(finals).toEqual([]);
  });

  it('a cancel during the permission question means the recogniser never starts', async () => {
    let open!: () => void;
    module_.permissionGate = new Promise<void>((resolve) => { open = resolve; });
    const instance = service('en');
    const starting = instance.start(callbacks());
    await instance.cancel();
    open();
    await starting;
    expect(module_.started).toHaveLength(0);
  });

  it('cancelling nothing is not an error', async () => {
    await service('en').cancel();
    expect(module_.aborted).toBe(0);
  });
});

describe('errors', () => {
  it('maps each code to what the user is actually facing', () => {
    expect(statusForErrorCode('not-allowed')).toBe('permissionDenied');
    expect(statusForErrorCode('language-not-supported')).toBe('localeUnavailable');
    expect(statusForErrorCode('no-speech')).toBe('noSpeech');
    expect(statusForErrorCode('something-new')).toBe('failed');
    expect(statusForErrorCode(undefined)).toBe('failed');
  });

  it('a transient failure is retryable, not a missing feature (the mic used to vanish)', () => {
    for (const code of ['audio-capture', 'network', 'busy', 'interrupted']) {
      expect(statusForErrorCode(code)).toBe('failed');
    }
  });

  it('reports an error event and detaches', async () => {
    await service('en').start(callbacks());
    emit('error', { error: 'audio-capture' });
    expect(statuses.at(-1)).toBe('failed');
    // Detached: a later result cannot arrive against a dead session.
    emit('result', { isFinal: true, results: [{ transcript: 'late' }] });
    emit('end');
    expect(finals).toEqual([]);
  });

  it('keeps the words already heard when the recogniser fails part-way', async () => {
    await service('en').start(callbacks());
    emit('result', { isFinal: true, results: [{ transcript: 'call Dana' }] });
    emit('error', { error: 'network' });
    expect(finals).toEqual(['call Dana']);
    expect(statuses.at(-1)).toBe('failed');
  });

  it('dictation switched off on the phone is its own state, not "try again"', async () => {
    // Siri & Dictation off / recognition restricted: tapping again cannot fix
    // it, so a retry line would send the user round in circles.
    expect(statusForErrorCode('service-not-allowed')).toBe('dictationOff');
    await service('en').start(callbacks());
    emit('error', { error: 'service-not-allowed' });
    expect(statuses.at(-1)).toBe('dictationOff');
  });

  it('says it heard nothing, rather than going quiet', async () => {
    await service('en').start(callbacks());
    emit('error', { error: 'no-speech' });
    expect(statuses.at(-1)).toBe('noSpeech');
  });

  it('a `nomatch` followed by `end` is also "heard nothing"', async () => {
    await service('en').start(callbacks());
    emit('nomatch');
    emit('end');
    expect(statuses.at(-1)).toBe('noSpeech');
  });

  it('no-speech after words were heard is just the end of the dictation', async () => {
    await service('en').start(callbacks());
    emit('result', { isFinal: false, results: [{ transcript: 'call Dana' }] });
    emit('error', { error: 'no-speech' });
    expect(finals).toEqual(['call Dana']);
    expect(statuses.at(-1)).toBe('reviewingTranscript');
  });

  it('reports a start that throws rather than pretending to listen', async () => {
    module_.throwOnStart = true;
    await service('en').start(callbacks());
    expect(statuses.at(-1)).toBe('failed');
  });
});

describe('stopping', () => {
  it('asks the module to stop', async () => {
    const instance = service('en');
    await instance.start(callbacks());
    await instance.stop();
    expect(module_.stopped).toBe(1);
  });

  it('stopping something that never started is not an error', async () => {
    await expect(service('en').stop()).resolves.toBeUndefined();
  });
});
