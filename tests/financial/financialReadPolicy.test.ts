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
 * The same call also has to leave a durable, content-free gateway audit. A
 * policy row that says `auditRequired` without a persisted record is only a
 * declaration, so these tests inspect the storage the production service uses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { ACTION_GATEWAY_AUDIT_EVENTS, userCol } from '../../lib/storage/paths.ts';
import { StoredActionGatewayAuditStore } from '../../lib/integrations/actions/storedActionGatewayAuditStore.ts';
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
  assert.equal(seen.length, 1);
  assert.deepEqual(
    {
      capability: seen[0]!.capability,
      provider: seen[0]!.provider,
      actor: seen[0]!.actor,
      userConfirmed: seen[0]!.userConfirmed,
      strongConfirmation: seen[0]!.strongConfirmation,
      settingsAllowAutomaticExternalWrites: seen[0]!.settingsAllowAutomaticExternalWrites,
    },
    financialReadPolicyRequest(),
  );
  assert.ok(state.sourceKinds.includes('provider'));
  assert.equal(state.missingSourceKinds.includes('provider'), false);

  const audit = await storage.list<Record<string, unknown>>(userCol(UID, ACTION_GATEWAY_AUDIT_EVENTS));
  assert.deepEqual(
    audit.filter((row) => row.data.recordKind === 'event').map((row) => row.data.phase).sort(),
    ['execution_started', 'execution_succeeded'],
  );
  assert.equal(audit.some((row) => 'payload' in row.data), false, 'the provider request was persisted in the audit');
  assert.equal(audit.some((row) => 'observations' in row.data), false, 'financial observations were persisted in the audit');

  const current = audit.find((row) => row.data.recordKind === 'current');
  assert.ok(current);
  const persisted = await new StoredActionGatewayAuditStore(UID, storage)
    .latest(String(current.data.idempotencyKey));
  assert.equal(persisted?.phase, 'execution_succeeded');
  assert.equal(await storage.list(userCol('financial-read-policy-sibling', ACTION_GATEWAY_AUDIT_EVENTS)).then((rows) => rows.length), 0);
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
    assert.deepEqual(
      await storage.list(userCol(UID, ACTION_GATEWAY_AUDIT_EVENTS)),
      [],
      'the injected test decision must stop before the production gateway',
    );
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
  assert.deepEqual(await storage.list(userCol(UID, ACTION_GATEWAY_AUDIT_EVENTS)), []);
});
