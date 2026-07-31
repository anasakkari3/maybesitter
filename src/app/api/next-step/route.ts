import { appendAnalyticsEvent } from '../../../../lib/analytics/eventStore';
import { getCommandServiceState } from '../../../../lib/services/commandService';
import { getLiveNextStep, recordLiveNextStepDecision } from '../../../../lib/services/nextStepLiveService';
import type { NextStepDecision, NextStepLocale, NextStepRecommendationContract } from '../../../contracts/v1/nextStepContracts';

export const dynamic = 'force-dynamic';

function locale(value: string | null): NextStepLocale {
  return value === 'ar' || value === 'he' ? value : 'en';
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const anonymousUserId = url.searchParams.get('anonymousUserId') || '';
  if (!anonymousUserId) return Response.json({ error: 'anonymousUserId is required' }, { status: 400 });
  const proposal = getLiveNextStep(getCommandServiceState(), {
    anonymousUserId, locale: locale(url.searchParams.get('locale')), consent: url.searchParams.get('consent') === 'granted' ? 'granted' : 'essential', now: new Date(), emit: appendAnalyticsEvent,
  });
  return Response.json(proposal);
}

export async function POST(request: Request) {
  const body = await request.json() as { proposal: NextStepRecommendationContract; decision: NextStepDecision; anonymousUserId: string; locale?: NextStepLocale; consent?: string; editedTitle?: string };
  if (!body.anonymousUserId) return Response.json({ error: 'anonymousUserId is required' }, { status: 400 });
  try {
    const outcome = recordLiveNextStepDecision(body.proposal, body.decision, {
      anonymousUserId: body.anonymousUserId, locale: body.locale || 'en', consent: body.consent === 'granted' ? 'granted' : 'essential', now: new Date(), emit: appendAnalyticsEvent,
    }, body.editedTitle);
    return Response.json(outcome);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'decision rejected' }, { status: 400 });
  }
}
