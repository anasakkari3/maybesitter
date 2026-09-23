/**
 * The provider half of a financial state is read only when the capability
 * table allows it (ADR-0002 §9, #financial-v1).
 *
 * The connection record was always consulted; this is the other half of the
 * clause. `read_financial_context` is a member of the closed `CapabilityId`,
 * its policy row is `read_only_context`, and `readFinancialState` evaluates
 * that row before it touches the port. These cases prove the gate is on the
 * path — not that the row exists, which `financialBoundary` and
 * `policyContract` already assert — by handing the service a decision other
 * than `allowed` and checking the port was never called.
 *
 * What is deliberately not claimed here: an audit record. See the header of
 * `financialStateService.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import type { FinancialDataPort } from '../../lib/integrations/financial/port.ts';
import { createSandboxFinancialTransport } from '../../lib/integrations/financial/sandbox/sandboxTransport.ts';
import {
  connectFinancialSandbox,
  FINANCIAL_PROVIDER,
  FINANCIAL_READ_CAPABILITY,
  financialReadPolicyRequest,
  readFinancialState,
} from '../../lib/services/financial/financialStateService.ts';
import {
  evaluateActionPolicy,
  type ActionPolicyDecision,
  type ActionPolicyRequest,
} from '../../src/contracts/v1/actionPolicyContracts.ts';

const UID = 'financial-read-policy-user';
const AS_OF = '2026-09-23T09:00:00.000Z';

function countingPort(): { port: FinancialDataPort; calls: () => number } {
  const inner = createSandboxFinancialTransport({ asOf: AS_OF });
  let calls = 0;
  const port: FinancialDataPort = {
    listAccounts: (request) => { calls += 1; return inner.listAccounts(request); },
    listBalances: (request) => { calls += 1; return inner.listBalances(request); },
    listTransactions: (request) => { calls += 1; return inner.listTransactions(request); },
    listRecurring: (request) => { calls += 1; return inner.listRecurring(request); },
  };
  return { port, calls: () => calls };
}

async function connectedStorage() {
  const storage = createMemoryStorage();
  await connectFinancialSandbox(UID, AS_OF, storage);
  return storage;
}

test('the request the read is evaluated as names the financial read capability, as the system', () => {
  const request = financialReadPolicyRequest();
  assert.equal(request.capability, FINANCIAL_READ_CAPABILITY);
  assert.equal(request.capability, 'read_financial_context');
  assert.equal(request.provider, FINANCIAL_PROVIDER);
  assert.equal(request.actor, 'system');
  assert.equal(request.userConfirmed, false);
  assert.equal(request.strongConfirmation, false);
  assert.equal(request.settingsAllowAutomaticExternalWrites, false);
  const decision = evaluateActionPolicy(request);
  assert.equal(decision.decision, 'allowed');
  assert.equal(decision.providerExecutionAllowed, true);
  assert.equal(decision.policy?.tier, 'read_only_context');
});

test('a connected source is read when the real table allows it, and the evaluator sees the read request', async () => {
  const storage = await connectedStorage();
  const { port, calls } = countingPort();
  const seen: ActionPolicyRequest[] = [];
  const state = await readFinancialState({
    uid: UID,
    asOf: AS_OF,
    storage,
    transport: port,
    evaluatePolicy: (request) => { seen.push(request); return evaluateActionPolicy(request); },
  });
  assert.ok(calls() > 0, 'the port was never read');
  assert.deepEqual(seen, [financialReadPolicyRequest()]);
  assert.ok(state.sourceKinds.includes('provider'));
  assert.equal(state.missingSourceKinds.includes('provider'), false);
});

for (const [name, decide] of [
  ['denied', (request: ActionPolicyRequest): ActionPolicyDecision => ({
    ...evaluateActionPolicy(request), decision: 'denied', reason: 'unsupported_capability', providerExecutionAllowed: false,
  })],
  ['allowed but not for provider execution', (request: ActionPolicyRequest): ActionPolicyDecision => ({
    ...evaluateActionPolicy(request), providerExecutionAllowed: false,
  })],
  ['requires confirmation', (request: ActionPolicyRequest): ActionPolicyDecision => ({
    ...evaluateActionPolicy(request), decision: 'requires_confirmation', reason: 'confirmation_required', providerExecutionAllowed: false,
  })],
] as const) {
  test(`a decision that is ${name} leaves the port unread and the provider absent from the state`, async () => {
    const storage = await connectedStorage();
    const { port, calls } = countingPort();
    const state = await readFinancialState({ uid: UID, asOf: AS_OF, storage, transport: port, evaluatePolicy: decide });
    assert.equal(calls(), 0, 'the port was read despite the policy decision');
    assert.equal(state.sourceKinds.includes('provider'), false);
    assert.ok(state.missingSourceKinds.includes('provider'));
  });
}

test('an account with nothing connected never asks the policy table at all', async () => {
  const storage = createMemoryStorage();
  const { port, calls } = countingPort();
  let asked = 0;
  await readFinancialState({
    uid: UID, asOf: AS_OF, storage, transport: port,
    evaluatePolicy: (request) => { asked += 1; return evaluateActionPolicy(request); },
  });
  assert.equal(asked, 0);
  assert.equal(calls(), 0);
});
