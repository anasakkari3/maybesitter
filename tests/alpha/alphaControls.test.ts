/**
 * Tests for the trusted-alpha allowlist controls and the OR'd membership.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAlphaAllowlist,
  isAlphaParticipant,
  alphaAllowlistConfigured,
} from '../../lib/pilot/alphaControls';
import { resolvePilotAccess } from '../../lib/pilot/pilotAccess';

test('alpha allowlist: parses 1–10 pseudonymous ids', () => {
  assert.deepEqual(Array.from(parseAlphaAllowlist('alpha-001')), ['alpha-001']);
  assert.equal(parseAlphaAllowlist('alpha-001,alpha-002').size, 2);
  assert.throws(() => parseAlphaAllowlist(''), /1–10/);
  assert.throws(() => parseAlphaAllowlist('alpha-001,alpha-001'), /duplicates/);
  assert.throws(() => parseAlphaAllowlist('Real Name'), /pseudonymous/);
  const big = Array.from({ length: 11 }, (_, i) => `alpha-${String(i).padStart(3, '0')}`).join(',');
  assert.throws(() => parseAlphaAllowlist(big), /1–10/);
});

test('alpha allowlist: membership only when configured', () => {
  assert.equal(alphaAllowlistConfigured({ MAYBESITTER_ALPHA_IDS: 'alpha-001' }), true);
  assert.equal(alphaAllowlistConfigured({}), false);
  assert.equal(isAlphaParticipant('alpha-001', { MAYBESITTER_ALPHA_IDS: 'alpha-001' }), true);
  assert.equal(isAlphaParticipant('alpha-002', { MAYBESITTER_ALPHA_IDS: 'alpha-001' }), false);
  assert.equal(isAlphaParticipant('alpha-001', {}), false);
  // invalid config fails closed
  assert.equal(isAlphaParticipant('alpha-001', { MAYBESITTER_ALPHA_IDS: 'too many,ids,here,for,the,parser' }), false);
});

test('alpha allowlist: resolvePilotAccess admits alpha member without closed allowlist', () => {
  const oldClosed = process.env.MAYBESITTER_CLOSED_PILOT_IDS;
  const oldAlpha = process.env.MAYBESITTER_ALPHA_IDS;
  delete process.env.MAYBESITTER_CLOSED_PILOT_IDS;
  process.env.MAYBESITTER_ALPHA_IDS = 'alpha-001';
  try {
    const result = resolvePilotAccess('alpha-001', new Date().toISOString());
    // Admission = not allowlist-rejected; a fresh trust record is still
    // consent-gated (expected product behavior), never 'not_allowlisted'.
    assert.notEqual(result.decision.reason, 'not_allowlisted', 'alpha member must be admitted');
    assert.ok(result.trust, 'trust record must exist for alpha member');
  } finally {
    if (oldClosed === undefined) delete process.env.MAYBESITTER_CLOSED_PILOT_IDS;
    else process.env.MAYBESITTER_CLOSED_PILOT_IDS = oldClosed;
    if (oldAlpha === undefined) delete process.env.MAYBESITTER_ALPHA_IDS;
    else process.env.MAYBESITTER_ALPHA_IDS = oldAlpha;
  }
});

test('alpha allowlist: non-member rejected when no closed allowlist', () => {
  const oldClosed = process.env.MAYBESITTER_CLOSED_PILOT_IDS;
  const oldAlpha = process.env.MAYBESITTER_ALPHA_IDS;
  delete process.env.MAYBESITTER_CLOSED_PILOT_IDS;
  process.env.MAYBESITTER_ALPHA_IDS = 'alpha-001';
  try {
    const result = resolvePilotAccess('alpha-999', new Date().toISOString());
    assert.equal(result.decision.allowed, false);
    assert.equal(result.decision.reason, 'not_allowlisted');
  } finally {
    if (oldClosed === undefined) delete process.env.MAYBESITTER_CLOSED_PILOT_IDS;
    else process.env.MAYBESITTER_CLOSED_PILOT_IDS = oldClosed;
    if (oldAlpha === undefined) delete process.env.MAYBESITTER_ALPHA_IDS;
    else process.env.MAYBESITTER_ALPHA_IDS = oldAlpha;
  }
});
