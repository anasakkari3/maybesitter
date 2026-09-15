import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTION_CAPABILITY_POLICIES,
  ACTION_POLICY_CONTRACT_VERSION,
  ACTION_POLICY_SCHEMA_VERSION,
  evaluateActionPolicy,
  policyForCapability,
  type CapabilityId,
} from '../../src/contracts/v1/actionPolicyContracts.ts';
import { MODULE_CONTRACT_VERSION } from '../../src/contracts/v1/moduleContracts.ts';

test('action policy vocabulary is versioned and machine-readable', () => {
  assert.equal(ACTION_POLICY_CONTRACT_VERSION, MODULE_CONTRACT_VERSION);
  assert.equal(ACTION_POLICY_SCHEMA_VERSION, 'action-policy-v1');

  const capabilities = new Set(ACTION_CAPABILITY_POLICIES.map((policy) => policy.capability));
  const expectedCapabilities: readonly CapabilityId[] = [
    'read_calendar',
    'read_health',
    'read_email',
    'read_external_task',
    'create_local_reminder',
    'create_calendar_event',
    'create_external_task',
    'update_external_task',
    'draft_email',
    'send_email',
    'delete_external_data',
    'mcp_lookup_context',
    'mcp_execute_capability',
  ];

  for (const capability of expectedCapabilities) {
    assert.equal(capabilities.has(capability), true, `${capability} is missing`);
  }

  for (const policy of ACTION_CAPABILITY_POLICIES) {
    assert.equal(policy.modelMaySelectRawProviderTool, false);
    assert.equal(policy.auditRequired, true);
  }
});

test('read-only context is allowed after connection-level consent', () => {
  const decision = evaluateActionPolicy({
    capability: 'read_calendar',
    provider: 'google',
    actor: 'system',
    userConfirmed: false,
    strongConfirmation: false,
    settingsAllowAutomaticExternalWrites: false,
  });

  assert.equal(decision.decision, 'allowed');
  assert.equal(decision.policy?.tier, 'read_only_context');
  assert.equal(decision.providerExecutionAllowed, true);
});

test('external writes require settings or explicit confirmation', () => {
  const blocked = evaluateActionPolicy({
    capability: 'create_external_task',
    provider: 'todoist',
    actor: 'model',
    userConfirmed: false,
    strongConfirmation: false,
    settingsAllowAutomaticExternalWrites: false,
  });
  assert.equal(blocked.decision, 'requires_confirmation');
  assert.equal(blocked.reason, 'confirmation_required');
  assert.equal(blocked.providerExecutionAllowed, false);

  const allowedByConfirmation = evaluateActionPolicy({
    capability: 'create_external_task',
    provider: 'todoist',
    actor: 'model',
    userConfirmed: true,
    strongConfirmation: false,
    settingsAllowAutomaticExternalWrites: false,
  });
  assert.equal(allowedByConfirmation.decision, 'allowed');
  assert.equal(allowedByConfirmation.providerExecutionAllowed, true);

  const allowedBySetting = evaluateActionPolicy({
    capability: 'create_external_task',
    provider: 'todoist',
    actor: 'model',
    userConfirmed: false,
    strongConfirmation: false,
    settingsAllowAutomaticExternalWrites: true,
  });
  assert.equal(allowedBySetting.decision, 'allowed');
});

test('email send and MCP execution are confirmation-gated', () => {
  assert.equal(policyForCapability('send_email')?.confirmation, 'explicit_confirmation');
  assert.equal(policyForCapability('mcp_execute_capability')?.confirmation, 'explicit_confirmation');

  const send = evaluateActionPolicy({
    capability: 'send_email',
    provider: 'google',
    actor: 'model',
    userConfirmed: false,
    strongConfirmation: false,
    settingsAllowAutomaticExternalWrites: true,
  });
  assert.equal(send.decision, 'requires_confirmation');

  const mcp = evaluateActionPolicy({
    capability: 'mcp_execute_capability',
    provider: 'pipedream',
    actor: 'model',
    userConfirmed: true,
    strongConfirmation: false,
    settingsAllowAutomaticExternalWrites: true,
  });
  assert.equal(mcp.decision, 'allowed');
  assert.equal(mcp.policy?.modelMaySelectRawProviderTool, false);
});

test('strong and unsupported actions fail closed', () => {
  const deleteExternal = evaluateActionPolicy({
    capability: 'delete_external_data',
    provider: 'microsoft',
    actor: 'model',
    userConfirmed: true,
    strongConfirmation: false,
    settingsAllowAutomaticExternalWrites: true,
  });
  assert.equal(deleteExternal.decision, 'requires_strong_confirmation');
  assert.equal(deleteExternal.providerExecutionAllowed, false);

  const money = evaluateActionPolicy({
    capability: 'spend_money',
    provider: 'billing',
    actor: 'model',
    userConfirmed: true,
    strongConfirmation: true,
    settingsAllowAutomaticExternalWrites: true,
  });
  assert.equal(money.decision, 'denied');
  assert.equal(money.reason, 'unsupported_capability');
  assert.equal(money.providerExecutionAllowed, false);
});

test('unknown capabilities and raw provider tool names are denied', () => {
  const unknown = evaluateActionPolicy({
    capability: 'raw_delete_calendar',
    provider: 'google',
    actor: 'model',
    userConfirmed: true,
    strongConfirmation: true,
    settingsAllowAutomaticExternalWrites: true,
  });
  assert.equal(unknown.decision, 'denied');
  assert.equal(unknown.reason, 'unknown_capability');

  const rawTool = evaluateActionPolicy({
    capability: 'gmail.users.messages.send',
    provider: 'google',
    actor: 'model',
    userConfirmed: true,
    strongConfirmation: true,
    settingsAllowAutomaticExternalWrites: true,
  });
  assert.equal(rawTool.decision, 'denied');
  assert.equal(rawTool.reason, 'raw_provider_tool_denied');
});
