/**
 * Provider-independent action policy contracts.
 *
 * External providers and MCP adapters execute capabilities only after the
 * product has classified the requested capability, checked permission, and
 * decided whether confirmation is required. The model chooses a capability;
 * it never chooses a raw provider tool.
 */

import { MODULE_CONTRACT_VERSION } from './moduleContracts';

export const ACTION_POLICY_CONTRACT_VERSION = MODULE_CONTRACT_VERSION;
export const ACTION_POLICY_SCHEMA_VERSION = 'action-policy-v1' as const;

export type ActionRiskTier =
  | 'read_only_context'
  | 'low_risk_local_write'
  | 'external_write'
  | 'confirmation_required'
  | 'strong_confirmation_required'
  | 'unsupported';

export type ConfirmationLevel =
  | 'none'
  | 'settings_allowed'
  | 'explicit_confirmation'
  | 'strong_confirmation'
  | 'unsupported';

export type CapabilityId =
  | 'read_calendar'
  | 'read_health'
  | 'read_email'
  | 'read_external_task'
  | 'read_meeting_context'
  | 'read_note_context'
  | 'read_mcp_context'
  | 'create_local_reminder'
  | 'update_local_plan'
  | 'create_local_proposal'
  | 'update_local_context'
  | 'create_calendar_event'
  | 'create_external_task'
  | 'update_external_task'
  | 'draft_email'
  | 'send_email'
  | 'reschedule_external_event'
  | 'delete_external_data'
  | 'spend_money'
  | 'mcp_lookup_context'
  | 'mcp_execute_capability';

export type ActionSubjectKind =
  | 'calendar'
  | 'health'
  | 'email'
  | 'task'
  | 'meeting'
  | 'note'
  | 'reminder'
  | 'plan'
  | 'mcp'
  | 'billing'
  | 'unknown';

export interface ActionCapabilityPolicy {
  readonly capability: CapabilityId;
  readonly subject: ActionSubjectKind;
  readonly tier: ActionRiskTier;
  readonly confirmation: ConfirmationLevel;
  readonly providerExecutionAllowed: boolean;
  readonly modelMaySelectRawProviderTool: false;
  readonly auditRequired: boolean;
}

export const ACTION_CAPABILITY_POLICIES: readonly ActionCapabilityPolicy[] = Object.freeze([
  {
    capability: 'read_calendar',
    subject: 'calendar',
    tier: 'read_only_context',
    confirmation: 'none',
    providerExecutionAllowed: true,
    modelMaySelectRawProviderTool: false,
    auditRequired: true,
  },
  {
    capability: 'read_health',
    subject: 'health',
    tier: 'read_only_context',
    confirmation: 'none',
    providerExecutionAllowed: true,
    modelMaySelectRawProviderTool: false,
    auditRequired: true,
  },
  {
    capability: 'read_email',
    subject: 'email',
    tier: 'read_only_context',
    confirmation: 'none',
    providerExecutionAllowed: true,
    modelMaySelectRawProviderTool: false,
    auditRequired: true,
  },
  {
    capability: 'read_external_task',
    subject: 'task',
    tier: 'read_only_context',
    confirmation: 'none',
    providerExecutionAllowed: true,
    modelMaySelectRawProviderTool: false,
    auditRequired: true,
  },
  {
    capability: 'read_meeting_context',
    subject: 'meeting',
    tier: 'read_only_context',
    confirmation: 'none',
    providerExecutionAllowed: true,
    modelMaySelectRawProviderTool: false,
    auditRequired: true,
  },
  {
    capability: 'read_note_context',
    subject: 'note',
    tier: 'read_only_context',
    confirmation: 'none',
    providerExecutionAllowed: true,
    modelMaySelectRawProviderTool: false,
    auditRequired: true,
  },
  {
    capability: 'read_mcp_context',
    subject: 'mcp',
    tier: 'read_only_context',
    confirmation: 'none',
    providerExecutionAllowed: true,
    modelMaySelectRawProviderTool: false,
    auditRequired: true,
  },
  {
    capability: 'mcp_lookup_context',
    subject: 'mcp',
    tier: 'read_only_context',
    confirmation: 'none',
    providerExecutionAllowed: true,
    modelMaySelectRawProviderTool: false,
    auditRequired: true,
  },
  {
    capability: 'create_local_reminder',
    subject: 'reminder',
    tier: 'low_risk_local_write',
    confirmation: 'settings_allowed',
    providerExecutionAllowed: true,
    modelMaySelectRawProviderTool: false,
    auditRequired: true,
  },
  {
    capability: 'update_local_plan',
    subject: 'plan',
    tier: 'low_risk_local_write',
    confirmation: 'settings_allowed',
    providerExecutionAllowed: true,
    modelMaySelectRawProviderTool: false,
    auditRequired: true,
  },
  {
    // Watcher effects (#525): a proposal is only ever a proposal, and a
    // context update only refreshes watcher-held baselines. Both are local,
    // low-risk writes — the rows exist so a watcher firing is a policy
    // decision, not an assumption.
    capability: 'create_local_proposal',
    subject: 'task',
    tier: 'low_risk_local_write',
    confirmation: 'settings_allowed',
    providerExecutionAllowed: true,
    modelMaySelectRawProviderTool: false,
    auditRequired: true,
  },
  {
    capability: 'update_local_context',
    subject: 'plan',
    tier: 'low_risk_local_write',
    confirmation: 'settings_allowed',
    providerExecutionAllowed: true,
    modelMaySelectRawProviderTool: false,
    auditRequired: true,
  },
  {
    capability: 'create_calendar_event',
    subject: 'calendar',
    tier: 'external_write',
    confirmation: 'settings_allowed',
    providerExecutionAllowed: true,
    modelMaySelectRawProviderTool: false,
    auditRequired: true,
  },
  {
    capability: 'create_external_task',
    subject: 'task',
    tier: 'external_write',
    confirmation: 'settings_allowed',
    providerExecutionAllowed: true,
    modelMaySelectRawProviderTool: false,
    auditRequired: true,
  },
  {
    capability: 'update_external_task',
    subject: 'task',
    tier: 'external_write',
    confirmation: 'settings_allowed',
    providerExecutionAllowed: true,
    modelMaySelectRawProviderTool: false,
    auditRequired: true,
  },
  {
    capability: 'draft_email',
    subject: 'email',
    tier: 'external_write',
    confirmation: 'explicit_confirmation',
    providerExecutionAllowed: true,
    modelMaySelectRawProviderTool: false,
    auditRequired: true,
  },
  {
    capability: 'mcp_execute_capability',
    subject: 'mcp',
    tier: 'external_write',
    confirmation: 'explicit_confirmation',
    providerExecutionAllowed: true,
    modelMaySelectRawProviderTool: false,
    auditRequired: true,
  },
  {
    capability: 'send_email',
    subject: 'email',
    tier: 'confirmation_required',
    confirmation: 'explicit_confirmation',
    providerExecutionAllowed: true,
    modelMaySelectRawProviderTool: false,
    auditRequired: true,
  },
  {
    capability: 'reschedule_external_event',
    subject: 'calendar',
    tier: 'confirmation_required',
    confirmation: 'explicit_confirmation',
    providerExecutionAllowed: true,
    modelMaySelectRawProviderTool: false,
    auditRequired: true,
  },
  {
    capability: 'delete_external_data',
    subject: 'unknown',
    tier: 'strong_confirmation_required',
    confirmation: 'strong_confirmation',
    providerExecutionAllowed: true,
    modelMaySelectRawProviderTool: false,
    auditRequired: true,
  },
  {
    capability: 'spend_money',
    subject: 'billing',
    tier: 'unsupported',
    confirmation: 'unsupported',
    providerExecutionAllowed: false,
    modelMaySelectRawProviderTool: false,
    auditRequired: true,
  },
] as const);

export type ActionPolicyDecisionKind =
  | 'allowed'
  | 'requires_confirmation'
  | 'requires_strong_confirmation'
  | 'denied';

export interface ActionPolicyRequest {
  readonly capability: CapabilityId | string;
  readonly provider: string | null;
  readonly actor: 'user' | 'model' | 'system';
  readonly userConfirmed: boolean;
  readonly strongConfirmation: boolean;
  readonly settingsAllowAutomaticExternalWrites: boolean;
}

export interface ActionPolicyDecision {
  readonly version: typeof ACTION_POLICY_CONTRACT_VERSION;
  readonly schemaVersion: typeof ACTION_POLICY_SCHEMA_VERSION;
  readonly decision: ActionPolicyDecisionKind;
  readonly policy: ActionCapabilityPolicy | null;
  readonly reason:
    | 'policy_allows'
    | 'confirmation_required'
    | 'strong_confirmation_required'
    | 'unknown_capability'
    | 'unsupported_capability'
    | 'raw_provider_tool_denied';
  readonly providerExecutionAllowed: boolean;
  readonly auditRequired: true;
}

export function policyForCapability(capability: string): ActionCapabilityPolicy | null {
  return ACTION_CAPABILITY_POLICIES.find((policy) => policy.capability === capability) ?? null;
}

export function evaluateActionPolicy(request: ActionPolicyRequest): ActionPolicyDecision {
  if (request.capability.includes('.') || request.capability.includes('/')) {
    return denied('raw_provider_tool_denied', null);
  }

  const policy = policyForCapability(request.capability);
  if (!policy) return denied('unknown_capability', null);
  if (policy.tier === 'unsupported') return denied('unsupported_capability', policy);
  if (policy.confirmation === 'strong_confirmation' && !request.strongConfirmation) {
    return {
      version: ACTION_POLICY_CONTRACT_VERSION,
      schemaVersion: ACTION_POLICY_SCHEMA_VERSION,
      decision: 'requires_strong_confirmation',
      policy,
      reason: 'strong_confirmation_required',
      providerExecutionAllowed: false,
      auditRequired: true,
    };
  }
  if (policy.confirmation === 'explicit_confirmation' && !request.userConfirmed) {
    return {
      version: ACTION_POLICY_CONTRACT_VERSION,
      schemaVersion: ACTION_POLICY_SCHEMA_VERSION,
      decision: 'requires_confirmation',
      policy,
      reason: 'confirmation_required',
      providerExecutionAllowed: false,
      auditRequired: true,
    };
  }
  if (policy.confirmation === 'settings_allowed' && policy.tier === 'external_write') {
    if (!request.settingsAllowAutomaticExternalWrites && !request.userConfirmed) {
      return {
        version: ACTION_POLICY_CONTRACT_VERSION,
        schemaVersion: ACTION_POLICY_SCHEMA_VERSION,
        decision: 'requires_confirmation',
        policy,
        reason: 'confirmation_required',
        providerExecutionAllowed: false,
        auditRequired: true,
      };
    }
  }

  return {
    version: ACTION_POLICY_CONTRACT_VERSION,
    schemaVersion: ACTION_POLICY_SCHEMA_VERSION,
    decision: 'allowed',
    policy,
    reason: 'policy_allows',
    providerExecutionAllowed: policy.providerExecutionAllowed,
    auditRequired: true,
  };
}

function denied(
  reason: ActionPolicyDecision['reason'],
  policy: ActionCapabilityPolicy | null,
): ActionPolicyDecision {
  return {
    version: ACTION_POLICY_CONTRACT_VERSION,
    schemaVersion: ACTION_POLICY_SCHEMA_VERSION,
    decision: 'denied',
    policy,
    reason,
    providerExecutionAllowed: false,
    auditRequired: true,
  };
}
