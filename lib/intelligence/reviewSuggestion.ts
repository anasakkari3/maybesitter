import type { Command } from '../../src/domain/stateMachine';
import { getStorage, type StorageAdapter } from '../storage';
import { createStorageRuntimeMemoryStore } from '../runtimeMemory/runtimeMemoryStore';
import { commitCommandsWithClaim } from '../services/mobile/participantState';
import { suggestionPath, type IntelligenceSuggestion } from './proposalEngine';
import { previewSuggestionSchedule } from './schedulePreview';

export type SuggestionDecision = 'accept' | 'dismiss';

export class QuestionAnswerRequiredError extends Error {
  constructor() { super('question_requires_answer'); }
}

export class InvalidSuggestionEditError extends Error {
  constructor() { super('invalid_suggestion_edit'); }
}

export class SuggestionScheduleChangedError extends Error {
  constructor() { super('suggestion_schedule_changed'); }
}

function languageOf(text: string): 'ar' | 'he' | 'en' {
  if (/[\u0590-\u05ff]/.test(text)) return 'he';
  return /[\u0600-\u06ff]/.test(text) ? 'ar' : 'en';
}

/** Only an explicit user decision can turn a proposal into canonical work. */
export async function reviewSuggestion(
  uid: string,
  id: string,
  decision: SuggestionDecision,
  now: string,
  storage: StorageAdapter = getStorage(),
  edits: { title?: string; slot?: { startsAt: string; endsAt: string } } = {},
): Promise<IntelligenceSuggestion | null> {
  const path = suggestionPath(uid, id);
  const current = await storage.get<IntelligenceSuggestion>(path);
  if (!current) return null;
  if (current.status === 'accepted' || current.status === 'dismissed') return current;
  const editedTitle = edits.title === undefined ? null : typeof edits.title === 'string' ? edits.title.trim() : '';
  if (editedTitle !== null && (decision !== 'accept' || (current.kind !== 'action' && current.kind !== 'goal')
    || editedTitle.length < 4 || editedTitle.length > 100)) throw new InvalidSuggestionEditError();
  if (decision === 'dismiss') {
    return storage.runTransaction(async tx => {
      const latest = await tx.get<IntelligenceSuggestion>(path);
      if (!latest) return null;
      if (latest.status !== 'pending') return latest;
      const next: IntelligenceSuggestion = { ...latest, status: 'dismissed', decidedAt: now };
      tx.set(path, next);
      return next;
    });
  }
  if (current.kind === 'question') throw new QuestionAnswerRequiredError();

  if (current.kind === 'action') {
    // The client accepts the slot it showed, not a silently changed schedule.
    // Re-solve against live commitments and busy time before writing a pinned task.
    let acceptedSlot: { startsAt: string; endsAt: string } | null = null;
    if (edits.slot) {
      const slot = edits.slot;
      if (!Number.isFinite(Date.parse(slot.startsAt)) || !Number.isFinite(Date.parse(slot.endsAt))
        || Date.parse(slot.startsAt) < Date.parse(now) || Date.parse(slot.endsAt) <= Date.parse(slot.startsAt)) {
        throw new SuggestionScheduleChangedError();
      }
      const [fresh] = await previewSuggestionSchedule(uid, [current], now, storage);
      if (fresh?.slot?.startsAt !== slot.startsAt || fresh.slot.endsAt !== slot.endsAt) {
        throw new SuggestionScheduleChangedError();
      }
      acceptedSlot = slot;
    }
    const commitmentId = `int_${id}`;
    await commitCommandsWithClaim<IntelligenceSuggestion>(uid, path, claim => {
      if (!claim || claim.status !== 'pending' || claim.kind !== 'action') return null;
      const commands: Command[] = [
        { type: 'CreateDraft', now, commitment: {
          id: commitmentId, kind: 'task', title: editedTitle ?? claim.title,
          priority: { level: 'normal', source: 'user_explicit', pressureAllowed: false },
          ...(acceptedSlot ? { timeSpec: { kind: 'due_by' as const,
            dueAt: acceptedSlot.startsAt, endAt: acceptedSlot.endsAt } } : {}),
        }, draftStatus: 'pending_confirmation' },
        { type: 'ConfirmCommitment', commitmentId, now },
      ];
      return { commands, patch: { status: 'accepted', title: editedTitle ?? claim.title, decidedAt: now, linkedEntityId: commitmentId } };
    });
    return storage.get<IntelligenceSuggestion>(path);
  }

  if (current.kind === 'goal') {
    const claimed = await storage.runTransaction(async tx => {
      const latest = await tx.get<IntelligenceSuggestion>(path);
      if (!latest || (latest.status !== 'pending' && latest.status !== 'accepting')) return null;
      const next = { ...latest, status: 'accepting' as const,
        title: latest.status === 'pending' ? editedTitle ?? latest.title : latest.title };
      if (latest.status === 'pending') tx.set(path, next);
      return next;
    });
    if (!claimed) return storage.get<IntelligenceSuggestion>(path);
    const memory = await createStorageRuntimeMemoryStore(undefined, storage).putIdempotent({
      scopeId: uid, kind: 'goal', content: claimed.title, language: languageOf(claimed.title),
      source: 'model_inferred', confidence: claimed.confidence, observedAt: now,
      evidenceIds: claimed.observationIds,
      provenance: { origin: 'proactive_suggestion', originRef: id, confirmedByUserAt: now },
    }, now, `proactive:${id}`);
    return storage.runTransaction(async tx => {
      const latest = await tx.get<IntelligenceSuggestion>(path);
      if (!latest) return null;
      const next: IntelligenceSuggestion = { ...latest, status: 'accepted', decidedAt: now, linkedEntityId: memory.id };
      tx.set(path, next);
      return next;
    });
  }

  // A warning is acknowledged, not turned into an obligation.
  return storage.runTransaction(async tx => {
    const latest = await tx.get<IntelligenceSuggestion>(path);
    if (!latest) return null;
    if (latest.status !== 'pending') return latest;
    const next: IntelligenceSuggestion = { ...latest, status: 'accepted', decidedAt: now };
    tx.set(path, next);
    return next;
  });
}
