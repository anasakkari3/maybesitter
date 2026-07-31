'use client';

import { useCallback, useEffect, useState } from 'react';
import NextStepReview from './NextStepReview';
import type { NextStepDecision, NextStepLocale, NextStepRecommendationContract } from '@/contracts/v1/nextStepContracts';

function identity(): string {
  const key = 'maybesitter:v02-anonymous-id';
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;
  const created = `pilot-${crypto.randomUUID()}`;
  window.localStorage.setItem(key, created);
  return created;
}

export default function NextStepPanel({ locale = 'en' }: { locale?: NextStepLocale }) {
  const [proposal, setProposal] = useState<NextStepRecommendationContract | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [analyticsConsent, setAnalyticsConsent] = useState(false);
  useEffect(() => { setAnalyticsConsent(window.localStorage.getItem('maybesitter:v02-analytics-consent') === 'granted'); }, []);
  const load = useCallback(async () => {
    const params = new URLSearchParams({ anonymousUserId: identity(), locale, consent: analyticsConsent ? 'granted' : 'essential' });
    const response = await fetch(`/api/next-step?${params}`, { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Could not load next step');
    setProposal(body);
  }, [locale, analyticsConsent]);
  useEffect(() => { void load().catch((reason) => setError(String(reason))); }, [load]);
  const decide = async (decision: NextStepDecision) => {
    if (!proposal) return;
    const editedTitle = decision === 'edit' ? window.prompt('Edit the next step', proposal.primaryStep?.title || '') || '' : undefined;
    if (decision === 'edit' && !editedTitle) return;
    const response = await fetch('/api/next-step', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proposal, decision, editedTitle, anonymousUserId: identity(), locale, consent: analyticsConsent ? 'granted' : 'essential' }) });
    const body = await response.json();
    if (!response.ok) { setError(body.error || 'Decision rejected'); return; }
    setStatus(body.status === 'confirmation_required' ? 'Decision recorded. Confirm before anything is saved.' : 'Decision recorded without penalty.');
  };
  if (error) return <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>;
  if (!proposal) return <p aria-live="polite">Loading one possible next step.</p>;
  return <div><NextStepReview proposal={proposal} onDecision={(decision) => void decide(decision)} /><label className="mt-3 flex items-center gap-2 text-sm text-gray-600"><input type="checkbox" checked={analyticsConsent} onChange={(event) => { const granted = event.target.checked; setAnalyticsConsent(granted); window.localStorage.setItem('maybesitter:v02-analytics-consent', granted ? 'granted' : 'denied'); }} />Share privacy-safe pilot usage events</label>{status && <p role="status" className="mt-2 text-sm text-gray-600">{status}</p>}</div>;
}
