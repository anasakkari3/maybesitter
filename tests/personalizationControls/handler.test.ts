/**
 * The control-centre handler: every action, and every way to get them wrong.
 *
 * These run against the library rather than the route, because the route is
 * three lines of JSON parsing and everything worth pinning is below it. The one
 * thing the route owns — a body that is not JSON at all — is covered by the
 * handler's `MALFORMED_REQUEST_BODY` for the case it *can* see, and by the
 * route's own catch for the case it cannot.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createInMemoryFeedbackEventStore } from '../../lib/feedback/feedbackEventStore.ts';
import { createInMemoryRuntimeMemoryStore } from '../../lib/runtimeMemory/runtimeMemoryStore.ts';
import { createInMemoryPersonalizationConsentStore } from '../../lib/personalizationControls/consentStore.ts';
import { handleControlsRequest, CONTROLS_REJECTION_CODES } from '../../lib/personalizationControls/handler.ts';
import type { PersonalizationControlsPort } from '../../lib/personalizationControls/controlsPort.ts';
import { readCorrections } from '../../lib/personalizationControls/correction.ts';
import {
  PREFERENCE_DIMENSIONS,
  PREFERENCE_LEVEL_VOCABULARY,
} from '../../src/contracts/v1/personalizationContracts.ts';
import { createFixtureDeriver } from './helpers/fixtureDeriver.ts';

const SCOPE = 'scope-handler';
const NOW = '2026-08-20T12:00:00.000Z';

function makePort(overrides: Partial<PersonalizationControlsPort> = {}): PersonalizationControlsPort {
  return {
    feedback: createInMemoryFeedbackEventStore(),
    memory: createInMemoryRuntimeMemoryStore(),
    consent: createInMemoryPersonalizationConsentStore(),
    deriver: createFixtureDeriver({}).deriver,
    readAdaptiveSignals: () => ({ ignoredCommitmentsCount: 4, completionRate: 0.3, delayFrequency: 0.7 }),
    ...overrides,
  };
}

function call(port: PersonalizationControlsPort, body: unknown, deleteScope?: (s: string, n: string) => unknown) {
  return handleControlsRequest({ port, deleteScope }, body);
}

function rejectionOf(outcome: ReturnType<typeof call>): string {
  const response = outcome.response as { kind?: string; code?: string };
  assert.equal(response.kind, 'rejected', `expected a rejection, got ${JSON.stringify(outcome.response).slice(0, 120)}`);
  return response.code ?? '';
}

/* ── Hostile input is reported, never thrown ─────────────────────── */

test('every malformed request is reported with a named code and no throw', () => {
  const port = makePort();
  const cases: [unknown, string][] = [
    [null, 'MALFORMED_REQUEST_BODY'],
    ['a string', 'MALFORMED_REQUEST_BODY'],
    [[], 'MALFORMED_REQUEST_BODY'],
    [{}, 'MISSING_SCOPE'],
    [{ scopeId: '' }, 'MISSING_SCOPE'],
    [{ scopeId: SCOPE }, 'MISSING_INSTANT'],
    [{ scopeId: SCOPE, now: 42 }, 'MISSING_INSTANT'],
    [{ scopeId: SCOPE, now: NOW }, 'UNKNOWN_ACTION'],
    [{ scopeId: SCOPE, now: NOW, action: 'sudo' }, 'UNKNOWN_ACTION'],
    [{ scopeId: SCOPE, now: NOW, action: 'correct' }, 'UNKNOWN_DIMENSION'],
    [{ scopeId: SCOPE, now: NOW, action: 'correct', dimension: 'vibes' }, 'UNKNOWN_DIMENSION'],
    [{ scopeId: SCOPE, now: NOW, action: 'correct', dimension: 'pressure_tone' }, 'UNKNOWN_LEVEL'],
    [{ scopeId: SCOPE, now: NOW, action: 'correct', dimension: 'pressure_tone', level: 'shouty' }, 'UNKNOWN_LEVEL'],
    [{ scopeId: SCOPE, now: NOW, action: 'revoke_memory' }, 'UNKNOWN_RECORD'],
    [{ scopeId: SCOPE, now: NOW, action: 'revoke_memory', recordId: 'nope' }, 'UNKNOWN_RECORD'],
    [{ scopeId: SCOPE, now: NOW, action: 'revoke_feedback', eventId: 'nope' }, 'UNKNOWN_RECORD'],
  ];
  for (const [body, expected] of cases) {
    let outcome: ReturnType<typeof call>;
    assert.doesNotThrow(() => { outcome = call(port, body); }, `threw on ${JSON.stringify(body)}`);
    assert.equal(rejectionOf(outcome!), expected, `wrong code for ${JSON.stringify(body)}`);
    assert.equal(outcome!.status, 400);
  }
});

test('a level valid for one dimension is not accepted for another', () => {
  // The level vocabulary is per-dimension. A flat "is this a known level
  // anywhere" check would let `soft` set the reminder density.
  const port = makePort();
  const outcome = call(port, { scopeId: SCOPE, now: NOW, action: 'correct', dimension: 'reminder_density', level: 'soft' });
  assert.equal(rejectionOf(outcome), 'UNKNOWN_LEVEL');
});

test('every rejection code the handler can emit is declared', () => {
  // A code emitted but not listed is one no caller can switch on exhaustively.
  const port = makePort();
  const emitted = new Set<string>();
  for (const body of [
    null,
    {},
    { scopeId: SCOPE },
    { scopeId: SCOPE, now: NOW },
    { scopeId: SCOPE, now: NOW, action: 'correct', dimension: 'x' },
    { scopeId: SCOPE, now: NOW, action: 'correct', dimension: 'pressure_tone', level: 'x' },
    { scopeId: SCOPE, now: NOW, action: 'revoke_memory', recordId: 'x' },
  ]) {
    emitted.add(rejectionOf(call(port, body)));
  }
  for (const code of Array.from(emitted)) {
    assert.ok((CONTROLS_REJECTION_CODES as readonly string[]).includes(code), `undeclared code: ${code}`);
  }
});

/* ── Scope isolation ─────────────────────────────────────────────── */

test('one scope cannot revoke another scope’s feedback event or memory record', () => {
  // Neither store's `revoke(id, at)` takes a scope, so ownership is this
  // module's job and nothing above it will catch a miss. Without the check, an
  // unauthenticated POST naming someone else's record id and your own scopeId
  // returned 200 and stamped their record revoked — and a revoked feedback
  // event stops contributing to its owner's profile, so it reshapes a
  // stranger's personalization.
  const port = makePort();
  const victimEvent = port.feedback.append(
    { scopeId: 'victim', outcome: 'accept', subjectId: 's-1', actor: 'user', source: 'mobile_action', occurredAt: NOW },
    NOW,
  );
  const victimRecord = port.memory.put(
    { scopeId: 'victim', kind: 'fact', content: 'theirs', language: 'en', source: 'user_stated', confidence: 1, observedAt: NOW },
    NOW,
  );

  const stolenEvent = call(port, { scopeId: 'attacker', now: NOW, action: 'revoke_feedback', eventId: victimEvent.id });
  assert.equal(rejectionOf(stolenEvent), 'UNKNOWN_RECORD');
  assert.equal(port.feedback.get(victimEvent.id)?.revokedAt ?? null, null, 'the victim’s event was revoked');

  const stolenRecord = call(port, { scopeId: 'attacker', now: NOW, action: 'revoke_memory', recordId: victimRecord.id });
  assert.equal(rejectionOf(stolenRecord), 'UNKNOWN_RECORD');
  assert.equal(port.memory.get(victimRecord.id)?.status, 'active', 'the victim’s record was revoked');
});

test('the owner can still revoke their own', () => {
  // The other half: a scope check that refuses everything is not a fix.
  const port = makePort();
  const own = port.feedback.append(
    { scopeId: SCOPE, outcome: 'accept', subjectId: 's-1', actor: 'user', source: 'mobile_action', occurredAt: NOW },
    NOW,
  );
  const outcome = call(port, { scopeId: SCOPE, now: NOW, action: 'revoke_feedback', eventId: own.id });
  assert.equal(outcome.status, 200);
  assert.ok(port.feedback.get(own.id)?.revokedAt);
});

/* ── A malformed instant is reported, not thrown ─────────────────── */

test('a `now` that is not an instant is rejected rather than raised out of a store', () => {
  // Every store parses this value and throws its own error on a bad one, so
  // before the check these were 500s with stack traces out of a module
  // documented to report rather than throw. Each action below reached a
  // different store, which is why all of them are swept.
  const port = makePort();
  for (const now of ['not-a-date', '2026-02-30T00:00:00Z', '2026-08-20T09:00:00', '', '   ']) {
    for (const action of ['inventory', 'enable', 'export', 'correct']) {
      let outcome: ReturnType<typeof call> | undefined;
      assert.doesNotThrow(() => {
        outcome = call(port, { scopeId: SCOPE, now, action, dimension: 'pressure_tone', level: 'firm' });
      }, `${action} threw on now=${JSON.stringify(now)}`);
      const code = rejectionOf(outcome!);
      assert.ok(
        code === 'MALFORMED_INSTANT' || code === 'MISSING_INSTANT',
        `${action} on now=${JSON.stringify(now)} answered ${code}`,
      );
    }
  }
});

test('a well-formed instant still passes', () => {
  const port = makePort();
  assert.equal(call(port, { scopeId: SCOPE, now: NOW, action: 'inventory' }).status, 200);
});

/* ── Consent ─────────────────────────────────────────────────────── */

test('enabling and disabling take effect in the same response', () => {
  // The view rides along with the write, so a client cannot render a stale
  // profile beside a flipped toggle even by accident.
  const port = makePort();
  const enabled = call(port, { scopeId: SCOPE, now: NOW, action: 'enable' });
  const enabledBody = enabled.response as { view: { consent: { state: string }; preferences: { kind: string } } };
  assert.equal(enabledBody.view.consent.state, 'enabled');
  assert.equal(enabledBody.view.preferences.kind, 'derived');

  const disabled = call(port, { scopeId: SCOPE, now: NOW, action: 'disable' });
  const disabledBody = disabled.response as { view: { consent: { state: string }; preferences: { kind: string } } };
  assert.equal(disabledBody.view.consent.state, 'disabled');
  assert.equal(disabledBody.view.preferences.kind, 'disabled');
});

/* ── Corrections ─────────────────────────────────────────────────── */

test('a correction is stored, reflected, and clearable', () => {
  const port = makePort();
  const applied = call(port, { scopeId: SCOPE, now: NOW, action: 'correct', dimension: 'pressure_tone', level: 'firm' });
  assert.equal(applied.status, 200);
  assert.equal(readCorrections(port.memory, SCOPE, NOW).pressure_tone?.level, 'firm');

  const cleared = call(port, { scopeId: SCOPE, now: NOW, action: 'clear_correction', dimension: 'pressure_tone' });
  assert.equal((cleared.response as { cleared: boolean }).cleared, true);
  assert.equal(readCorrections(port.memory, SCOPE, NOW).pressure_tone, null);
});

test('every dimension can be corrected to every level it declares', () => {
  // A level the endpoint refuses is a control the screen cannot offer, and a
  // per-dimension check that quietly rejects a legal level is invisible from any
  // single-dimension test. This sweeps the whole vocabulary rather than sampling
  // it, so a dimension whose levels are gated by the wrong list fails here.
  for (const dimension of PREFERENCE_DIMENSIONS) {
    for (const level of PREFERENCE_LEVEL_VOCABULARY[dimension]) {
      const port = makePort();
      const outcome = call(port, { scopeId: SCOPE, now: NOW, action: 'correct', dimension, level });
      assert.equal(outcome.status, 200, `${dimension}=${level} was refused: ${JSON.stringify(outcome.response)}`);
      assert.equal(readCorrections(port.memory, SCOPE, NOW)[dimension]?.level, level);
    }
  }
});

/* ── Export: the user's copy is not the training copy ────────────── */

test('export hands back the records and marks which may ever leave for training', () => {
  const port = makePort();
  port.memory.put({
    scopeId: SCOPE, kind: 'fact', content: 'Prefers evenings', language: 'en',
    source: 'user_stated', confidence: 1, observedAt: NOW,
  }, NOW);

  const outcome = call(port, { scopeId: SCOPE, now: NOW, action: 'export' });
  assert.equal(outcome.status, 200);
  const body = outcome.response as { memoryRecords: readonly { content: string; fineTuningExportable: boolean }[] };
  assert.equal(body.memoryRecords.length, 1);
  // The user gets their own content back — this boundary is not the training
  // boundary, and refusing here would mean refusing to show someone their data.
  assert.equal(body.memoryRecords[0].content, 'Prefers evenings');
  // And the training boundary is still stated, per record.
  assert.equal(body.memoryRecords[0].fineTuningExportable, false);
});

/* ── Deletion, honestly refused until it is wired ────────────────── */

test('a delete request is refused with 501 when deletion is not wired, not silently accepted', () => {
  const port = makePort();
  const outcome = call(port, { scopeId: SCOPE, now: NOW, action: 'delete' });
  assert.equal(outcome.status, 501);
  assert.equal(rejectionOf(outcome), 'STORE_REJECTED');
});

test('when deletion is wired the receipt is returned and consent is reset with it', () => {
  const port = makePort();
  port.consent.write(SCOPE, 'enabled', NOW);
  let sawScope: string | null = null;
  const outcome = call(port, { scopeId: SCOPE, now: NOW, action: 'delete' }, (scopeId) => {
    sawScope = scopeId;
    return { scopeId, remainingFeedbackEventCount: 0 };
  });
  assert.equal(outcome.status, 200);
  assert.equal(sawScope, SCOPE);
  // Consent is a fourth store and it is deleted too: leaving `enabled` behind
  // would have a deleted user still opted in.
  assert.equal(port.consent.read(SCOPE).state, 'disabled');
});
