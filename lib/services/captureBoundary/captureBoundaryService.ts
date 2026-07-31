import { createHash, randomUUID } from 'crypto';
import { extractWithFallback, type ExtractAndMapOptions } from '../../../src/extraction/extractionService';
import { decideExtractionDisposition } from '../../../src/extraction/extractionPolicy';
import { mapExtractionToCommand } from '../../../src/extraction/mapExtractionToCommand';
import type { ExtractionContext, ExtractionResult } from '../../../src/extraction/extractionTypes';
import { resolveModuleRuntime, type AuditEventEnvelope, createAuditEvent, type RuntimeControlSnapshot } from '../../../src/contracts/v1/runtimeControls';
import {
  CAPTURE_CONTRACT_VERSION,
  type CaptureConfirmationResultContract,
  type CaptureProposalContract,
} from '../../../src/contracts/v1/captureContracts';
import type { CapturePersistenceAdapter } from './persistenceAdapter';
import type { CaptureProposalStore, StoredCaptureProposal } from './proposalStore';

export interface CaptureBoundaryDependencies {
  store: CaptureProposalStore;
  persistence: CapturePersistenceAdapter;
  audit?: (event: AuditEventEnvelope) => void;
  controls?: RuntimeControlSnapshot;
  llmProvider?: ExtractAndMapOptions['llmProvider'];
  extractor?: typeof extractWithFallback;
}

export interface ProposeCaptureOptions {
  now: Date;
  timezone: string;
  scopeId: string;
  requestedEngine?: 'model' | 'rules';
}

const INJECTION = /(?:ignore|disregard|override).{0,40}(?:instruction|system|policy)|(?:system|developer)\s*:/i;

function splitInput(raw: string): string[] {
  const segments = raw
    .replace(/[;\n]+/g, '|')
    .replace(/\s+(?:and then|then|also)\s+/gi, '|')
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean);
  return segments.length > 0 ? segments : [raw];
}

function semanticFailure(result: ExtractionResult, now: Date): string | null {
  if (result.type === 'unknown' || result.type === 'informational_context') return 'no_commitment';
  const title = (result.title || result.action || '').trim();
  if (title.length < 3) return 'missing_title';
  if (INJECTION.test(result.rawText)) return 'prompt_injection';
  const resolved = result.remindAt || result.dueAt;
  if (resolved && Date.parse(resolved) < now.getTime()) return 'past_time';
  return null;
}

function auditEvent(outcome: 'succeeded' | 'rejected' | 'failed' | 'fell_back', raw: string, now: Date, reasonCode?: string, itemCount?: number): AuditEventEnvelope {
  return createAuditEvent({
    eventId: randomUUID(),
    eventType: 'module_execution',
    occurredAt: now.toISOString(),
    correlationId: randomUUID(),
    module: 'capture',
    fields: {
      outcome,
      reasonCode,
      itemCount,
      inputHash: createHash('sha256').update(raw).digest('hex'),
      inputLength: raw.length,
    },
  });
}

export async function proposeCapture(rawInput: unknown, options: ProposeCaptureOptions, dependencies: CaptureBoundaryDependencies): Promise<CaptureProposalContract> {
  const raw = typeof rawInput === 'string' ? rawInput.trim() : '';
  const requestedEngine = options.requestedEngine ?? 'model';
  const runtime = resolveModuleRuntime('capture', dependencies.controls);
  const forceRules = requestedEngine === 'rules' || runtime.mode === 'rules_only';
  const extractor = dependencies.extractor ?? extractWithFallback;
  const context: ExtractionContext = { now: options.now, timezone: options.timezone };
  const proposalId = randomUUID();
  const commandsByItemId = new Map<string, readonly ReturnType<typeof mapExtractionToCommand>[number][]>();
  const items: CaptureProposalContract['items'] = [];
  let executedEngine: 'ollama' | 'rule-based' = 'rule-based';
  let fallbackUsed = forceRules;
  let rejected = !raw;

  for (const segment of raw ? splitInput(raw) : []) {
    try {
      const extracted = await extractor(segment, context, {
        llmProvider: forceRules ? async () => { throw new Error('rules-only runtime'); } : dependencies.llmProvider,
      });
      executedEngine = extracted.engine === 'rule-based' ? 'rule-based' : 'ollama';
      fallbackUsed ||= Boolean(extracted.fallbackReason);
      const failure = semanticFailure(extracted.result, options.now);
      if (failure === 'no_commitment') continue;
      if (failure) {
        rejected = true;
        continue;
      }
      const disposition = decideExtractionDisposition(extracted.result);
      const needsClarification = disposition === 'needs_clarification';
      const itemId = randomUUID();
      items.push({
        itemId,
        title: (extracted.result.title || extracted.result.action || '').trim(),
        resolvedTime: needsClarification ? null : extracted.result.remindAt || extracted.result.dueAt,
        needsClarification,
      });
      commandsByItemId.set(itemId, needsClarification ? [] : mapExtractionToCommand(extracted.result, options.now.toISOString()));
    } catch {
      rejected = true;
    }
  }

  const status: CaptureProposalContract['status'] = rejected
    ? 'rejected'
    : items.length === 0
      ? 'no_commitment'
      : items.every((item) => item.needsClarification)
        ? 'needs_clarification'
        : 'proposed';
  const contract: CaptureProposalContract = {
    version: CAPTURE_CONTRACT_VERSION,
    proposalId,
    status,
    items,
    provenance: { requestedEngine, executedEngine, fallbackUsed },
  };
  dependencies.store.put({ contract, scopeId: options.scopeId, commandsByItemId });
  dependencies.audit?.(auditEvent(fallbackUsed ? 'fell_back' : status === 'rejected' ? 'rejected' : 'succeeded', raw, options.now, status, items.length));
  return contract;
}

export async function confirmCapture(input: { proposalId: string; scopeId: string; selectedItemIds: string[]; idempotencyKey: string }, dependencies: CaptureBoundaryDependencies): Promise<CaptureConfirmationResultContract> {
  const stored = dependencies.store.get(input.proposalId);
  const failure = (failureCode: CaptureConfirmationResultContract['failureCode']): CaptureConfirmationResultContract => ({
    version: CAPTURE_CONTRACT_VERSION,
    success: false,
    replayed: false,
    persistedItemIds: [],
    failureCode,
  });
  if (!stored || stored.scopeId !== input.scopeId) return failure('proposal_not_found');
  if (stored.confirmedResult) {
    if (stored.idempotencyKey !== input.idempotencyKey) return failure('invalid_selection');
    return { ...(stored.confirmedResult as CaptureConfirmationResultContract), replayed: true };
  }
  if (stored.contract.status !== 'proposed') return failure('proposal_rejected');
  const selected = new Set(input.selectedItemIds);
  if (selected.size === 0 || Array.from(selected).some((id) => !stored.commandsByItemId.has(id))) return failure('invalid_selection');
  const commands = stored.contract.items
    .filter((item) => selected.has(item.itemId))
    .flatMap((item) => stored.commandsByItemId.get(item.itemId) ?? []);
  if (commands.length === 0) return failure('invalid_selection');
  try {
    await dependencies.persistence.persistAtomically(commands);
  } catch {
    return failure('persistence_failed');
  }
  const result: CaptureConfirmationResultContract = {
    version: CAPTURE_CONTRACT_VERSION,
    success: true,
    replayed: false,
    persistedItemIds: stored.contract.items.filter((item) => selected.has(item.itemId)).map((item) => item.itemId),
  };
  stored.confirmedResult = result;
  stored.idempotencyKey = input.idempotencyKey;
  return result;
}
