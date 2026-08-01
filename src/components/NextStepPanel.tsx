'use client';

import { useCallback, useEffect, useState } from 'react';
import NextStepReview from './NextStepReview';
import { pilotIdentity } from '@/utils/pilotIdentity';
import type { NextStepDecision, NextStepLocale, NextStepRecommendationContract } from '@/contracts/v1/nextStepContracts';

export default function NextStepPanel({ locale = 'en' }: { locale?: NextStepLocale }) {
  const [proposal, setProposal] = useState<NextStepRecommendationContract | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [utilityRating, setUtilityRating] = useState(0);
  const [invasivenessRating, setInvasivenessRating] = useState(0);
  const [ratingStatus, setRatingStatus] = useState('');
  const load = useCallback(async () => {
    const anonymousUserId = pilotIdentity();
    if (!anonymousUserId) { setError('A private pilot invitation is required for recommendations.'); return; }
    const params = new URLSearchParams({ anonymousUserId, locale });
    const response = await fetch(`/api/next-step?${params}`, { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok) throw new Error(body.reason === 'consent_required' ? 'Recommendation consent is required above.' : body.error || 'Could not load next step');
    setProposal(body);
    setError('');
    setUtilityRating(0);
    setInvasivenessRating(0);
    setRatingStatus('');
    if (body.state === 'ready') window.dispatchEvent(new Event('maybesitter:pilot-first-value'));
  }, [locale]);
  useEffect(() => {
    const reload = () => void load().catch((reason) => setError(String(reason)));
    reload();
    window.addEventListener('maybesitter:pilot-trust-changed', reload);
    window.addEventListener('maybesitter:capture-complete', reload);
    return () => {
      window.removeEventListener('maybesitter:pilot-trust-changed', reload);
      window.removeEventListener('maybesitter:capture-complete', reload);
    };
  }, [load]);
  const decide = async (decision: NextStepDecision) => {
    if (!proposal) return;
    const editedTitle = decision === 'edit' ? window.prompt('Edit the next step', proposal.primaryStep?.title || '') || '' : undefined;
    if (decision === 'edit' && !editedTitle) return;
    const response = await fetch('/api/next-step', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proposal, decision, editedTitle, anonymousUserId: pilotIdentity(), locale }) });
    const body = await response.json();
    if (!response.ok) { setError(body.error || 'Decision rejected'); return; }
    setStatus(body.status === 'confirmation_required' ? 'Decision recorded. Confirm before anything is saved.' : 'Decision recorded without penalty.');
  };
  const submitRating = async () => {
    if (!proposal || utilityRating < 1 || invasivenessRating < 1) return;
    const response = await fetch('/api/analytics', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        anonymousUserId: pilotIdentity(), eventName: 'recommendation_rated',
        properties: { proposalId: proposal.proposalId, utilityRating, invasivenessRating },
      }),
    });
    const body = await response.json();
    if (!response.ok) { setRatingStatus(body.error || 'Rating was not recorded.'); return; }
    setRatingStatus(body.recorded
      ? 'Thanks. Your privacy-safe rating was recorded.'
      : 'Turn on privacy-safe usage sharing above to submit this rating.');
  };
  if (error) return <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>;
  if (!proposal) return <p aria-live="polite">Loading one possible next step.</p>;
  return <div>
    <NextStepReview proposal={proposal} onDecision={(decision) => void decide(decision)} />
    {status && <p role="status" className="mt-2 text-sm text-gray-600">{status}</p>}
    {proposal.state === 'ready' && (
      <fieldset className="mt-4 rounded-xl border border-gray-200 bg-white p-4">
        <legend className="px-1 text-sm font-semibold text-gray-800">Rate this suggestion</legend>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <label className="text-sm text-gray-700">Usefulness
            <select aria-label="Usefulness rating" value={utilityRating} onChange={(event) => setUtilityRating(Number(event.target.value))} className="mt-1 block w-full rounded-lg border border-gray-200 p-2">
              <option value={0}>Select 1–5</option>
              {[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="text-sm text-gray-700">Invasiveness (higher is worse)
            <select aria-label="Invasiveness rating" value={invasivenessRating} onChange={(event) => setInvasivenessRating(Number(event.target.value))} className="mt-1 block w-full rounded-lg border border-gray-200 p-2">
              <option value={0}>Select 1–5</option>
              {[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
        </div>
        <button disabled={utilityRating < 1 || invasivenessRating < 1 || ratingStatus.startsWith('Thanks')} onClick={() => void submitRating()} className="mt-3 rounded-lg bg-gray-800 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Submit rating</button>
        {ratingStatus && <p role="status" className="mt-2 text-xs text-gray-600">{ratingStatus}</p>}
      </fieldset>
    )}
  </div>;
}
