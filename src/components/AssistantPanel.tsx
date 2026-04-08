'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';

type NextStepType = 'none' | 'confirm' | 'clarify' | 'review';

type CaptureResponse = {
  success: boolean;
  response: {
    message?: string;
    interpretation: string;
    actions: string[];
    nextStep: {
      type: NextStepType;
      message: string;
    };
  };
  meta: {
    engineUsed: string;
    disposition: string;
    pendingClarificationId?: string;
    clarificationExpiresAt?: string;
    clarificationScopeId?: string;
  };
};

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text?: string;
  capture?: CaptureResponse;
};

type BrowserSpeechRecognitionEvent = {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: {
      isFinal: boolean;
      length: number;
      [index: number]: {
        transcript: string;
      };
    };
  };
};

type BrowserSpeechRecognitionErrorEvent = {
  error: string;
};

type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: ((event: BrowserSpeechRecognitionErrorEvent) => void) | null;
};

type SpeechRecognitionWindow = Window & {
  SpeechRecognition?: new () => BrowserSpeechRecognition;
  webkitSpeechRecognition?: new () => BrowserSpeechRecognition;
};

function getOrCreateSessionId(): string {
  const key = 'maybesitter:capture-session-id';
  const existing = window.sessionStorage.getItem(key);
  if (existing) return existing;
  const next = crypto.randomUUID();
  window.sessionStorage.setItem(key, next);
  return next;
}

function messageId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function AssistantBubble({ capture }: { capture: CaptureResponse }) {
  const message = capture.response.message || 'I could not prepare a safe reply.';

  return (
    <p className="whitespace-pre-wrap">{message}</p>
  );
}

export default function AssistantPanel() {
  const [text, setText] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      text: 'Tell me what you need to handle. If there are several things, put them in one message and I will separate them by priority.',
    },
  ]);
  const [expandedDebugId, setExpandedDebugId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [speechSupported, setSpeechSupported] = useState(false);
  const [sessionId, setSessionId] = useState('');
  const [pendingClarificationId, setPendingClarificationId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const draftBeforeVoiceRef = useRef('');
  const voiceTranscriptRef = useRef('');
  const shouldSubmitVoiceRef = useRef(false);
  const showDebugDetails = process.env.NODE_ENV === 'development';

  useEffect(() => {
    setSessionId(getOrCreateSessionId());
    const speechWindow = window as SpeechRecognitionWindow;
    setSpeechSupported(Boolean(speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition));
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, isSubmitting]);

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
    };
  }, []);

  async function submitText(rawText: string) {
    const submittedText = rawText.trim();
    if (!submittedText || isSubmitting) return;

    const userMessage: ChatMessage = { id: messageId(), role: 'user', text: submittedText };
    setMessages((current) => [...current, userMessage]);
    setText('');
    setVoiceError(null);
    setIsSubmitting(true);
    const captureSessionId = sessionId || getOrCreateSessionId();
    if (!sessionId) setSessionId(captureSessionId);

    try {
      const response = await fetch('/api/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: submittedText, sessionId: captureSessionId, pendingClarificationId }),
      });
      const body = await response.json();

      if (!response.ok) {
        throw new Error(body?.error || `Request failed with ${response.status}`);
      }

      const capture = body as CaptureResponse;
      setMessages((current) => [...current, { id: messageId(), role: 'assistant', capture }]);
      if (capture.response.nextStep.type === 'clarify' && capture.meta.pendingClarificationId) {
        setPendingClarificationId(capture.meta.pendingClarificationId);
        if (capture.meta.clarificationScopeId) setSessionId(capture.meta.clarificationScopeId);
      } else {
        setPendingClarificationId(null);
      }
      window.dispatchEvent(new Event('maybesitter:capture-complete'));
    } catch (err) {
      const errorText = err instanceof Error ? err.message : 'Capture request failed';
      setMessages((current) => [
        ...current,
        { id: messageId(), role: 'assistant', text: `I could not process that safely. ${errorText}` },
      ]);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submitText(text);
  }

  function startVoiceCapture() {
    if (isSubmitting || isListening) return;
    const speechWindow = window as SpeechRecognitionWindow;
    const Recognition = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
    if (!Recognition) {
      setVoiceError('Voice input is not supported in this browser.');
      return;
    }

    recognitionRef.current?.abort();
    const recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';
    recognitionRef.current = recognition;
    draftBeforeVoiceRef.current = text.trim();
    voiceTranscriptRef.current = '';
    shouldSubmitVoiceRef.current = true;
    setVoiceError(null);

    recognition.onstart = () => setIsListening(true);
    recognition.onresult = (event) => {
      let finalText = '';
      let interimText = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result[0]?.transcript || '';
        if (result.isFinal) finalText += transcript;
        else interimText += transcript;
      }

      if (finalText.trim()) {
        voiceTranscriptRef.current = `${voiceTranscriptRef.current} ${finalText}`.trim();
      }

      const combined = [draftBeforeVoiceRef.current, voiceTranscriptRef.current, interimText.trim()]
        .filter(Boolean)
        .join(' ');
      setText(combined);
    };
    recognition.onerror = (event) => {
      shouldSubmitVoiceRef.current = false;
      setVoiceError(event.error === 'not-allowed'
        ? 'Microphone permission was blocked.'
        : 'I could not hear that clearly. Try again.');
    };
    recognition.onend = () => {
      setIsListening(false);
      const combined = [draftBeforeVoiceRef.current, voiceTranscriptRef.current]
        .filter(Boolean)
        .join(' ')
        .trim();
      recognitionRef.current = null;
      if (shouldSubmitVoiceRef.current && voiceTranscriptRef.current.trim()) {
        shouldSubmitVoiceRef.current = false;
        void submitText(combined);
      }
    };

    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      shouldSubmitVoiceRef.current = false;
      setIsListening(false);
      setVoiceError('Voice input could not start. Try again.');
    }
  }

  function stopVoiceCapture() {
    if (!recognitionRef.current) return;
    recognitionRef.current.stop();
  }

  function toggleVoiceCapture() {
    if (isListening) stopVoiceCapture();
    else startVoiceCapture();
  }

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="mb-4">
        <h2 className="text-base font-semibold text-gray-900">Talk to Maybesitter</h2>
        <p className="mt-1 text-sm text-gray-500">Say one thing, or several. I will separate the commitments and keep the thread going.</p>
      </div>

      <div className="max-h-[520px] min-h-[280px] overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 p-3">
        <div className="space-y-4" aria-live="polite">
          {messages.map((message) => (
            <div
              key={message.id}
              className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[88%] rounded-lg p-3 text-sm shadow-sm ${
                  message.role === 'user'
                    ? 'bg-gray-900 text-white'
                    : 'border border-gray-200 bg-white text-gray-900'
                }`}
              >
                {message.text && <p className="whitespace-pre-wrap">{message.text}</p>}
                {message.capture && (
                  <>
                    <AssistantBubble capture={message.capture} />
                    {showDebugDetails && (
                      <button
                        type="button"
                        onClick={() => setExpandedDebugId((current) => current === message.id ? null : message.id)}
                        className="mt-3 text-xs font-semibold text-gray-500 underline"
                      >
                        {expandedDebugId === message.id ? 'Hide debug details' : 'Show debug details'}
                      </button>
                    )}
                    {showDebugDetails && expandedDebugId === message.id && (
                      <div className="mt-3 rounded-md border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600">
                        <p>success: {String(message.capture.success)}</p>
                        <p>engine: {message.capture.meta.engineUsed}</p>
                        <p>disposition: {message.capture.meta.disposition}</p>
                        {message.capture.meta.pendingClarificationId && <p>clarification: pending</p>}
                        {message.capture.meta.clarificationExpiresAt && <p>expires: {message.capture.meta.clarificationExpiresAt}</p>}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}

          {isSubmitting && (
            <div className="flex justify-start">
              <div className="rounded-lg border border-gray-200 bg-white p-3 text-sm text-gray-500 shadow-sm">
                Thinking...
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      <form onSubmit={handleSubmit} className="mt-3 space-y-2">
        <label htmlFor="assistant-input" className="sr-only">
          Message Maybesitter
        </label>
        <div className="flex gap-2">
          <textarea
            id="assistant-input"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            className="min-h-12 flex-1 resize-none rounded-md border border-gray-300 p-3 text-sm text-gray-900"
            placeholder={pendingClarificationId ? 'Answer the question...' : 'Example: urgent pay the bill today at 5pm, and maybe read a chapter Friday'}
          />
          <button
            type="button"
            onClick={toggleVoiceCapture}
            disabled={isSubmitting || !speechSupported}
            className={`self-end rounded-md px-4 py-3 text-sm font-semibold disabled:opacity-60 ${
              isListening
                ? 'bg-red-600 text-white'
                : 'bg-gray-100 text-gray-800 hover:bg-gray-200'
            }`}
            title={speechSupported ? 'Record voice input' : 'Voice input is not supported in this browser'}
          >
            {isListening ? 'Stop' : 'Voice'}
          </button>
          <button
            type="submit"
            disabled={isSubmitting || isListening || !text.trim()}
            className="self-end rounded-md bg-gray-900 px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
          >
            {isSubmitting ? 'Sending...' : pendingClarificationId ? 'Reply' : 'Send'}
          </button>
        </div>
        {(isListening || voiceError) && (
          <p className={`text-xs ${voiceError ? 'text-red-600' : 'text-gray-500'}`}>
            {voiceError || 'Listening. Speak naturally, then press Stop.'}
          </p>
        )}
      </form>
    </section>
  );
}
