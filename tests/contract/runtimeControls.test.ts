import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INTELLIGENCE_MODULES,
  MODULE_CONTRACT_VERSION,
} from '../../src/contracts/v1/moduleContracts.ts';
import {
  MODULE_FEATURE_FLAG_DEFAULTS,
  MODULE_KILL_SWITCH_DEFAULTS,
  createAuditEvent,
  readRuntimeControls,
  resolveModuleRuntime,
  type AuditSafeFields,
} from '../../src/contracts/v1/runtimeControls.ts';

test('runtime defaults preserve capture and keep future modules off', () => {
  assert.equal(MODULE_FEATURE_FLAG_DEFAULTS.capture, true);

  for (const module of INTELLIGENCE_MODULES) {
    assert.equal(MODULE_KILL_SWITCH_DEFAULTS[module], false);
    if (module !== 'capture') {
      assert.equal(MODULE_FEATURE_FLAG_DEFAULTS[module], false);
    }
  }
});

test('environment controls are typed per module and invalid values fail closed to defaults', () => {
  const controls = readRuntimeControls({
    MAYBESITTER_FEATURE_RECOMMENDATION: 'true',
    MAYBESITTER_KILL_SWITCH_RECOMMENDATION: 'true',
    MAYBESITTER_FEATURE_CAPTURE: 'not-a-boolean',
  });

  assert.equal(controls.version, MODULE_CONTRACT_VERSION);
  assert.equal(controls.featureFlags.recommendation, true);
  assert.equal(controls.killSwitches.recommendation, true);
  assert.equal(controls.featureFlags.capture, true);
});

test('a module kill switch selects rules-only fallback without disabling capture', () => {
  const controls = readRuntimeControls({
    MAYBESITTER_FEATURE_RECOMMENDATION: 'true',
    MAYBESITTER_KILL_SWITCH_RECOMMENDATION: 'true',
  });

  const recommendation = resolveModuleRuntime('recommendation', controls);
  const capture = resolveModuleRuntime('capture', controls);

  assert.equal(recommendation.mode, 'rules_only');
  if (recommendation.mode === 'rules_only') {
    assert.equal(recommendation.reason, 'kill_switch_active');
    assert.equal(recommendation.allowsModelExecution, false);
    assert.equal(recommendation.allowsDirectStateWrites, false);
    assert.equal(recommendation.captureRemainsAvailable, true);
  }
  assert.equal(capture.mode, 'enabled');
});

test('disabled future modules return an explicit rules-only contract', () => {
  const decision = resolveModuleRuntime('planning', readRuntimeControls({}));
  assert.equal(decision.mode, 'rules_only');
  if (decision.mode === 'rules_only') {
    assert.equal(decision.reason, 'feature_disabled');
    assert.equal(decision.captureRemainsAvailable, true);
  }
});

test('audit envelope carries correlation IDs and drops raw sensitive fields', () => {
  const unsafeFields = {
    outcome: 'fell_back',
    reasonCode: 'kill_switch_active',
    inputHash: 'sha256:example',
    inputLength: 21,
    rulesOnly: true,
    rawText: 'call my doctor tomorrow',
    prompt: 'private prompt',
  } as AuditSafeFields;

  const event = createAuditEvent({
    eventId: 'event-1',
    eventType: 'module_runtime_decision',
    occurredAt: '2026-08-03T09:00:00.000Z',
    correlationId: 'correlation-1',
    causationId: 'request-1',
    module: 'recommendation',
    fields: unsafeFields,
  });

  assert.equal(event.correlationId, 'correlation-1');
  assert.equal(event.causationId, 'request-1');
  assert.equal(event.fields.inputLength, 21);
  assert.equal('rawText' in event.fields, false);
  assert.equal('prompt' in event.fields, false);
  assert.equal(JSON.stringify(event).includes('call my doctor'), false);
});

