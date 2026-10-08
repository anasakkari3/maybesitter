import { createHash } from 'crypto';
import {
  CAPTURE_EDIT_TEXT_MAX,
  type CaptureAppLocale,
  type CaptureProposalContract,
  type CaptureProposalEditContract,
} from '../../../src/contracts/v1/captureContracts';
import type { CaptureSeedProposalContract } from '../../../src/contracts/v1/intentContracts';
import type { Command } from '../../../src/domain/stateMachine';
import type { ExtractionResult } from '../../../src/extraction/extractionTypes';
import { mapExtractionToCommand } from '../../../src/extraction/mapExtractionToCommand';
import { localTimeSpecFor } from '../../../src/extraction/timeLexicon';
import { getStorage } from '../../storage';
import { claimsSaved } from '../captureChat/chatReply';
import { captureConversationPath, type CaptureChatTurn, type StoredCaptureConversation } from '../captureChat/conversationStore';
import { applyEditToCommands } from './applyEdits';
import { buildClarification } from './clarificationBuilder';
import { proposalRevision } from './proposalProtocol';
import {
  CAPTURE_PROPOSAL_RETENTION_MS,
  captureProposalFromDocument,
  captureProposalPath,
  captureProposalToDocument,
  type StoredCaptureProposal,
  type StoredProposalDocument,
} from './proposalStore';
import { referenceStateFor, withPublicRemovedItems } from '../captureChat/chatReferences';
import { finalizeUnderstood } from './understood';

const KINDS = new Set(['commitment', 'possible_goal', 'consideration', 'idea', 'waiting_for']);
const SEED_KINDS = new Set(['possible_goal', 'consideration', 'idea', 'waiting_for']);
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
const URL_LIKE = /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|app|ly|co|me|info|link|to|gl)\b/i;

export class StructuredEditError extends Error {
  constructor() {
    super('edit invalid');
    this.name = 'StructuredEditError';
  }
}

export class StructuredEditConversationNotFoundError extends Error {
  constructor() {
    super('conversation not found');
    this.name = 'StructuredEditConversationNotFoundError';
  }
}

export type StructuredEditOutcome =
  | { kind: 'applied'; answer: unknown; proposal: CaptureProposalContract }
  | { kind: 'replayed'; answer: unknown; proposal: CaptureProposalContract }
  | { kind: 'changed'; proposal: CaptureProposalContract; confirmed: boolean; turns?: CaptureChatTurn[] };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => [key, canonical(child)]));
}

function fingerprint(edit: CaptureProposalEditContract): string {
  return createHash('sha256').update(JSON.stringify(canonical(edit))).digest('hex');
}

function validText(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  return text.length > 0 && text.length <= CAPTURE_EDIT_TEXT_MAX
    && !CONTROL.test(text) && !URL_LIKE.test(text) && !claimsSaved(text);
}

function validInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const [, ys, ms, ds, hs, mins, ss] = match;
  const y = Number(ys); const month = Number(ms); const d = Number(ds);
  const h = Number(hs); const minute = Number(mins); const second = Number(ss);
  if (month < 1 || month > 12 || d < 1 || h > 23 || minute > 59 || second > 59) return false;
  const calendar = new Date(Date.UTC(y, month - 1, d));
  if (calendar.getUTCFullYear() !== y || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== d) return false;
  return Number.isFinite(Date.parse(value));
}

function validZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0); return true; } catch { return false; }
}

function pending(commands: readonly Command[]): Command[] {
  return commands
    .filter((command) => command.type !== 'ConfirmCommitment')
    .map((command) => command.type === 'CreateDraft'
      ? { ...command, draftStatus: 'pending_confirmation' as const }
      : command);
}

function seedResult(summary: string): ExtractionResult {
  return {
    type: 'task', action: summary, title: summary, person: null, dueAt: null, remindAt: null,
    localTimeSpec: null, timeEvidence: 'none',
    priority: { level: 'normal', source: 'user_explicit', pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable', category: null, categoryConfidence: 0,
    confidence: { overall: 1, type: 1, action: 1, time: 1, priority: 1 },
    missingFields: ['time'], ambiguityFlags: [], explicitReminderRequest: true,
    explicitPressureRequest: false, rawText: summary, parserVersion: 'structured-edit-v1',
  };
}

function editTurns(edit: CaptureProposalEditContract, before: string, after: string, locale: CaptureAppLocale): { user: string; reply: string } {
  const user = edit.change.text !== undefined
    ? (locale === 'en' ? `Change “${before}” to “${after}”.` : locale === 'he' ? `לשנות את „${before}” ל„${after}”.` : `غيّر «${before}» لـ «${after}».`)
    : edit.change.kind !== undefined
      ? (locale === 'en' ? `Change “${before}” to ${edit.change.kind}.` : locale === 'he' ? `לשנות את הסוג של „${before}”.` : `غيّر نوع «${before}».`)
      : (locale === 'en' ? `Update “${before}”.` : locale === 'he' ? `לעדכן את „${before}”.` : `عدّل «${before}».`);
  const reply = locale === 'en' ? 'Updated. Review the list and confirm below.'
    : locale === 'he' ? 'עודכן. אפשר לבדוק את הרשימה ולאשר למטה.'
      : 'تمام، عدّلتها. راجع القائمة وأكّد من تحت.';
  return { user, reply };
}

/** Synthetic edit display pairs never evict older user evidence. */
function boundedEditTurns(turns: CaptureChatTurn[]): CaptureChatTurn[] {
  const kept = [...turns];
  while (kept.length > 12) {
    const synthetic = kept.findIndex((turn) => turn.role === 'user' && turn.evidence === false);
    if (synthetic < 0) {
      kept.shift();
      continue;
    }
    kept.splice(synthetic, kept[synthetic + 1]?.role === 'assistant' ? 2 : 1);
  }
  while (kept[0]?.role === 'assistant') kept.shift();
  return kept;
}

function statusOf(contract: CaptureProposalContract): CaptureProposalContract['status'] {
  if (contract.items.length === 0) return contract.seeds.length > 0 ? 'unresolved_intent' : 'no_commitment';
  return contract.items.every((item) => item.needsClarification) ? 'needs_clarification' : 'proposed';
}

function timeData(time: { at: string | null; timeZone: string } | undefined): { at: string | null; zone: string; local: ReturnType<typeof localTimeSpecFor> } | null {
  if (!time || !validZone(time.timeZone)) return null;
  if (time.at === null) return { at: null, zone: time.timeZone, local: null };
  if (!validInstant(time.at) || Date.parse(time.at) <= Date.now()) return null;
  const local = localTimeSpecFor(new Date(time.at), time.timeZone);
  return local ? { at: new Date(time.at).toISOString(), zone: time.timeZone, local } : null;
}

function itemCommands(stored: StoredCaptureProposal, itemId: string, result: ExtractionResult, title: string, at: string | null | undefined, zone: string | undefined): Command[] {
  let commands = stored.commandsByItemId.get(itemId) ?? [];
  const normal = { title, ...(at !== undefined ? { resolvedTime: at } : {}) };
  if (commands.length > 0) commands = applyEditToCommands(commands, normal);
  else commands = pending(mapExtractionToCommand(result));
  if (zone) {
    commands = commands.map((command) => command.type === 'CreateDraft'
      ? { ...command, commitment: { ...command.commitment, timeSpec: { ...command.commitment.timeSpec, timezone: zone } } }
      : command);
  }
  return pending(commands);
}

/** The result and pending commands created when a structured edit promotes a point to a commitment. */
export function buildStructuredCommitmentArtifacts(
  stored: StoredCaptureProposal,
  itemId: string,
  title: string,
  time?: { at: string; zone: string; local?: ReturnType<typeof localTimeSpecFor> },
): { result: ExtractionResult; commands: Command[] } {
  let result = seedResult(title);
  if (time) {
    result = {
      ...result,
      dueAt: time.at,
      remindAt: time.at,
      localTimeSpec: time.local ?? localTimeSpecFor(new Date(time.at), time.zone),
      timeEvidence: 'hhmm',
      missingFields: [],
    };
  }
  return {
    result,
    commands: time ? itemCommands(stored, itemId, result, title, time.at, time.zone) : [],
  };
}

function applyEdit(stored: StoredCaptureProposal, edit: CaptureProposalEditContract, now: Date): StoredCaptureProposal {
  const change = edit.change as CaptureProposalEditContract['change'];
  if (!change || typeof change !== 'object' || Array.isArray(change)) throw new StructuredEditError();
  const keys = Object.keys(change);
  const restoring = change.restore === true;
  if (keys.length === 0 || keys.some((key) => !['kind', 'text', 'time', 'rejectCorrectionIds', 'restore'].includes(key))) throw new StructuredEditError();
  if (Object.prototype.hasOwnProperty.call(change, 'restore') && (!restoring || keys.length !== 1)) throw new StructuredEditError();
  if (change.kind !== undefined && !KINDS.has(change.kind)) throw new StructuredEditError();
  if (change.text !== undefined && !validText(change.text)) throw new StructuredEditError();
  if (change.text !== undefined && change.rejectCorrectionIds !== undefined) throw new StructuredEditError();
  if (change.rejectCorrectionIds !== undefined && (!Array.isArray(change.rejectCorrectionIds) || change.rejectCorrectionIds.length === 0 || change.rejectCorrectionIds.some((id) => typeof id !== 'string'))) throw new StructuredEditError();
  const hasTime = Object.prototype.hasOwnProperty.call(change, 'time');
  const parsedTime = hasTime ? timeData(change.time) : undefined;
  if (hasTime && !parsedTime) throw new StructuredEditError();

  const itemId = 'itemId' in edit.target && typeof edit.target.itemId === 'string' ? edit.target.itemId : null;
  const seedId = 'seedItemId' in edit.target && typeof edit.target.seedItemId === 'string' ? edit.target.seedItemId : null;
  if ((!itemId && !seedId) || (itemId && seedId)) throw new StructuredEditError();
  if (restoring) {
    const removed = Object.values(stored.removedChatEntities ?? {}).find((entry) => entry.entityId === (itemId ?? seedId));
    if (!removed || Boolean(removed.item) !== Boolean(itemId) || Boolean(removed.seed) !== Boolean(seedId)) throw new StructuredEditError();
    const contract: CaptureProposalContract = {
      ...stored.contract,
      items: stored.contract.items.map((item) => ({ ...item })),
      seeds: stored.contract.seeds.map((seed) => ({ ...seed })),
    };
    const commands = new Map(stored.commandsByItemId);
    const results = new Map(stored.resultsByItemId ?? []);
    const ordinals = {
      items: { ...(stored.sourceOrdinals?.items ?? {}) },
      seeds: { ...(stored.sourceOrdinals?.seeds ?? {}) },
    };
    const restoredOrdinal = removed.ordinal ?? removed.position;
    if (removed.item) {
      const at = contract.items.findIndex((item) => (ordinals.items[item.itemId] ?? Number.POSITIVE_INFINITY) > restoredOrdinal);
      contract.items.splice(at < 0 ? contract.items.length : at, 0, { ...removed.item });
      commands.set(removed.entityId, [...removed.commands]);
      if (removed.result) results.set(removed.entityId, { ...removed.result });
      ordinals.items[removed.entityId] = restoredOrdinal;
    } else {
      const at = contract.seeds.findIndex((seed) => (ordinals.seeds[seed.seedItemId] ?? Number.POSITIVE_INFINITY) > restoredOrdinal);
      contract.seeds.splice(at < 0 ? contract.seeds.length : at, 0, { ...removed.seed! });
      ordinals.seeds[removed.entityId] = restoredOrdinal;
    }
    const correctionSpans = { ...(stored.correctionSpans ?? {}), ...(removed.correctionSpans ?? {}) };
    const structuredEditSources = {
      ...(stored.structuredEditSources ?? {}),
      ...(removed.structuredEditSource ? { [removed.entityId]: removed.structuredEditSource } : {}),
    };
    const removedChatEntities = { ...(stored.removedChatEntities ?? {}) };
    delete removedChatEntities[removed.ref];
    const keptSeedItemIds = removed.keptSeed
      ? Array.from(new Set([...(stored.keptSeedItemIds ?? []), removed.entityId]))
      : stored.keptSeedItemIds;
    const next = {
      ...stored,
      contract,
      commandsByItemId: commands,
      resultsByItemId: results,
      sourceOrdinals: ordinals,
      correctionSpans,
      structuredEditSources,
      removedChatEntities,
      keptSeedItemIds,
    };
    next.contract = finalizeUnderstood(
      withPublicRemovedItems({ ...contract, status: statusOf(contract) }, next),
      stored.responseLocale ?? 'ar',
      ordinals,
    );
    return next;
  }
  const itemIndex = itemId ? stored.contract.items.findIndex((candidate) => candidate.itemId === itemId) : -1;
  const seedIndex = seedId ? stored.contract.seeds.findIndex((candidate) => candidate.seedItemId === seedId) : -1;
  if (itemIndex < 0 && seedIndex < 0) throw new StructuredEditError();
  if (seedId && (stored.keptSeedItemIds?.includes(seedId) || stored.seedKeepReceipt?.seedItemId === seedId)) {
    throw new StructuredEditError();
  }
  if (hasTime && (
    (itemIndex >= 0 && change.kind !== undefined && change.kind !== 'commitment')
    || (seedIndex >= 0 && change.kind !== 'commitment')
  )) throw new StructuredEditError();

  const contract: CaptureProposalContract = {
    ...stored.contract,
    items: stored.contract.items.map((item) => ({ ...item, ...(item.conflicts ? { conflicts: undefined } : {}) })),
    seeds: stored.contract.seeds.map((seed) => ({ ...seed })),
  };
  const commands = new Map(stored.commandsByItemId);
  const results = new Map(stored.resultsByItemId ?? []);
  const spans = { ...(stored.correctionSpans ?? {}) };
  const carriesPointIds = stored.contract.entry !== undefined
    || stored.contract.habits !== undefined
    || stored.contract.goals !== undefined;
  let changed = false;

  if (itemIndex >= 0) {
    const before = contract.items[itemIndex]!;
    let title = before.title;
    let corrections = before.corrections ? [...before.corrections] : undefined;
    if (change.text !== undefined && change.text.trim() !== title) {
      title = change.text.trim(); changed = true;
      corrections = corrections?.filter((correction) => {
        const span = spans[correction.id];
        const keep = span?.itemId === before.itemId && title.slice(span.index, span.index + span.length) === correction.to;
        if (!keep) delete spans[correction.id];
        return keep;
      });
    }
    if (change.rejectCorrectionIds) {
      for (const id of change.rejectCorrectionIds) {
        const correction = corrections?.find((candidate) => candidate.id === id);
        const span = spans[id];
        if (!correction || !span || span.itemId !== before.itemId || title.slice(span.index, span.index + span.length) !== correction.to) throw new StructuredEditError();
        title = `${title.slice(0, span.index)}${correction.from}${title.slice(span.index + span.length)}`;
        const delta = correction.from.length - span.length;
        delete spans[id];
        corrections = corrections!.filter((candidate) => candidate.id !== id);
        for (const [otherId, other] of Object.entries(spans)) if (other.itemId === before.itemId && other.index > span.index) spans[otherId] = { ...other, index: other.index + delta };
        changed = true;
      }
    }
    if (change.kind !== undefined && change.kind !== 'commitment') {
      changed = true;
      contract.items.splice(itemIndex, 1);
      if (!SEED_KINDS.has(change.kind)) throw new StructuredEditError();
      const pointId = before.pointId ?? (carriesPointIds ? before.itemId : undefined);
      contract.seeds.push({
        seedItemId: before.itemId,
        ...(pointId ? { pointId } : {}),
        kind: change.kind as CaptureSeedProposalContract['kind'],
        summary: title,
      });
      contract.understood = contract.understood?.map((point) =>
        point.kind === 'commitment' && point.itemId === before.itemId
          ? {
            kind: change.kind as CaptureSeedProposalContract['kind'],
            seedItemId: before.itemId,
            ...(pointId ? { pointId } : {}),
            text: title,
          }
          : point);
      commands.delete(before.itemId); results.delete(before.itemId);
      for (const correction of corrections ?? []) delete spans[correction.id];
    } else {
      let next = { ...before, title, ...(corrections?.length ? { corrections } : { corrections: undefined }) };
      let result = results.get(before.itemId) ?? seedResult(title);
      if (title !== before.title) result = { ...result, action: title, title, sourceTitle: title };
      if (parsedTime !== undefined) {
        const appliedTime = parsedTime as NonNullable<typeof parsedTime>;
        changed = changed || before.resolvedTime !== appliedTime.at || before.needsClarification || Boolean(before.endTime);
        const oldLength = before.resolvedTime && before.endTime ? Date.parse(before.endTime) - Date.parse(before.resolvedTime) : null;
        const { endTime: _end, resolvedDate: _date, dateEstimated: _dateGuess, weeklyBlock: _weekly, clarification: _question, ...rest } = next;
        next = {
          ...rest,
          resolvedTime: appliedTime.at,
          needsClarification: false,
          clarification: null,
          timeEstimated: false,
          ...(appliedTime.local ? { resolvedDate: appliedTime.local.date, dateEstimated: false } : {}),
          ...(appliedTime.at && oldLength && oldLength > 0 ? { endTime: new Date(Date.parse(appliedTime.at) + oldLength).toISOString() } : {}),
        };
        result = {
          ...result,
          dueAt: appliedTime.at, remindAt: appliedTime.at,
          localTimeSpec: appliedTime.local,
          timeEvidence: appliedTime.at ? 'hhmm' : 'none',
          rangeMinutes: appliedTime.at && oldLength && oldLength > 0 ? oldLength / 60_000 : undefined,
          missingFields: result.missingFields.filter((field) => field !== 'time'),
          ambiguityFlags: result.ambiguityFlags.filter((flag) => flag !== 'contradictory_time'),
          allDay: false,
        };
      }
      contract.items[itemIndex] = next;
      results.set(before.itemId, result);
      commands.set(before.itemId, itemCommands(stored, before.itemId, result, title, parsedTime?.at, parsedTime?.zone));
    }
  } else {
    const before = contract.seeds[seedIndex]!;
    const summary = change.text === undefined ? before.summary : change.text.trim();
    if (summary !== before.summary) changed = true;
    if (change.kind === 'commitment') {
      changed = true;
      contract.seeds.splice(seedIndex, 1);
      const pointId = before.pointId ?? (carriesPointIds ? before.seedItemId : undefined);
      contract.understood = contract.understood?.map((point) =>
        point.kind !== 'commitment' && point.seedItemId === before.seedItemId
          ? { kind: 'commitment' as const, itemId: before.seedItemId, ...(pointId ? { pointId } : {}), text: summary }
          : point);
      const artifacts = buildStructuredCommitmentArtifacts(
        stored,
        before.seedItemId,
        summary,
        parsedTime?.at ? { at: parsedTime.at, zone: parsedTime.zone, local: parsedTime.local } : undefined,
      );
      const { result } = artifacts;
      const clarification = parsedTime?.at ? null : buildClarification(result, { now, timezone: stored.timezone ?? parsedTime?.zone ?? 'UTC' });
      contract.items.push({
        itemId: before.seedItemId, ...(pointId ? { pointId } : {}), title: summary, resolvedTime: parsedTime?.at ?? null,
        needsClarification: !parsedTime?.at, clarification,
        timeEstimated: false, priority: 'normal', priorityEstimated: false,
        ...(parsedTime?.local ? { resolvedDate: parsedTime.local.date, dateEstimated: false } : {}),
      });
      results.set(before.seedItemId, result);
      commands.set(before.seedItemId, artifacts.commands);
    } else {
      const kind = change.kind ?? before.kind;
      if (kind !== before.kind) changed = true;
      contract.seeds[seedIndex] = { ...before, kind: kind as CaptureSeedProposalContract['kind'], summary };
    }
  }
  if (!changed) throw new StructuredEditError();
  const finalized = finalizeUnderstood({ ...contract, status: statusOf(contract) }, stored.responseLocale ?? 'ar', stored.sourceOrdinals);
  return { ...stored, contract: finalized, commandsByItemId: commands, resultsByItemId: results, correctionSpans: spans };
}

export async function applyStructuredEdit(input: {
  uid: string;
  conversation: StoredCaptureConversation;
  edit: CaptureProposalEditContract;
  locale: CaptureAppLocale;
  now: Date;
  engine: 'model' | 'rules';
  /** Recomputes derived proposal fields after the full edit, before the CAS write. */
  beforeWrite?: (proposal: CaptureProposalContract, stored: StoredCaptureProposal) => Promise<CaptureProposalContract>;
}): Promise<StructuredEditOutcome> {
  const storage = getStorage();
  const proposalId = input.conversation.proposalId;
  if (!proposalId) return { kind: 'changed', proposal: { proposalId: '', revision: 0 } as CaptureProposalContract, confirmed: false };
  const proposalPath = captureProposalPath(input.uid, proposalId);
  const conversationPath = captureConversationPath(input.uid, input.conversation.conversationId);
  const fp = fingerprint(input.edit);
  return storage.runTransaction(async (tx) => {
    const [proposalDoc, conversationDoc] = await Promise.all([
      tx.get<StoredProposalDocument>(proposalPath),
      tx.get<StoredCaptureConversation & { expiresAt?: Date }>(conversationPath),
    ]);
    if (!conversationDoc) throw new StructuredEditConversationNotFoundError();
    if (!proposalDoc) throw new StructuredEditError();
    const stored = captureProposalFromDocument(proposalDoc);
    const currentRevision = proposalRevision(stored.contract);
    if (conversationDoc.proposalId !== input.edit.proposalId) {
      const currentDocument = conversationDoc.proposalId
        ? await tx.get<StoredProposalDocument>(captureProposalPath(input.uid, conversationDoc.proposalId))
        : null;
      const current = currentDocument ? captureProposalFromDocument(currentDocument) : stored;
      return {
        kind: 'changed' as const,
        proposal: current.contract,
        confirmed: current.confirmedResult !== undefined,
        turns: conversationDoc.turns,
      };
    }
    if (stored.editReceipt?.fingerprint === fp && stored.editReceipt.resultingRevision === currentRevision) {
      return { kind: 'replayed' as const, answer: stored.editReceipt.answer, proposal: stored.contract };
    }
    if (input.edit.proposalId !== proposalId || input.edit.revision !== currentRevision || stored.confirmedResult !== undefined) {
      return { kind: 'changed' as const, proposal: stored.contract, confirmed: stored.confirmedResult !== undefined };
    }
    const target = input.edit.target;
    const targetId = 'itemId' in target ? target.itemId
      : 'seedItemId' in target ? target.seedItemId
        : 'habitItemId' in target ? target.habitItemId : target.goalItemId;
    const targetsItem = 'itemId' in target;
    const sourceOrdinal = targetsItem
      ? stored.sourceOrdinals?.items[targetId]
      : stored.sourceOrdinals?.seeds[targetId];
    const removedTarget = input.edit.change.restore === true
      ? Object.values(stored.removedChatEntities ?? {}).find((entry) => entry.entityId === targetId)
      : undefined;
    const beforeTitle = targetsItem
      ? stored.contract.items.find((item) => item.itemId === targetId)?.title
        ?? removedTarget?.item?.title
      : stored.contract.seeds.find((seed) => seed.seedItemId === targetId)?.summary
        ?? removedTarget?.seed?.summary;
    if (!beforeTitle) throw new StructuredEditError();
    const mutated = applyEdit(stored, input.edit, input.now);
    mutated.contract = { ...mutated.contract, revision: currentRevision + 1 };
    const refState = referenceStateFor(stored);
    const targetRef = refState.refs[targetId] ?? removedTarget?.ref;
    if (!targetRef) throw new StructuredEditError();
    mutated.chatRefs = refState.refs;
    mutated.nextChatItemRef = refState.nextItem;
    mutated.nextChatSeedRef = refState.nextSeed;
    mutated.lockedChatRefs = Array.from(new Set([...(stored.lockedChatRefs ?? []), targetRef]));
    const afterTitle = targetsItem
      ? (mutated.contract.items.find((item) => item.itemId === targetId)?.title
        ?? mutated.contract.seeds.find((seed) => seed.seedItemId === targetId)?.summary ?? beforeTitle)
      : (mutated.contract.items.find((item) => item.itemId === targetId)?.title
        ?? mutated.contract.seeds.find((seed) => seed.seedItemId === targetId)?.summary ?? beforeTitle);
    const words = editTurns(input.edit, beforeTitle, afterTitle, input.locale);
    const turns: CaptureChatTurn[] = boundedEditTurns([
      ...conversationDoc.turns,
      // Still rendered as the person's edit in the app, but never eligible
      // as extraction or model evidence on a later message.
      { role: 'user' as const, text: words.user, evidence: false as const },
      { role: 'assistant' as const, text: words.reply },
    ]);
    const previousSource = stored.structuredEditSources?.[targetId];
    mutated.structuredEditSources = {
      ...(stored.structuredEditSources ?? {}),
      [targetId]: {
        ...(previousSource ?? {
          ...(Number.isFinite(sourceOrdinal) ? { ordinal: sourceOrdinal } : {}),
          originalText: beforeTitle,
          ...(stored.resultsByItemId?.get(targetId)?.rawText
            ? { rawText: stored.resultsByItemId.get(targetId)!.rawText }
            : {}),
        }),
        fields: {
          ...(previousSource?.fields ?? {}),
          ...(input.edit.change.text !== undefined ? { text: true as const } : {}),
          ...(input.edit.change.kind !== undefined ? { kind: true as const } : {}),
          ...(Object.prototype.hasOwnProperty.call(input.edit.change, 'time') ? { time: true as const } : {}),
          ...(input.edit.change.rejectCorrectionIds !== undefined ? { corrections: true as const } : {}),
        },
      },
    };
    mutated.contract = withPublicRemovedItems(mutated.contract, mutated);
    if (input.beforeWrite) mutated.contract = await input.beforeWrite(mutated.contract, mutated);
    const answer = { conversationId: input.conversation.conversationId, reply: words.reply, engine: input.engine, proposal: mutated.contract, turns };
    mutated.editReceipt = { fingerprint: fp, resultingRevision: currentRevision + 1, answer };
    mutated.seedKeepReceipt = stored.seedKeepReceipt;
    mutated.legacyConfirmRevision = undefined;
    const updatedAt = new Date().toISOString();
    tx.set(proposalPath, captureProposalToDocument(mutated, new Date()));
    const { messageReceipt: _staleMessageReceipt, ...conversationWithoutReceipt } = conversationDoc;
    tx.set(conversationPath, { ...conversationWithoutReceipt, turns, proposalId: conversationDoc.proposalId, updatedAt, expiresAt: new Date(Date.now() + CAPTURE_PROPOSAL_RETENTION_MS) });
    return { kind: 'applied' as const, answer, proposal: mutated.contract };
  });
}
