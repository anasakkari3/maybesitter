import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  ExpoSpeechCaptureService,
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
  started: { lang: string; requiresOnDeviceRecognition?: boolean }[] = [];
  stopped = 0;
  throwOnStart = false;
  throwOnPermissions = false;

  async requestPermissionsAsync() {
    if (this.throwOnPermissions) throw new Error('no module');
    return { granted: this.granted };
  }

  async getSupportedLocales() {
    return { locales: this.locales, installedLocales: this.installed };
  }

  start(options: { lang: string; requiresOnDeviceRecognition?: boolean }) {
    if (this.throwOnStart) throw new Error('start failed');
    this.started.push(options);
  }

  stop() { this.stopped += 1; }
  abort() {}
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
  it('hands partials over as they arrive, and the final once', async () => {
    await service('en').start(callbacks());
    emit('result', { isFinal: false, results: [{ transcript: 'remind me' }] });
    emit('result', { isFinal: true, results: [{ transcript: 'remind me to call Dana' }] });

    expect(partials).toEqual(['remind me']);
    expect(finals).toEqual(['remind me to call Dana']);
    expect(statuses.at(-1)).toBe('reviewingTranscript');
  });

  it('ignores an empty transcript rather than clearing the field', async () => {
    await service('en').start(callbacks());
    emit('result', { isFinal: true, results: [{ transcript: '' }] });
    expect(finals).toEqual([]);
  });

  it('stops listening after the final result', async () => {
    await service('en').start(callbacks());
    emit('result', { isFinal: true, results: [{ transcript: 'done' }] });
    // A late `end` must not overwrite `reviewingTranscript`: the words are in
    // the field and the user is reading them.
    emit('end');
    expect(statuses.at(-1)).toBe('reviewingTranscript');
  });

  it('returns to idle when the recogniser ends with nothing', async () => {
    await service('en').start(callbacks());
    emit('end');
    expect(statuses.at(-1)).toBe('idle');
  });
});

describe('errors', () => {
  it('maps each code to what the user is actually facing', () => {
    expect(statusForErrorCode('not-allowed')).toBe('permissionDenied');
    expect(statusForErrorCode('language-not-supported')).toBe('localeUnavailable');
    expect(statusForErrorCode('audio-capture')).toBe('unavailable');
    expect(statusForErrorCode('service-not-allowed')).toBe('unavailable');
    expect(statusForErrorCode('network')).toBe('unavailable');
    expect(statusForErrorCode('something-new')).toBe('failed');
    expect(statusForErrorCode(undefined)).toBe('failed');
  });

  it('reports an error event and detaches', async () => {
    await service('en').start(callbacks());
    emit('error', { error: 'audio-capture' });
    expect(statuses.at(-1)).toBe('unavailable');
    // Detached: a later result cannot arrive against a dead session.
    emit('result', { isFinal: true, results: [{ transcript: 'late' }] });
    expect(finals).toEqual([]);
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
