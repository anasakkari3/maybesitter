'use client';

/**
 * The personalization control centre, on the settings screen's Data tab.
 *
 * Presentation only. Every decision — what "effective" means, whether a reading
 * may change behaviour, what a confidence number means in words — is decided in
 * `lib/personalizationControls/inventory.ts` and arrives already phrased. A
 * component that re-derived any of that would be a second policy nobody tests.
 *
 * Two things here are deliberate and worth not undoing:
 *
 * The **adaptive classification block renders whether or not personalization is
 * on**. That classifier shipped before this contract existed and runs today
 * through `/api/agenda`; hiding it behind this screen's toggle would make the
 * page most misleading exactly when someone has turned everything off and gone
 * looking for what is left.
 *
 * The **delete flow shows the receipt**, and shows the digest the server
 * returned. "Deletion is verifiable" means the person can see the proof, not
 * that they are told it succeeded.
 */

import { useCallback, useState } from 'react';

interface ReadingView {
  status: 'inconclusive' | 'suggestion' | 'operative';
  level: string | null;
  confidence: number | null;
  provenance: string;
  confidenceExplanation: string;
  whatWouldChangeIt: string;
}

interface PreferenceRow {
  dimension: string;
  label: string;
  reading: ReadingView | null;
  correction: { level: string; statedAt: string } | null;
  effective: { source: string; level: string };
}

interface AdaptiveInput {
  name: string;
  label: string;
  valueLabel: string;
  explanation: string;
}

interface InventoryView {
  scopeId: string;
  consent: { state: 'enabled' | 'disabled'; changedAt: string | null };
  preferences:
    | { kind: 'derived'; rows: PreferenceRow[] }
    | { kind: 'disabled'; rows: PreferenceRow[]; explanation: string }
    | { kind: 'deriver_unavailable'; rows: PreferenceRow[]; explanation: string }
    | { kind: 'profile_invalid'; rows: PreferenceRow[]; defectCodes: string[]; explanation: string };
  memory: { records: { id: string; kind: string; content: string; status: string; canRevoke: boolean }[] };
  feedback: { totalEvents: number; revokedEvents: number; outcomes: { outcome: string; count: number }[] };
  adaptive: {
    classificationLabel: string;
    explanation: string;
    inputs: AdaptiveInput[];
    effect: { pressureLevel: string; suggestionStyle: string };
    visibilityNote: string;
  };
}

interface DeletionReceipt {
  scopeId: string;
  deletedAt: string;
  remainingFeedbackEventCount: number;
  remainingRuntimeMemoryRecordCount: number;
  remainingPersistedProfileCount: number;
  emptyStateDigest: string;
}

const SOURCE_LABELS: Record<string, string> = {
  user_correction: 'You set this',
  derived_operative: 'Learned from your activity',
  product_default: 'Product default',
};

export default function PersonalizationPanel({ scopeId }: { scopeId: string }) {
  const [view, setView] = useState<InventoryView | null>(null);
  const [receipt, setReceipt] = useState<DeletionReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/personalization', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The instant travels with the request: the server reads no clock, so
        // every stored consent change and correction carries a time the user
        // could in principle be shown and we could reproduce.
        body: JSON.stringify({ scopeId, now: new Date().toISOString(), ...body }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload?.detail ?? payload?.code ?? 'The request was refused.');
        return null;
      }
      if (payload?.view) setView(payload.view as InventoryView);
      else if (payload?.consent === undefined && payload?.scopeId) setView(payload as InventoryView);
      if (payload?.receipt) setReceipt(payload.receipt as DeletionReceipt);
      return payload;
    } catch {
      setError('The control centre could not be reached.');
      return null;
    } finally {
      setBusy(false);
    }
  }, [scopeId]);

  const rows = view?.preferences.rows ?? [];
  const unavailable =
    view && view.preferences.kind !== 'derived' ? view.preferences.explanation : null;

  return (
    <div className="bg-white border border-blue-200 rounded-2xl p-6 space-y-6">
      <div>
        <h2 className="text-lg font-bold text-gray-800 mb-1">Personalization</h2>
        <p className="text-sm text-gray-600">
          What this product has worked out about you, where it came from, and how to change or remove it.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => void send({ action: 'inventory' })}
          className="px-3 py-2 rounded-lg bg-blue-600 text-white text-sm disabled:opacity-50">
          Show what you hold about me
        </button>
        <button type="button" disabled={busy} onClick={() => void send({ action: 'enable' })}
          className="px-3 py-2 rounded-lg border border-gray-300 text-sm disabled:opacity-50">
          Turn personalization on
        </button>
        <button type="button" disabled={busy} onClick={() => void send({ action: 'disable' })}
          className="px-3 py-2 rounded-lg border border-gray-300 text-sm disabled:opacity-50">
          Turn it off
        </button>
        <button type="button" disabled={busy} onClick={() => void send({ action: 'export' })}
          className="px-3 py-2 rounded-lg border border-gray-300 text-sm disabled:opacity-50">
          Export a copy
        </button>
        <button type="button" disabled={busy} onClick={() => void send({ action: 'delete' })}
          className="px-3 py-2 rounded-lg border border-red-300 text-red-700 text-sm disabled:opacity-50">
          Delete everything
        </button>
      </div>

      {error && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">{error}</p>}

      {view && (
        <>
          <p className="text-sm text-gray-700">
            Personalization is <strong>{view.consent.state === 'enabled' ? 'on' : 'off'}</strong>
            {view.consent.changedAt ? ` since ${view.consent.changedAt}` : ''}.
          </p>

          {unavailable && (
            <p className="text-sm text-gray-700 bg-amber-50 border border-amber-200 rounded-lg p-3">{unavailable}</p>
          )}

          <div className="space-y-3">
            {rows.map((row) => (
              <div key={row.dimension} className="border border-gray-200 rounded-xl p-4">
                <div className="flex justify-between gap-4 flex-wrap">
                  <span className="font-semibold text-gray-800">{row.label}</span>
                  <span className="text-sm text-gray-700">
                    <strong>{row.effective.level}</strong>
                    <span className="text-gray-500"> — {SOURCE_LABELS[row.effective.source] ?? row.effective.source}</span>
                  </span>
                </div>
                {row.reading && (
                  <div className="mt-2 text-sm text-gray-600 space-y-1">
                    <p>{row.reading.provenance}</p>
                    <p>{row.reading.confidenceExplanation}</p>
                    <p className="text-gray-500">{row.reading.whatWouldChangeIt}</p>
                  </div>
                )}
                {row.correction && (
                  <p className="mt-2 text-sm text-blue-700">
                    You set this to “{row.correction.level}”.{' '}
                    <button type="button" disabled={busy} className="underline"
                      onClick={() => void send({ action: 'clear_correction', dimension: row.dimension })}>
                      Undo
                    </button>
                  </p>
                )}
              </div>
            ))}
          </div>

          <div className="border border-purple-200 bg-purple-50 rounded-xl p-4">
            <h3 className="font-semibold text-gray-800">How this product classifies you</h3>
            <p className="text-sm text-gray-700 mt-1">{view.adaptive.explanation}</p>
            <ul className="mt-2 text-sm text-gray-700 space-y-1">
              {view.adaptive.inputs.map((input) => (
                <li key={input.name}>
                  <strong>{input.label}:</strong> {input.valueLabel}{' '}
                  <span className="text-gray-500">— {input.explanation}</span>
                </li>
              ))}
            </ul>
            <p className="text-sm text-gray-700 mt-2">
              As a result, reminders may carry <strong>{view.adaptive.effect.pressureLevel}</strong> pressure and
              suggestions are worded <strong>{view.adaptive.effect.suggestionStyle}</strong>.
            </p>
            <p className="text-xs text-gray-600 mt-2">{view.adaptive.visibilityNote}</p>
          </div>

          <div>
            <h3 className="font-semibold text-gray-800">What is stored</h3>
            <p className="text-sm text-gray-600">
              {view.feedback.totalEvents} recorded actions ({view.feedback.revokedEvents} withdrawn),
              {' '}{view.memory.records.length} remembered notes.
            </p>
            <ul className="mt-2 space-y-1">
              {view.memory.records.map((record) => (
                <li key={record.id} className="text-sm text-gray-700">
                  <span className="text-gray-500">[{record.status}]</span> {record.content}
                  {record.canRevoke && (
                    <button type="button" disabled={busy} className="ml-2 underline text-blue-700"
                      onClick={() => void send({ action: 'revoke_memory', recordId: record.id })}>
                      Withdraw
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      {receipt && (
        <div className="border border-green-300 bg-green-50 rounded-xl p-4 text-sm text-gray-800">
          <h3 className="font-semibold">Deletion receipt</h3>
          <p className="mt-1">Deleted at {receipt.deletedAt}. What remains, counted after the delete:</p>
          <ul className="mt-1 list-disc list-inside">
            <li>recorded actions: {receipt.remainingFeedbackEventCount}</li>
            <li>remembered notes: {receipt.remainingRuntimeMemoryRecordCount}</li>
            <li>stored profiles: {receipt.remainingPersistedProfileCount}</li>
          </ul>
          <p className="mt-2 break-all text-xs text-gray-600">
            Proof of the empty state: <code>{receipt.emptyStateDigest}</code>
          </p>
        </div>
      )}
    </div>
  );
}
