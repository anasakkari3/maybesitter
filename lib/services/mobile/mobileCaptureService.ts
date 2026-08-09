import { createHash, randomUUID } from 'crypto';
import {
  confirmCapture,
  MemoryCaptureProposalStore,
  proposeCapture,
  type CaptureProposalStore,
  type CapturePersistenceAdapter,
} from '../captureBoundary';
import { createEmptyDomainState, type Command, type Commitment } from '../../../src/domain/stateMachine';
import { applyCommand, configureCommandService, getCommandServiceState } from '../commandService';
import { CommandServiceCapturePersistenceAdapter } from './canonicalPersistence';
import {
  applyParticipantCommand,
  applyParticipantCommands,
  getParticipantStateSnapshot,
} from './participantState';
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

export interface MobileBackendContext {
  participantId?: string;
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

function scopeIdFrom(value: unknown, context: MobileBackendContext = {}): string {
  if (context.participantId) return context.participantId;
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

function persistenceFor(context: MobileBackendContext = {}): CapturePersistenceAdapter {
  if (!context.participantId) return persistence;
  return {
    persistAtomically: async (commands: readonly Command[]) => applyParticipantCommands(context.participantId as string, commands),
    snapshot: () => getParticipantStateSnapshot(context.participantId as string),
  };
}

function persistedItem(
  proposalStore: CaptureProposalStore,
  proposalId: string,
  itemId: string,
  context: MobileBackendContext = {},
): PersistedProposalItem | null {
  const stored = proposalStore.get(proposalId);
  const item = stored?.contract.items.find((candidate) => candidate.itemId === itemId);
  const commitmentId = commitmentIdForCommands(stored?.commandsByItemId.get(itemId));
  if (!item || !commitmentId) return null;
  const state = context.participantId ? getParticipantStateSnapshot(context.participantId) : getCommandServiceState();
  const commitment = state.commitments[commitmentId];
  return {
    itemId,
    commitmentId,
    title: commitment?.title ?? item.title,
    resolvedTime: commitment?.timeSpec.remindAt ?? commitment?.timeSpec.dueAt ?? item.resolvedTime,
  };
}

async function activateConfirmedItems(
  proposalId: string,
  itemIds: readonly string[],
  context: MobileBackendContext = {},
): Promise<void> {
  const stored = store.get(proposalId);
  if (!stored) return;

  for (const itemId of itemIds) {
    const commitmentId = commitmentIdForCommands(stored.commandsByItemId.get(itemId));
    if (!commitmentId) continue;
    const state = context.participantId ? getParticipantStateSnapshot(context.participantId) : getCommandServiceState();
    const commitment = state.commitments[commitmentId];
    if (!commitment || commitment.status !== 'pending_confirmation') continue;
    const command: Command = {
      type: 'ConfirmCommitment',
      commitmentId,
      now: new Date().toISOString(),
    };
    if (context.participantId) {
      await applyParticipantCommand(context.participantId, command);
    } else {
      configureCommandService({});
      applyCommand(command);
    }
  }
}

export async function proposeMobileCapture(input: MobileCaptureInput, context: MobileBackendContext = {}) {
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text) throw new Error('text is required');

  return proposeCapture(text, {
    now: dateFromOptionalIso(input.referenceTime, new Date(), 'referenceTime'),
    timezone: normalizeTimezone(input.timezone),
    scopeId: scopeIdFrom(input.scopeId, context),
  }, {
    store,
    persistence: persistenceFor(context),
    extractor: guardedMobileExtract,
  });
}

export async function confirmMobileCapture(input: MobileConfirmInput, context: MobileBackendContext = {}): Promise<{
  success: boolean;
  replayed: boolean;
  persisted: PersistedProposalItem[];
  failed: FailedProposalItem[];
}> {
  const proposalId = typeof input.proposalId === 'string' ? input.proposalId : '';
  if (!proposalId) throw new Error('proposalId is required');

  const scopeId = scopeIdFrom(input.scopeId, context);
  const selectedItemIds = selectedIdsFrom(input);
  if (selectedItemIds.length === 0) throw new Error('itemIds is required');

  const result = await confirmCapture({
    proposalId,
    scopeId,
    selectedItemIds,
    idempotencyKey: idempotencyKeyFor(proposalId, scopeId, selectedItemIds, input.idempotencyKey),
  }, {
    store,
    persistence: persistenceFor(context),
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

  await activateConfirmedItems(proposalId, result.persistedItemIds, context);

  return {
    success: true,
    replayed: result.replayed,
    persisted: result.persistedItemIds
      .map((itemId) => persistedItem(store, proposalId, itemId, context))
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
