/**
 * The mic seam (UC-2.R2 #172 step 9, for UC-2.3 #163 to fill).
 *
 * The point of the tests is the two things that must not happen: a control
 * offered when the product cannot honour it, and a transcript that submits
 * itself.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Linking } from 'react-native';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import en from '../../../../i18n/locales/en.json';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { AppProvider } from '../../../../state/AppContext';
import { VoiceButton } from '../VoiceButton';
import {
  noopSpeechCaptureService,
  type SpeechCaptureCallbacks,
  type SpeechCaptureService,
  type SpeechStatus,
} from '../SpeechCaptureService';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

/** A recogniser that works, so the branches the Noop hides can be exercised. */
class FakeService implements SpeechCaptureService {
  readonly locale = 'ar-JO';
  status: SpeechStatus = 'idle';
  started = 0;
  stopped = 0;
  cancelled = 0;
  protected callbacks: SpeechCaptureCallbacks = {};

  async start(callbacks: SpeechCaptureCallbacks): Promise<void> {
    this.started += 1;
    this.callbacks = callbacks;
    this.status = 'listening';
    callbacks.onStatus?.('listening');
  }

  async stop(): Promise<void> {
    this.stopped += 1;
    this.status = 'idle';
    this.callbacks.onStatus?.('idle');
  }

  async cancel(): Promise<void> {
    this.cancelled += 1;
  }

  emitPartial(text: string) { this.callbacks.onPartial?.(text); }
  emitFinal(text: string) { this.callbacks.onFinal?.(text); }
  emitStatus(status: SpeechStatus) {
    this.status = status;
    this.callbacks.onStatus?.(status);
  }
}

/** A recogniser whose start answers with one fixed status. */
function answering(status: SpeechStatus) {
  return new (class extends FakeService {
    override async start(callbacks: SpeechCaptureCallbacks): Promise<void> {
      this.started += 1;
      this.callbacks = callbacks;
      this.status = status;
      callbacks.onStatus?.(status);
    }
  })();
}

let onPartial: ReturnType<typeof jest.fn<(t: string) => void>>;
let onFinal: ReturnType<typeof jest.fn<(t: string) => void>>;

beforeEach(() => {
  onPartial = jest.fn<(t: string) => void>();
  onFinal = jest.fn<(t: string) => void>();
});

afterEach(() => { jest.restoreAllMocks(); });

async function show(props: Partial<React.ComponentProps<typeof VoiceButton>> = {}) {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <VoiceButton onPartial={onPartial} onFinal={onFinal} {...props} />
      </AppProvider>
    </SafeAreaProvider>,
  );
}

describe('with no recogniser', () => {
  it('renders nothing at all', async () => {
    // Not a greyed-out button, and not one that opens an apology. A control the
    // product cannot honour costs the user a tap to discover.
    await show({ service: noopSpeechCaptureService });
    expect(screen.queryByTestId('voice-button')).toBeNull();
  });

  it('is absent by default, because the default service is the Noop one', async () => {
    await show();
    expect(screen.queryByTestId('voice-button')).toBeNull();
  });

  it('does not start listening even when the link asked for voice', async () => {
    const service = noopSpeechCaptureService;
    const start = jest.spyOn(service, 'start');
    await show({ service, autoFocus: true });
    expect(start).not.toHaveBeenCalled();
  });
});

describe('with a recogniser', () => {
  it('offers the button', async () => {
    await show({ service: new FakeService() });
    expect(screen.queryByTestId('voice-button')).not.toBeNull();
  });

  it('starts and stops on tap', async () => {
    const service = new FakeService();
    await show({ service });
    await fireEvent.press(screen.getByTestId('voice-button'));
    await waitFor(() => expect(service.started).toBe(1));
    await fireEvent.press(screen.getByTestId('voice-button'));
    await waitFor(() => expect(service.stopped).toBe(1));
  });

  it('starts by itself when the link said input=voice', async () => {
    const service = new FakeService();
    await show({ service, autoFocus: true });
    await waitFor(() => expect(service.started).toBe(1));
  });

  it('starts once, not on every render', async () => {
    // Restarting the recogniser under somebody mid-sentence loses the sentence.
    const service = new FakeService();
    const view = await show({ service, autoFocus: true });
    await waitFor(() => expect(service.started).toBe(1));
    view.rerender(
      <SafeAreaProvider initialMetrics={METRICS}>
        <AppProvider>
          <VoiceButton service={service} autoFocus onPartial={onPartial} onFinal={onFinal} />
        </AppProvider>
      </SafeAreaProvider>,
    );
    expect(service.started).toBe(1);
  });
});

describe('what it does with words', () => {
  it('hands partials and the final transcript to the field, and submits neither', async () => {
    const service = new FakeService();
    await show({ service });
    await fireEvent.press(screen.getByTestId('voice-button'));
    await waitFor(() => expect(service.started).toBe(1));

    service.emitPartial('ذكرني');
    service.emitFinal('ذكرني أسلم التقرير بكرا');

    expect(onPartial).toHaveBeenCalledWith('ذكرني');
    expect(onFinal).toHaveBeenCalledWith('ذكرني أسلم التقرير بكرا');
    // The component has no submit of its own: a recogniser that misheard a time
    // would otherwise create a commitment nobody said.
    expect(screen.queryByTestId('capture-analyze')).toBeNull();
  });
});

describe('a refused microphone', () => {
  it('says so in a short line, offers Settings, and keeps the mic to try again', async () => {
    const service = answering('permissionDenied');
    const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined as never);
    await show({ service });
    await fireEvent.press(screen.getByTestId('voice-button'));
    await waitFor(() => expect(screen.queryByTestId('voice-denied')).not.toBeNull());

    // Not the privacy sentence: it did not say what was wrong or how to fix it.
    expect(screen.getByTestId('voice-denied').props.children).toBe(en.voiceDenied);
    await fireEvent.press(screen.getByTestId('voice-open-settings'));
    expect(openSettings).toHaveBeenCalledTimes(1);
    // Coming back from Settings with access granted, the next tap has to work.
    expect(screen.queryByTestId('voice-button')).not.toBeNull();
  });
});

describe('a failed attempt (the mic used to vanish)', () => {
  it('keeps the mic and says to try again', async () => {
    const service = new FakeService();
    await show({ service });
    await fireEvent.press(screen.getByTestId('voice-button'));
    await waitFor(() => expect(service.started).toBe(1));
    await React.act(async () => { service.emitStatus('failed'); });

    expect(screen.queryByTestId('voice-button')).not.toBeNull();
    expect(screen.getByTestId('voice-note').props.children).toBe(en.voiceFailed);
  });

  it('says it heard nothing, instead of going quiet', async () => {
    const service = new FakeService();
    await show({ service });
    await fireEvent.press(screen.getByTestId('voice-button'));
    await waitFor(() => expect(service.started).toBe(1));
    await React.act(async () => { service.emitStatus('noSpeech'); });

    expect(screen.queryByTestId('voice-button')).not.toBeNull();
    expect(screen.getByTestId('voice-note').props.children).toBe(en.voiceNoSpeech);
  });

  it('hides the mic only when the language cannot be dictated here, and says why', async () => {
    const service = answering('localeUnavailable');
    await show({ service });
    await fireEvent.press(screen.getByTestId('voice-button'));
    await waitFor(() => expect(screen.queryByTestId('voice-button')).toBeNull());
    expect(screen.getByTestId('voice-note').props.children).toBe(en.voiceLocaleUnavailable);
  });

  it('starts fresh when it is handed a new recogniser (another language)', async () => {
    const first = answering('failed');
    const view = await show({ service: first });
    await fireEvent.press(screen.getByTestId('voice-button'));
    await waitFor(() => expect(screen.queryByTestId('voice-note')).not.toBeNull());

    const second = new FakeService();
    await view.rerender(
      <SafeAreaProvider initialMetrics={METRICS}>
        <AppProvider>
          <VoiceButton service={second} onPartial={onPartial} onFinal={onFinal} />
        </AppProvider>
      </SafeAreaProvider>,
    );
    expect(screen.queryByTestId('voice-note')).toBeNull();
    expect(screen.queryByTestId('voice-button')).not.toBeNull();
  });

  it('comes back after a hide when the new recogniser can listen', async () => {
    const first = answering('localeUnavailable');
    const view = await show({ service: first });
    await fireEvent.press(screen.getByTestId('voice-button'));
    await waitFor(() => expect(screen.queryByTestId('voice-button')).toBeNull());

    await view.rerender(
      <SafeAreaProvider initialMetrics={METRICS}>
        <AppProvider>
          <VoiceButton service={new FakeService()} onPartial={onPartial} onFinal={onFinal} />
        </AppProvider>
      </SafeAreaProvider>,
    );
    expect(screen.queryByTestId('voice-button')).not.toBeNull();
  });
});

describe('while listening', () => {
  it('is a Stop control, named as one', async () => {
    const service = new FakeService();
    await show({ service });
    expect(screen.getByTestId('voice-button').props.accessibilityLabel).toBe(en.tapToTalk);
    await fireEvent.press(screen.getByTestId('voice-button'));
    await waitFor(() => expect(screen.queryByTestId('voice-stop-glyph')).not.toBeNull());
    expect(screen.getByTestId('voice-button').props.accessibilityLabel).toBe(en.stopReview);
    expect(screen.getByTestId('voice-note').props.children).toBe(en.voiceListening);
  });

  it('ignores a second press while the first start is still in flight', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const service = new (class extends FakeService {
      override async start(callbacks: SpeechCaptureCallbacks): Promise<void> {
        this.started += 1;
        this.callbacks = callbacks;
        this.status = 'requestingPermission';
        callbacks.onStatus?.('requestingPermission');
        await gate;
        this.status = 'listening';
        callbacks.onStatus?.('listening');
      }
    })();
    await show({ service });
    await fireEvent.press(screen.getByTestId('voice-button'));
    await fireEvent.press(screen.getByTestId('voice-button'));
    await React.act(async () => { open(); });
    expect(service.started).toBe(1);
    expect(service.stopped).toBe(0);
  });

  it('tells the caller a dictation is starting, before any words', async () => {
    const onStart = jest.fn<() => void>();
    const service = new FakeService();
    await show({ service, onStart });
    await fireEvent.press(screen.getByTestId('voice-button'));
    await waitFor(() => expect(service.started).toBe(1));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('lets go of the microphone when the screen goes away', async () => {
    const service = new FakeService();
    const view = await show({ service });
    await fireEvent.press(screen.getByTestId('voice-button'));
    await waitFor(() => expect(service.started).toBe(1));
    await view.unmount();
    expect(service.cancelled).toBe(1);
  });
});
