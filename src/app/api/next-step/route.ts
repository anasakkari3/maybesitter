import { appendAnalyticsEvent } from '../../../../lib/analytics/eventStore';
import { resolvePilotAccess } from '../../../../lib/pilot/pilotAccess';
import { getPilotTrustStore } from '../../../../lib/pilot/pilotTrustStore';
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
  try {
    const now = new Date();
    const access = resolvePilotAccess(anonymousUserId, now.toISOString());
    if (!access.decision.allowed || !access.trust) {
      return Response.json({ error: 'closed pilot recommendation unavailable', reason: access.decision.reason }, { status: 403 });
    }
    const proposal = getLiveNextStep(getCommandServiceState(), {
      anonymousUserId,
      locale: locale(url.searchParams.get('locale')),
      consent: access.trust.analyticsConsent ? 'granted' : 'essential',
      now,
      emit: appendAnalyticsEvent,
    });
    if (proposal.state === 'ready' && !access.trust.firstValueAt) {
      getPilotTrustStore().apply(anonymousUserId, { type: 'record_first_value', at: now.toISOString() });
    }
    return Response.json(proposal);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'closed pilot is not configured' }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const body = await request.json() as { proposal: NextStepRecommendationContract; decision: NextStepDecision; anonymousUserId: string; locale?: NextStepLocale; consent?: string; editedTitle?: string };
  if (!body.anonymousUserId) return Response.json({ error: 'anonymousUserId is required' }, { status: 400 });
  try {
    const now = new Date();
    const access = resolvePilotAccess(body.anonymousUserId, now.toISOString());
    if (!access.decision.allowed || !access.trust) {
      return Response.json({ error: 'closed pilot recommendation unavailable', reason: access.decision.reason }, { status: 403 });
    }
    const context = {
      anonymousUserId: body.anonymousUserId,
      locale: body.locale || 'en',
      consent: access.trust.analyticsConsent ? 'granted' as const : 'essential' as const,
      now,
      emit: appendAnalyticsEvent,
      emitShown: false,
    };
    const canonicalProposal = getLiveNextStep(getCommandServiceState(), context);
    if (canonicalProposal.state !== 'ready' || canonicalProposal.proposalId !== body.proposal?.proposalId) {
      return Response.json({ error: 'proposal is stale or invalid' }, { status: 409 });
    }
    const outcome = recordLiveNextStepDecision(canonicalProposal, body.decision, context, body.editedTitle);
    return Response.json(outcome);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'decision rejected' }, { status: 400 });
  }
}
