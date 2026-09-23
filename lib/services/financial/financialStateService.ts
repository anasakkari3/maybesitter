/**
 * The one file in this feature that touches storage.
 *
 * It gathers — the connection, what the provider currently reports, what the
 * user has said — and hands all of it to a pure builder along with an explicit
 * `asOf`. Nothing derived is written back. A `FinancialState` exists for the
 * length of one request and is then gone, which is the reason a balance in
 * this product can never be stale: there is nowhere for it to go stale in.
 *
 * ── Why a disconnected account still returns a state ─────────────
 *
 * Somebody who has typed in their salary and their rent has a financial
 * context, and the feature is meant to be useful to them without a bank. With
 * no connection the provider half is simply absent, the state says so in
 * `missingSourceKinds`, and every provider-owned field falls back to whatever
 * the person supplied.
 *
 * ── The read is gated on the capability table, and what that does not buy ──
 *
 * ADR-0002 §9: every integration reads behind `IntegrationConnectionRecord`
 * + a closed `CapabilityId`. The connection half was always here; the
 * capability half is `read_financial_context`, evaluated against
 * `ACTION_CAPABILITY_POLICIES` before the port is touched. A decision that is
 * not `allowed` with `providerExecutionAllowed` means the provider half is
 * absent from the state exactly as if nothing were connected — no partial
 * read, no cached picture from an earlier request.
 *
 * What this does **not** claim: an audit record. The policy row says
 * `auditRequired: true`, as every other provider read's row does, and as of
 * 2026-09-23 no provider read on main produces one. Gmail, Graph, Todoist,
 * Notion and RescueTime gate their reads through `planProviderSync`; the only
 * caller of `executeThroughActionGateway` is the MCP capability adapter, and
 * it takes an injected audit store for which no persisted implementation
 * exists. Routing this read through that gateway with an in-memory store
 * would produce a record nothing keeps, so it is not done. The gap is the
 * provider layer's, recorded in ADR-0002 under "Enforcement, stated honestly",
 * and closing it is one change for every provider read at once.
 */
import {
  evaluateActionPolicy,
  type ActionPolicyDecision,
  type ActionPolicyRequest,
} from '../../../src/contracts/v1/actionPolicyContracts';
import type { FinancialState } from '../../../src/contracts/v1/financialContracts';
import type { IntegrationConnectionRecord } from '../../../src/contracts/v1/integrationConnectionContracts';
import {
  normalizeFinancialObservations,
  type NormalizedFinancialObservations,
} from '../../integrations/financial/adapter';
import type { FinancialDataPort } from '../../integrations/financial/port';
import { createSandboxFinancialTransport } from '../../integrations/financial/sandbox/sandboxTransport';
import { connectionIdFor, StoredIntegrationConnectionStore } from '../../integrations/providers/production/storedConnectionStore';
import { getStorage } from '../../storage';
import type { StorageAdapter } from '../../storage/storageAdapter';
import { buildFinancialState } from './buildFinancialState';
import { StoredManualFinancialStore } from './manualFinancialStore';

export const FINANCIAL_PROVIDER = 'financial_sandbox' as const;
/** The one `CapabilityId` this feature holds. A read; see `actionPolicyContracts`. */
export const FINANCIAL_READ_CAPABILITY = 'read_financial_context' as const;

export type FinancialReadPolicyEvaluator = (request: ActionPolicyRequest) => ActionPolicyDecision;

export interface ReadFinancialStateInput {
  readonly uid: string;
  /** Required. The instant the answer is about; the caller owns the clock. */
  readonly asOf: string;
  readonly storage?: StorageAdapter;
  /**
   * Injected in tests and by a future production transport. When absent, the
   * sandbox is used — and only for a connection that actually exists.
   */
  readonly transport?: FinancialDataPort;
  /**
   * Injected in tests only, to prove a decision other than `allowed` keeps
   * the port unread. Production always evaluates the real table.
   */
  readonly evaluatePolicy?: FinancialReadPolicyEvaluator;
}

export function financialConnectionId(): string {
  return connectionIdFor(FINANCIAL_PROVIDER);
}

function isUsable(connection: IntegrationConnectionRecord | null): boolean {
  return connection !== null
    && connection.state === 'connected'
    && connection.capabilities.includes('financial_read');
}

/** The request every financial read is evaluated as. `system`, because no person confirms a read. */
export function financialReadPolicyRequest(): ActionPolicyRequest {
  return {
    capability: FINANCIAL_READ_CAPABILITY,
    provider: FINANCIAL_PROVIDER,
    actor: 'system',
    userConfirmed: false,
    strongConfirmation: false,
    settingsAllowAutomaticExternalWrites: false,
  };
}

function readAllowed(evaluate: FinancialReadPolicyEvaluator): boolean {
  const decision = evaluate(financialReadPolicyRequest());
  return decision.decision === 'allowed' && decision.providerExecutionAllowed;
}

export async function readFinancialState(input: ReadFinancialStateInput): Promise<FinancialState> {
  const storage = input.storage ?? getStorage();
  const connections = new StoredIntegrationConnectionStore(input.uid, storage);
  const manualStore = new StoredManualFinancialStore(input.uid, storage);

  const [connection, manual] = await Promise.all([
    connections.get(financialConnectionId()),
    manualStore.read(),
  ]);

  const observations: NormalizedFinancialObservations[] = [];
  if (isUsable(connection) && readAllowed(input.evaluatePolicy ?? evaluateActionPolicy)) {
    const port = input.transport ?? createSandboxFinancialTransport({ asOf: input.asOf });
    observations.push(
      await normalizeFinancialObservations(port, {
        connectionId: connection!.connectionId,
        asOf: input.asOf,
      }),
    );
  }

  return buildFinancialState({
    scopeId: input.uid,
    asOf: input.asOf,
    observations,
    manual,
  });
}

/**
 * The currency this account's amounts are in, or null if nothing has said.
 *
 * Exists so a write can refuse rather than a read can disappear. An amount
 * with no currency is not an amount, so `buildFinancialState` drops it — which
 * for a person who typed a savings goal with no bank connected means the
 * number they entered is simply not on the screen afterwards, with nothing
 * saying why. Asked at write time instead, the same fact becomes an error
 * message naming the missing piece.
 */
export async function knownFinancialCurrency(
  uid: string,
  asOf: string,
  storage?: StorageAdapter,
): Promise<string | null> {
  const state = await readFinancialState({ uid, asOf, storage });
  return state.currency;
}

export async function connectFinancialSandbox(
  uid: string,
  now: string,
  storage?: StorageAdapter,
): Promise<IntegrationConnectionRecord> {
  const store = new StoredIntegrationConnectionStore(uid, storage ?? getStorage());
  return store.upsert({
    scopeId: uid,
    identity: {
      provider: FINANCIAL_PROVIDER,
      providerAccountId: null,
      providerSpaceId: null,
      displayName: 'Financial context (sandbox)',
    },
    state: 'connected',
    capabilities: ['financial_read'],
    grantedScopes: ['accounts:read', 'balances:read', 'transactions:read', 'recurring:read'],
    connectedAt: now,
    // No `credentialRef`: there is no credential. A sandbox that stored a
    // placeholder token would put a row in the vault that nothing can revoke.
    provenance: { source: 'manual', connectedBy: 'user', recordedAt: now },
  }, now);
}

export async function disconnectFinancialSandbox(uid: string, storage?: StorageAdapter): Promise<boolean> {
  const store = new StoredIntegrationConnectionStore(uid, storage ?? getStorage());
  return store.deleteById(financialConnectionId());
}
