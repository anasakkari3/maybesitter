import {
  evaluateActionPolicy,
  type ActionPolicyDecision,
  type ActionPolicyRequest,
  type ActionRiskTier,
} from '../../src/contracts/v1/actionPolicyContracts';

export type ExternalActionGatewayRoute =
  | 'read_context'
  | 'local_write'
  | 'external_action'
  | 'confirmation'
  | 'strong_confirmation'
  | 'blocked';

export interface ExternalActionGatewayRequest extends ActionPolicyRequest {
  readonly actionId: string;
  readonly idempotencyKey: string | null;
  readonly targetRef?: string | null;
}

export interface ExternalActionGatewayPlan {
  readonly actionId: string;
  readonly idempotencyKey: string | null;
  readonly provider: string | null;
  readonly capability: string;
  readonly route: ExternalActionGatewayRoute;
  readonly policyDecision: ActionPolicyDecision;
  readonly providerExecutionAllowed: boolean;
  readonly modelMaySelectRawProviderTool: false;
  readonly auditRequired: true;
}

export function planExternalActionGateway(request: ExternalActionGatewayRequest): ExternalActionGatewayPlan {
  const policyDecision = evaluateActionPolicy(request);
  const route = routeForDecision(policyDecision);

  return {
    actionId: request.actionId,
    idempotencyKey: request.idempotencyKey,
    provider: request.provider,
    capability: request.capability,
    route,
    policyDecision,
    providerExecutionAllowed: policyDecision.decision === 'allowed' && policyDecision.providerExecutionAllowed,
    modelMaySelectRawProviderTool: false,
    auditRequired: true,
  };
}

function routeForDecision(decision: ActionPolicyDecision): ExternalActionGatewayRoute {
  if (decision.decision === 'requires_confirmation') return 'confirmation';
  if (decision.decision === 'requires_strong_confirmation') return 'strong_confirmation';
  if (decision.decision === 'denied') return 'blocked';
  return routeForTier(decision.policy?.tier ?? 'unsupported');
}

function routeForTier(tier: ActionRiskTier): ExternalActionGatewayRoute {
  if (tier === 'read_only_context') return 'read_context';
  if (tier === 'low_risk_local_write') return 'local_write';
  if (tier === 'external_write' || tier === 'confirmation_required') return 'external_action';
  return 'blocked';
}
