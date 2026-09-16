import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NATIVE_READINESS_PRIVACY_POLICY,
  type NativeReadinessResult,
} from '../../lib/integrations/readiness/nativeAdapterContracts';

test('native readiness adapters share one provider-independent privacy boundary', () => {
  const result: NativeReadinessResult = {
    state: 'empty',
    authorization: 'authorized',
    snapshot: null,
    provenance: {
      source: 'healthkit',
      connectionId: null,
      collectedAt: '2026-09-16T12:00:00.000Z',
      newestSampleAt: null,
      rawPayloadPersisted: false,
    },
    errorCode: null,
  };

  assert.deepEqual(NATIVE_READINESS_PRIVACY_POLICY, {
    rawPayloadLoggingAllowed: false,
    rawPayloadPersistenceAllowed: false,
    medicalInterpretationAllowed: false,
  });
  assert.equal(result.provenance.rawPayloadPersisted, false);
  assert.equal('rawPayload' in result, false);
});
