'use client';

import { useCallback, useEffect, useState } from 'react';

type AgendaReason = 'overdue' | 'due_soon' | 'pending' | 'active';
type AgendaAction = 'done' | 'aware' | 'postpone' | 'skip';

type AgendaItem = {
  id: string;
  title: string;
  reason: AgendaReason;
  urgencyScore: number;
  suggestedAction: 'do' | 'review' | 'confirm';
};

type AgendaResponse = {
  success: boolean;
  items: AgendaItem[];
  pressureCandidate?: {
    commitmentId: string;
    message: string;
    tone: 'soft' | 'firm';
    intensity: 'low' | 'medium' | 'high';
    strategy: string;
    path: string;
  };
};

type AgendaActionResponse = {
  success: boolean;
  message: string;
};

const reasonLabels: Record<AgendaReason, string> = {
  overdue: 'Overdue',
  due_soon: 'Due soon',
  pending: 'Pending',
  active: 'Active',
};

const actions: { type: AgendaAction; label: string }[] = [
  { type: 'done', label: 'Mark Done' },
  { type: 'aware', label: 'Acknowledge' },
  { type: 'postpone', label: 'Postpone' },
  { type: 'skip', label: 'Skip' },
];

const SESSION_STORAGE_KEY = 'maybesitter:capture-session-id';

function getOrCreateSessionId(): string {
  const existing = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
  if (existing) return existing;
  const next = window.crypto.randomUUID();
  window.sessionStorage.setItem(SESSION_STORAGE_KEY, next);
  return next;
}

function urgencyWidth(score: number): string {
  return `${Math.max(8, Math.min(100, Math.round((score / 7999) * 100)))}%`;
}

function urgencyLabel(score: number): string {
  if (score >= 6_000) return 'Needs attention now';
  if (score >= 4_000) return 'Coming up';
  return 'Worth keeping in view';
}

function reasonClass(reason: AgendaReason): string {
  if (reason === 'overdue') return 'border-red-200 bg-red-50 text-red-700';
  if (reason === 'due_soon') return 'border-orange-200 bg-orange-50 text-orange-700';
  if (reason === 'pending') return 'border-blue-200 bg-blue-50 text-blue-700';
  return 'border-gray-200 bg-gray-50 text-gray-700';
}

export default function AgendaPanel() {
  const [items, setItems] = useState<AgendaItem[]>([]);
  const [pressureCandidate, setPressureCandidate] = useState<AgendaResponse['pressureCandidate']>(undefined);
  const [sessionId, setSessionId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const scopedSessionId = sessionId || getOrCreateSessionId();
    if (!sessionId) setSessionId(scopedSessionId);
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/agenda?sessionId=${encodeURIComponent(scopedSessionId)}`, { cache: 'no-store' });
      const body = (await response.json()) as AgendaResponse;
      if (!response.ok || !body.success) throw new Error('Agenda request failed');
      setItems(body.items);
      setPressureCandidate(body.pressureCandidate);
      if (body.pressureCandidate) {
        void fetch('/api/pressure/delivery', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            commitmentId: body.pressureCandidate.commitmentId,
            message: body.pressureCandidate.message,
            strategy: body.pressureCandidate.strategy,
            path: body.pressureCandidate.path,
            sessionId: scopedSessionId,
          }),
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load agenda');
    } finally {
      setIsLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    setSessionId(getOrCreateSessionId());
  }, []);

  async function handleAction(id: string, action: AgendaAction) {
    setActingId(id);
    setError(null);
    setStatus(null);
    try {
      const response = await fetch('/api/agenda/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action, sessionId: sessionId || getOrCreateSessionId() }),
      });
      const body = (await response.json()) as AgendaActionResponse;
      if (!response.ok || !body.success) throw new Error(body.message || 'No change was applied');
      setStatus(body.message);
      await refresh();
      window.dispatchEvent(new Event('maybesitter:capture-complete'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not apply agenda action');
      await refresh();
    } finally {
      setActingId(null);
    }
  }

  useEffect(() => {
    void refresh();
    window.addEventListener('maybesitter:capture-complete', refresh);
    return () => window.removeEventListener('maybesitter:capture-complete', refresh);
  }, [refresh]);

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Agenda</h2>
          <p className="mt-1 text-sm text-gray-500">The few things most worth noticing.</p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-semibold text-gray-700"
        >
          {isLoading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {error && (
        <p className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      )}

      {status && (
        <p className="mt-4 rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-700">
          {status}
        </p>
      )}

      {pressureCandidate && (
        <p className="mt-4 rounded-md border border-gray-300 bg-gray-50 p-3 text-sm font-medium text-gray-800">
          {pressureCandidate.message}
        </p>
      )}

      <div className="mt-4">
        {items.length === 0 ? (
          <p className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm text-gray-500">
            Nothing needs attention right now.
          </p>
        ) : (
          <ul className="space-y-3">
            {items.map((item) => (
              <li key={item.id} className="rounded-md border border-gray-200 bg-white p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-gray-900">{item.title}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${reasonClass(item.reason)}`}>
                        {reasonLabels[item.reason]}
                      </span>
                      <span className="text-xs text-gray-500">{urgencyLabel(item.urgencyScore)}</span>
                    </div>
                  </div>
                </div>

                <div className="mt-3 h-2 rounded-full bg-gray-100">
                  <div className="h-2 rounded-full bg-gray-800" style={{ width: urgencyWidth(item.urgencyScore) }} />
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  {actions.map((action) => (
                    <button
                      key={action.type}
                      type="button"
                      disabled={actingId === item.id}
                      onClick={() => void handleAction(item.id, action.type)}
                      className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700 disabled:opacity-60"
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
