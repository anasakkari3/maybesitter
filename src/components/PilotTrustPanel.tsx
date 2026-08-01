'use client';

import { useCallback, useEffect, useState } from 'react';
import { clearPilotIdentity, pilotIdentity } from '@/utils/pilotIdentity';

type TrustView = {
  trust: {
    recommendationConsent: boolean;
    analyticsConsent: boolean;
    calendarConsent: boolean;
    firstValueAt: string | null;
    quietMode: boolean;
    revokedAt: string | null;
    deletedAt: string | null;
  };
  exposure: { allowed: boolean; reason: string };
  whatKnows: {
    confirmedCommitmentCount: number;
    privateMessageIngestion: false;
    sensitiveInference: false;
    medicalProfile: false;
  };
};

export default function PilotTrustPanel() {
  const [participantId, setParticipantId] = useState('');
  const [view, setView] = useState<TrustView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reported, setReported] = useState(false);

  const load = useCallback(async (id: string) => {
    if (!id) return;
    const response = await fetch(`/api/pilot/trust?participantId=${encodeURIComponent(id)}`, { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Pilot trust controls are unavailable');
    setView(body);
    setError('');
  }, []);

  useEffect(() => {
    const id = pilotIdentity();
    setParticipantId(id);
    if (id) void load(id).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    const reload = () => { if (id) void load(id).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))); };
    window.addEventListener('maybesitter:pilot-first-value', reload);
    return () => window.removeEventListener('maybesitter:pilot-first-value', reload);
  }, [load]);

  const act = async (action: Record<string, unknown>) => {
    if (!participantId || busy) return;
    setBusy(true);
    try {
      const response = await fetch('/api/pilot/trust', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ participantId, action }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Trust control update failed');
      setView(body);
      setError('');
      window.dispatchEvent(new Event('maybesitter:pilot-trust-changed'));
      if (action.type === 'delete') clearPilotIdentity();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const reportIssue = async () => {
    if (!participantId || busy) return;
    setBusy(true);
    try {
      const response = await fetch('/api/pilot/incidents', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ participantId, surface: 'recommendation', category: 'other' }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Issue report failed');
      setReported(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  if (!participantId) {
    return (
      <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5" aria-labelledby="pilot-trust-title">
        <h2 id="pilot-trust-title" className="font-bold text-gray-900">Closed pilot</h2>
        <p className="mt-1 text-sm text-gray-700">Open the private invitation link supplied by the pilot owner. Recommendations are unavailable without an allowlisted pilot ID.</p>
      </section>
    );
  }

  if (!view) {
    return <section className="rounded-2xl border border-gray-200 bg-white p-5"><h2 className="font-bold">Closed pilot</h2><p role={error ? 'alert' : 'status'} className="mt-1 text-sm text-gray-600">{error || 'Loading trust controls…'}</p></section>;
  }

  const stopped = Boolean(view.trust.revokedAt || view.trust.deletedAt);
  return (
    <section className="rounded-2xl border border-blue-200 bg-white p-5" aria-labelledby="pilot-trust-title">
      <h2 id="pilot-trust-title" className="font-bold text-gray-900">What MaybeSitter knows</h2>
      <p className="mt-1 text-sm text-gray-600">{view.whatKnows.confirmedCommitmentCount} confirmed commitments. Private messages, sensitive inference, and medical profiling are off.</p>
      <div className="mt-4 space-y-3 text-sm">
        {!view.trust.recommendationConsent && !stopped && (
          <div className="rounded-xl bg-blue-50 p-3">
            <p className="text-gray-700">Join the narrow recommendation pilot. Suggestions are optional and never save a decision without confirmation.</p>
            <button disabled={busy} onClick={() => void act({ type: 'grant_recommendation_consent' })} className="mt-2 rounded-lg bg-blue-600 px-3 py-2 font-semibold text-white disabled:opacity-50">Consent to recommendations</button>
          </div>
        )}
        <label className="flex items-center justify-between gap-4">
          <span>Share privacy-safe usage events</span>
          <input type="checkbox" disabled={busy || stopped} checked={view.trust.analyticsConsent} onChange={(event) => void act({ type: 'set_analytics_consent', granted: event.target.checked })} />
        </label>
        <label className="flex items-center justify-between gap-4">
          <span>Connect the optional calendar{!view.trust.firstValueAt ? ' (available after first value)' : ''}</span>
          <input type="checkbox" disabled={busy || stopped || !view.trust.firstValueAt} checked={view.trust.calendarConsent} onChange={(event) => void act({ type: 'set_calendar_consent', granted: event.target.checked })} />
        </label>
        <label className="flex items-center justify-between gap-4">
          <span>Quiet mode (stop recommendations, keep data)</span>
          <input type="checkbox" disabled={busy || stopped} checked={view.trust.quietMode} onChange={(event) => void act({ type: 'set_quiet_mode', enabled: event.target.checked })} />
        </label>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button disabled={busy || stopped} onClick={() => void act({ type: 'revoke' })} className="rounded-lg bg-orange-100 px-3 py-2 text-sm font-semibold text-orange-800 disabled:opacity-50">Revoke pilot consent</button>
        <button disabled={busy || Boolean(view.trust.deletedAt)} onClick={() => { if (window.confirm('Permanently delete pilot data? This cannot be undone.')) void act({ type: 'delete' }); }} className="rounded-lg bg-red-100 px-3 py-2 text-sm font-semibold text-red-800 disabled:opacity-50">Delete pilot data</button>
        <button disabled={busy || reported} onClick={() => void reportIssue()} className="rounded-lg bg-gray-100 px-3 py-2 text-sm font-semibold text-gray-700 disabled:opacity-50">{reported ? 'Issue reported' : 'Report a trust issue'}</button>
      </div>
      <p className="mt-3 text-xs text-gray-500">Recommendation access: {view.exposure.allowed ? 'on' : `off (${view.exposure.reason})`}. Quiet mode and revocation preserve commitments so you can export or delete them later.</p>
      {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
    </section>
  );
}
