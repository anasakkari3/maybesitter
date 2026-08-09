import { createHash, randomUUID } from 'crypto';
import {
  confirmCapture,
  MemoryCaptureProposalStore,
  proposeCapture,
  type CaptureProposalStore,
} from '../captureBoundary';
import { createEmptyDomainState, type Command, type Commitment } from '../../../src/domain/stateMachine';
import { applyCommand, configureCommandService, getCommandServiceState } from '../commandService';
import { CommandServiceCapturePersistenceAdapter } from './canonicalPersistence';
import { guardedMobileExtract } from './safety';
import { dateFromOptionalIso, normalizeTimezone } from './time';

export interface MobileCaptureInput {
  text?: unknown;
  referenceTime?: unknown;
  timezone?: unknown;
  scopeId?: unknown;
}

export interface MobileConfirmInput {
  proposalId?: unknown;
  scopeId?: unknown;
  itemIds?: unknown;
  selectedItemIds?: unknown;
  idempotencyKey?: unknown;
}

export interface PersistedProposalItem {
  itemId: string;
  commitmentId: string;
  title: string;
  resolvedTime: string | null;
}

export interface FailedProposalItem {
  itemId: string;
  reason: string;
}

type MobileGlobals = typeof globalThis & {
  __maybesitterMobileProposalStore?: MemoryCaptureProposalStore;
  __maybesitterMobilePersistence?: CommandServiceCapturePersistenceAdapter;
};

const mobileGlobals = globalThis as MobileGlobals;
const store = mobileGlobals.__maybesitterMobileProposalStore ?? new MemoryCaptureProposalStore();
const persistence = mobileGlobals.__maybesitterMobilePersistence ?? new CommandServiceCapturePersistenceAdapter();
mobileGlobals.__maybesitterMobileProposalStore = store;
mobileGlobals.__maybesitterMobilePersistence = persistence;

function scopeIdFrom(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : 'default';
}

function selectedIdsFrom(input: MobileConfirmInput): string[] {
  const raw = Array.isArray(input.selectedItemIds) ? input.selectedItemIds : input.itemIds;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function idempotencyKeyFor(proposalId: string, scopeId: string, selectedItemIds: string[], explicit: unknown): string {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  return createHash('sha256')
    .update(JSON.stringify({ proposalId, scopeId, selectedItemIds }))
    .digest('hex');
}

function commitmentIdForCommands(commands: readonly Command[] | undefined): string | null {
  const createDraft = commands?.find((command): command is Extract<Command, { type: 'CreateDraft' }> => command.type === 'CreateDraft');
  return createDraft?.commitment.id ?? null;
}

function persistedItem(
  proposalStore: CaptureProposalStore,
  proposalId: string,
  itemId: string
): PersistedProposalItem | null {
  const stored = proposalStore.get(proposalId);
  const item = stored?.contract.items.find((candidate) => candidate.itemId === itemId);
  const commitmentId = commitmentIdForCommands(stored?.commandsByItemId.get(itemId));
  if (!item || !commitmentId) return null;
  const commitment = getCommandServiceState().commitments[commitmentId];
  return {
    itemId,
    commitmentId,
    title: commitment?.title ?? item.title,
    resolvedTime: commitment?.timeSpec.remindAt ?? commitment?.timeSpec.dueAt ?? item.resolvedTime,
  };
}

function activateConfirmedItems(proposalId: string, itemIds: readonly string[]): void {
  const stored = store.get(proposalId);
  if (!stored) return;

  configureCommandService({});
  for (const itemId of itemIds) {
    const commitmentId = commitmentIdForCommands(stored.commandsByItemId.get(itemId));
    if (!commitmentId) continue;
    const commitment = getCommandServiceState().commitments[commitmentId];
    if (!commitment || commitment.status !== 'pending_confirmation') continue;
    applyCommand({
      type: 'ConfirmCommitment',
      commitmentId,
      now: new Date().toISOString(),
    });
  }
}

export async function proposeMobileCapture(input: MobileCaptureInput) {
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text) throw new Error('text is required');

  return proposeCapture(text, {
    now: dateFromOptionalIso(input.referenceTime, new Date(), 'referenceTime'),
    timezone: normalizeTimezone(input.timezone),
    scopeId: scopeIdFrom(input.scopeId),
  }, {
    store,
    persistence,
    extractor: guardedMobileExtract,
  });
}

export async function confirmMobileCapture(input: MobileConfirmInput): Promise<{
  success: boolean;
  replayed: boolean;
  persisted: PersistedProposalItem[];
  failed: FailedProposalItem[];
}> {
  const proposalId = typeof input.proposalId === 'string' ? input.proposalId : '';
  if (!proposalId) throw new Error('proposalId is required');

  const scopeId = scopeIdFrom(input.scopeId);
  const selectedItemIds = selectedIdsFrom(input);
  if (selectedItemIds.length === 0) throw new Error('itemIds is required');

  const result = await confirmCapture({
    proposalId,
    scopeId,
    selectedItemIds,
    idempotencyKey: idempotencyKeyFor(proposalId, scopeId, selectedItemIds, input.idempotencyKey),
  }, {
    store,
    persistence,
  });

  if (!result.success) {
    return {
      success: false,
      replayed: result.replayed,
      persisted: [],
      failed: selectedItemIds.map((itemId) => ({
        itemId,
        reason: result.failureCode ?? 'confirmation_failed',
      })),
    };
  }

  activateConfirmedItems(proposalId, result.persistedItemIds);

  return {
    success: true,
    replayed: result.replayed,
    persisted: result.persistedItemIds
      .map((itemId) => persistedItem(store, proposalId, itemId))
      .filter((item): item is PersistedProposalItem => item !== null),
    failed: selectedItemIds
      .filter((itemId) => !result.persistedItemIds.includes(itemId))
      .map((itemId) => ({ itemId, reason: 'not_selected' })),
  };
}

export function resetMobileBackendForTests(): void {
  configureCommandService({
    initialState: createEmptyDomainState(),
    schedulerStore: null,
    stateFile: `.maybesitter/test-mobile-${randomUUID()}.json`,
  });
}

export function allMobileCommitments(): Commitment[] {
  return Object.values(getCommandServiceState().commitments);
}
