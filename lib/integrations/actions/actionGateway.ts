import { createHash } from 'node:crypto';
import {
  evaluateActionPolicy,
  type ActionPolicyDecision,
  type ActionPolicyRequest,
} from '../../../src/contracts/v1/actionPolicyContracts';

export type ActionGatewayAuditPhase =
  | 'policy_blocked'
  | 'execution_started'
  | 'execution_succeeded'
  | 'execution_failed';

export interface ActionGatewayRequest<Payload = unknown> extends ActionPolicyRequest {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly scopeId: string;
  readonly payloadDigest: string;
  readonly requestedAt: string;
  readonly payload: Payload;
}

export interface AllowedActionExecution<Payload = unknown> {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly scopeId: string;
  readonly capability: string;
  readonly provider: string | null;
  readonly payloadDigest: string;
  readonly payload: Payload;
}

export interface ActionExecutionReceipt {
  readonly executionId: string;
  readonly resultRef: string | null;
}

export interface ActionExecutor<Payload = unknown> {
  /** Implementations must pass idempotencyKey through to the provider. */
  execute(input: AllowedActionExecution<Payload>): Promise<ActionExecutionReceipt>;
}

export interface ActionGatewayAuditRecord {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly scopeId: string;
  readonly capability: string;
  readonly provider: string | null;
  readonly actor: ActionPolicyRequest['actor'];
  readonly phase: ActionGatewayAuditPhase;
  readonly recordedAt: string;
  readonly policyDecision: ActionPolicyDecision['decision'];
  readonly reason: ActionPolicyDecision['reason'] | 'executor_failed';
  readonly executionId: string | null;
  readonly resultRef: string | null;
  readonly safeErrorCode: string | null;
}

export interface ActionGatewayAuditStore {
  latest(idempotencyKey: string): Promise<ActionGatewayAuditRecord | null>;
  append(record: ActionGatewayAuditRecord): Promise<void>;
}

export type ActionGatewayResult =
  | {
    readonly status: 'policy_blocked';
    readonly decision: ActionPolicyDecision;
  }
  | {
    readonly status: 'executed' | 'replayed';
    readonly decision: ActionPolicyDecision;
    readonly executionId: string;
    readonly resultRef: string | null;
  }
  | {
    readonly status: 'failed';
    readonly decision: ActionPolicyDecision;
    readonly safeErrorCode: string;
  }
  | {
    readonly status: 'indeterminate';
    readonly decision: ActionPolicyDecision;
    readonly reason: 'execution_already_started' | 'idempotency_conflict';
  };

function requestFingerprint(request: ActionGatewayRequest): string {
  return createHash('sha256')
    .update([
      request.scopeId,
      request.capability,
      request.provider ?? '',
      request.payloadDigest,
    ].join('\u0000'))
    .digest('hex');
}

function safeErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'safeErrorCode' in error) {
    const value = (error as { safeErrorCode?: unknown }).safeErrorCode;
    if (typeof value === 'string' && /^[a-z0-9_]{1,80}$/.test(value)) return value;
  }
  return 'external_action_failed';
}

function auditRecord(
  request: ActionGatewayRequest,
  fingerprint: string,
  decision: ActionPolicyDecision,
  phase: ActionGatewayAuditPhase,
  overrides: Partial<Pick<ActionGatewayAuditRecord, 'reason' | 'executionId' | 'resultRef' | 'safeErrorCode'>> = {},
): ActionGatewayAuditRecord {
  return {
    requestId: request.requestId,
    idempotencyKey: request.idempotencyKey,
    requestFingerprint: fingerprint,
    scopeId: request.scopeId,
    capability: request.capability,
    provider: request.provider,
    actor: request.actor,
    phase,
    recordedAt: request.requestedAt,
    policyDecision: decision.decision,
    reason: overrides.reason ?? decision.reason,
    executionId: overrides.executionId ?? null,
    resultRef: overrides.resultRef ?? null,
    safeErrorCode: overrides.safeErrorCode ?? null,
  };
}

export async function executeThroughActionGateway<Payload>(
  request: ActionGatewayRequest<Payload>,
  dependencies: {
    readonly audit: ActionGatewayAuditStore;
    readonly executor: ActionExecutor<Payload>;
  },
): Promise<ActionGatewayResult> {
  const decision = evaluateActionPolicy(request);
  const fingerprint = requestFingerprint(request);
  const prior = await dependencies.audit.latest(request.idempotencyKey);

  if (prior) {
    if (prior.requestFingerprint !== fingerprint) {
      return { status: 'indeterminate', decision, reason: 'idempotency_conflict' };
    }
    if (prior.phase === 'execution_succeeded' && prior.executionId) {
      return {
        status: 'replayed',
        decision,
        executionId: prior.executionId,
        resultRef: prior.resultRef,
      };
    }
    if (prior.phase === 'execution_failed') {
      return {
        status: 'failed',
        decision,
        safeErrorCode: prior.safeErrorCode ?? 'external_action_failed',
      };
    }
    if (prior.phase === 'execution_started') {
      return { status: 'indeterminate', decision, reason: 'execution_already_started' };
    }
    if (decision.decision !== 'allowed' || !decision.providerExecutionAllowed) {
      return { status: 'policy_blocked', decision };
    }
  }

  if (decision.decision !== 'allowed' || !decision.providerExecutionAllowed) {
    await dependencies.audit.append(auditRecord(request, fingerprint, decision, 'policy_blocked'));
    return { status: 'policy_blocked', decision };
  }

  await dependencies.audit.append(auditRecord(request, fingerprint, decision, 'execution_started'));

  try {
    const receipt = await dependencies.executor.execute({
      requestId: request.requestId,
      idempotencyKey: request.idempotencyKey,
      scopeId: request.scopeId,
      capability: request.capability,
      provider: request.provider,
      payloadDigest: request.payloadDigest,
      payload: request.payload,
    });
    await dependencies.audit.append(auditRecord(request, fingerprint, decision, 'execution_succeeded', {
      executionId: receipt.executionId,
      resultRef: receipt.resultRef,
    }));
    return {
      status: 'executed',
      decision,
      executionId: receipt.executionId,
      resultRef: receipt.resultRef,
    };
  } catch (error) {
    const code = safeErrorCode(error);
    await dependencies.audit.append(auditRecord(request, fingerprint, decision, 'execution_failed', {
      reason: 'executor_failed',
      safeErrorCode: code,
    }));
    return { status: 'failed', decision, safeErrorCode: code };
  }
}

export class MemoryActionGatewayAuditStore implements ActionGatewayAuditStore {
  private readonly records: ActionGatewayAuditRecord[] = [];

  async latest(idempotencyKey: string): Promise<ActionGatewayAuditRecord | null> {
    return this.records.findLast((record) => record.idempotencyKey === idempotencyKey) ?? null;
  }

  async append(record: ActionGatewayAuditRecord): Promise<void> {
    this.records.push(Object.freeze({ ...record }));
  }

  list(): readonly ActionGatewayAuditRecord[] {
    return Object.freeze([...this.records]);
  }
}
