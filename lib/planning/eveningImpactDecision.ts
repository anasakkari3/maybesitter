import { randomUUID } from 'node:crypto';
import type { CaptureProposalContract, EveningImpactContract } from '../../src/contracts/v1/captureContracts';
import type { Command } from '../../src/domain/stateMachine';
import { CAPTURE_PROPOSALS, getStorage, userCol, type StorageAdapter } from '../storage';
import { requireLiveAccount } from '../account/accountLiveness';
import {
  captureProposalFromDocument,
  type StoredProposalDocument,
} from '../services/captureBoundary/proposalStore';
import { proposalRevision } from '../services/captureBoundary/proposalProtocol';
import { addCivilDays } from '../services/dailyPlan/dailyPlanService';
import { candidateClashes, captureTimedIntervals, findFreeSlots, readFreeSlotSchedule, runScheduleDecisionHook } from './freeSlots';
import { eveningImpacts } from './eveningImpact';

export type Readiness = 'ready' | 'not_ready' | 'unsure';
export type ImpactDecisionResult = { kind: 'ok'; proposal: CaptureProposalContract } | { kind: 'changed'; proposal: CaptureProposalContract }
  | { kind: 'not_found' } | { kind: 'expired' };

function localDate(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}
function samePair(a: EveningImpactContract, b: EveningImpactContract): boolean {
  return a.role === b.role && a.otherTitle === b.otherTitle && a.otherStartsAt === b.otherStartsAt
    && a.otherEndsAt === b.otherEndsAt && a.otherInProposal === b.otherInProposal;
}
function removePrep(document: StoredProposalDocument, contract: CaptureProposalContract, sourceItemId: string): { document: StoredProposalDocument; contract: CaptureProposalContract } {
  const generated = contract.items.filter((item) => item.generated?.sourceItemId === sourceItemId).map((item) => item.itemId);
  if (!generated.length) return { document, contract };
  const ids = new Set(generated);
  const commands = { ...document.commands }; const results = { ...(document.results ?? {}) }; const chatRefs = { ...(document.chatRefs ?? {}) };
  const sourceOrdinals = document.sourceOrdinals
    ? { items: { ...document.sourceOrdinals.items }, seeds: { ...document.sourceOrdinals.seeds } }
    : undefined;
  const chatOperationIndices = document.chatOperationIndices
    ? { items: { ...document.chatOperationIndices.items }, seeds: { ...document.chatOperationIndices.seeds } }
    : undefined;
  const correctionSpans = { ...(document.correctionSpans ?? {}) };
  for (const id of generated) {
    delete commands[id]; delete results[id]; delete chatRefs[id];
    if (sourceOrdinals) delete sourceOrdinals.items[id];
    if (chatOperationIndices) delete chatOperationIndices.items[id];
    for (const [correctionId, span] of Object.entries(correctionSpans)) if (span.itemId === id) delete correctionSpans[correctionId];
  }
  return {
    contract: { ...contract, items: contract.items.filter((item) => !ids.has(item.itemId)), understood: contract.understood?.filter((point) => !('itemId' in point) || typeof point.itemId !== 'string' || !ids.has(point.itemId)) },
    document: { ...document, commands, results, chatRefs, sourceOrdinals, chatOperationIndices, correctionSpans },
  };
}

export async function answerEveningImpact(
  uid: string,
  input: { proposalId: string; revision: number; itemId: string; readiness: Readiness },
  now = new Date(),
): Promise<ImpactDecisionResult> {
  const storage = getStorage();
  const path = `${userCol(uid, CAPTURE_PROPOSALS)}/${input.proposalId}`;
  const prepId = randomUUID(); const prepCommitmentId = randomUUID(); const prepReminderId = randomUUID();
  return storage.runTransaction(async (tx) => {
    // The account deletion fence (#772): the answer rewrites the proposal.
    await requireLiveAccount(tx, uid);
    const document = await tx.get<StoredProposalDocument>(path);
    if (!document || document.scopeId !== uid) return { kind: 'not_found' as const };
    const stored = captureProposalFromDocument(document);
    if (stored.proposedAt && Date.parse(stored.proposedAt) + 30 * 60_000 < now.getTime()) return { kind: 'expired' as const };
    if (proposalRevision(stored.contract) !== input.revision) return { kind: 'changed' as const, proposal: stored.contract };
    const selected = stored.contract.items.find((item) => item.itemId === input.itemId);
    if (!selected?.impacts?.[0]) return { kind: 'not_found' as const };
    const timezone = stored.timezone ?? 'Asia/Jerusalem';
    const oldImpact = selected.impacts[0];
    const eveningStart = oldImpact.role === 'evening' ? selected.resolvedTime : oldImpact.otherStartsAt;
    if (!eveningStart) return { kind: 'not_found' as const };
    const windowStart = new Date(Date.parse(eveningStart) - 48 * 3_600_000).toISOString();
    const windowEnd = new Date(Date.parse(eveningStart) + 36 * 3_600_000).toISOString();
    const schedule = await readFreeSlotSchedule(uid, { startsAt: windowStart, endsAt: windowEnd }, tx as unknown as StorageAdapter, now.toISOString());
    const fresh = eveningImpacts(stored.contract.items, schedule, timezone).find((row) => row.itemId === input.itemId)?.impact;
    if (!fresh || !samePair(oldImpact, fresh)) {
      const cleaned = removePrep(document, stored.contract, input.itemId);
      const items = cleaned.contract.items.map((item) => item.itemId === input.itemId ? (({ impacts: _impacts, ...plain }) => plain)(item) : item);
      const proposal = { ...cleaned.contract, items, revision: proposalRevision(cleaned.contract) + 1 };
      tx.set(path, { ...cleaned.document, contract: proposal });
      return { kind: 'changed' as const, proposal };
    }
    let cleaned = removePrep(document, stored.contract, input.itemId);
    let prep: EveningImpactContract['prep'] = null;
    if (input.readiness !== 'ready') {
      const eveningDate = localDate(eveningStart, timezone);
      const dates = [addCivilDays(eveningDate, -1), eveningDate];
      const candidates = schedule.complete ? await findFreeSlots({
        policy: 'capture', uid, timezone, now: now.toISOString(), dates, durationMinutes: 60,
        schedule, held: captureTimedIntervals(cleaned.contract), limit: 100, minimumSeparationMinutes: 15,
        storage: tx as unknown as StorageAdapter,
      }) : [];
      let chosen = candidates.find((slot) => Date.parse(slot.endsAt) <= Date.parse(eveningStart)
        && candidateClashes(schedule, { dueAt: slot.startsAt, endAt: slot.endsAt, kind: 'scheduled_event' }).state === 'free');
      await runScheduleDecisionHook('impact');
      if (chosen) {
        const checked = candidateClashes(schedule, { dueAt: chosen.startsAt, endAt: chosen.endsAt, kind: 'scheduled_event' });
        if (checked.state !== 'free') chosen = undefined;
      }
      if (chosen) {
        const title = `تحضير لـ${oldImpact.role === 'evening' ? oldImpact.otherTitle : selected.title}`;
        const item = { itemId: prepId, title, resolvedTime: chosen.startsAt, endTime: chosen.endsAt, resolvedDate: localDate(chosen.startsAt, timezone),
          needsClarification: false, priority: 'normal' as const, priorityEstimated: false, clarification: null,
          generated: { kind: 'evening_impact_prep' as const, sourceItemId: input.itemId } };
        const sourceOrdinals = {
          items: { ...(cleaned.document.sourceOrdinals?.items ?? {}) },
          seeds: { ...(cleaned.document.sourceOrdinals?.seeds ?? {}) },
        };
        sourceOrdinals.items[prepId] = Math.max(-1, ...Object.values(sourceOrdinals.items), ...Object.values(sourceOrdinals.seeds)) + 1;
        const commands: Command[] = [
          { type: 'CreateDraft', now: now.toISOString(), draftStatus: 'pending_confirmation', commitment: { id: prepCommitmentId, kind: 'task', title,
            timeSpec: { kind: 'due_by', dueAt: chosen.startsAt, endAt: chosen.endsAt, remindAt: chosen.startsAt, allDay: false, timezone, windowRule: 'shift' } } },
          { type: 'ConfirmCommitment', commitmentId: prepCommitmentId, now: now.toISOString(), reminders: [{ id: prepReminderId, reminderType: 'due_soon', scheduledFor: chosen.startsAt, requiresAction: true }] },
        ];
        cleaned = {
          contract: { ...cleaned.contract, items: [...cleaned.contract.items, item], understood: [
            ...(cleaned.contract.understood ?? []),
            { kind: 'commitment' as const, itemId: prepId, text: title },
          ] },
          document: { ...cleaned.document, commands: { ...cleaned.document.commands, [prepId]: commands },
            results: { ...(cleaned.document.results ?? {}), [prepId]: { ...(cleaned.document.results?.[input.itemId] ?? {}), title, action: title, dueAt: chosen.startsAt, remindAt: chosen.startsAt } as any },
            chatRefs: { ...(cleaned.document.chatRefs ?? {}), [prepId]: `i${cleaned.document.nextChatItemRef ?? 1}` },
            nextChatItemRef: (cleaned.document.nextChatItemRef ?? 1) + 1,
            sourceOrdinals },
        };
        prep = { state: 'offered', itemId: prepId };
      } else prep = { state: 'no_slot' };
    }
    const items = cleaned.contract.items.map((item) => item.itemId === input.itemId
      ? { ...item, impacts: [{ ...fresh, readiness: input.readiness, prep }] }
      : item);
    const proposal = { ...cleaned.contract, items, revision: proposalRevision(cleaned.contract) + 1 };
    tx.set(path, { ...cleaned.document, contract: proposal });
    return { kind: 'ok' as const, proposal };
  });
}
