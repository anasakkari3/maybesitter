import type { Command } from '../../src/domain/stateMachine';
import { getStorage, type StorageAdapter } from '../storage';
import { createStorageRuntimeMemoryStore, personalizationWriteGuard } from '../runtimeMemory/runtimeMemoryStore';
import { commitCommandsWithClaim } from '../services/mobile/participantState';
import { isDismissedBehaviourOutcome, suggestionPath, type IntelligenceSuggestion } from './proposalEngine';
import { slotStillFitsSchedule } from './schedulePreview';
import { listObservations, observationPath } from './observationStore';

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

export class AutoAddedSuggestionError extends Error {
  constructor() { super('suggestion_already_auto_added'); }
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
  // A suggestion that cites an outcome the person has dismissed is dismissed
  // before any check that could fail and leave it pending — a stale slot, for
  // one (M5B2A-R16-001). The guards inside each claim still close the race.
  const settled = await storage.runTransaction(async tx => {
    const latest = await tx.get<IntelligenceSuggestion>(path);
    if (!latest) return { done: true as const, value: null };
    if (latest.status === 'accepted' || latest.status === 'dismissed') return { done: true as const, value: latest };
    // An accept already under way ('accepting') claimed its outcomes before
    // they were dismissed, and its retry finishes that claim below.
    if (latest.status !== 'pending') return { done: false as const };
    const cited = await Promise.all(latest.observationIds.map(observationId => tx.get(observationPath(uid, observationId))));
    if (!cited.some(isDismissedBehaviourOutcome)) return { done: false as const };
    const next: IntelligenceSuggestion = { ...latest, status: 'dismissed', decidedAt: now };
    tx.set(path, next);
    return { done: true as const, value: next };
  });
  if (settled.done) return settled.value;
  const observations = await listObservations(uid, storage);
  const autoAdded = new Set(observations.filter(item => item.autoAddId).map(item => item.id));
  if (current.observationIds.some(id => autoAdded.has(id))) throw new AutoAddedSuggestionError();
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
      if (!(await slotStillFitsSchedule(uid, current, slot, now, storage))) {
        throw new SuggestionScheduleChangedError();
      }
      acceptedSlot = slot;
    }
    const commitmentId = `int_${id}`;
    await commitCommandsWithClaim<IntelligenceSuggestion>(uid, path, (claim, context) => {
      if (!claim || claim.status !== 'pending' || claim.kind !== 'action') return null;
      if (context.guards.some(isDismissedBehaviourOutcome)) {
        return { commands: [], patch: { status: 'dismissed', decidedAt: now } };
      }
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
    }, current.observationIds.map(observationId => observationPath(uid, observationId)));
    return storage.get<IntelligenceSuggestion>(path);
  }

  if (current.kind === 'goal') {
    const claimed = await storage.runTransaction(async tx => {
      const latest = await tx.get<IntelligenceSuggestion>(path);
      if (!latest || (latest.status !== 'pending' && latest.status !== 'accepting')) return null;
      if (latest.status === 'pending') {
        const cited = await Promise.all(latest.observationIds.map(observationId =>
          tx.get(observationPath(uid, observationId))));
        if (cited.some(isDismissedBehaviourOutcome)) {
          const dismissed: IntelligenceSuggestion = { ...latest, status: 'dismissed', decidedAt: now };
          tx.set(path, dismissed);
          return null;
        }
      }
      const next = { ...latest, status: 'accepting' as const,
        title: latest.status === 'pending' ? editedTitle ?? latest.title : latest.title };
      if (latest.status === 'pending') tx.set(path, next);
      return next;
    });
    if (!claimed) return storage.get<IntelligenceSuggestion>(path);
    // Fenced against a delete-all or a withdrawal (M5B2A-R34-001).
    const guard = await personalizationWriteGuard(storage, uid);
    const memory = await createStorageRuntimeMemoryStore(undefined, storage).putIdempotent({
      scopeId: uid, kind: 'goal', content: claimed.title, language: languageOf(claimed.title),
      source: 'model_inferred', confidence: claimed.confidence, observedAt: now,
      evidenceIds: claimed.observationIds,
      provenance: { origin: 'proactive_suggestion', originRef: id, confirmedByUserAt: now },
    }, now, `proactive:${id}`, guard);
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
    const cited = await Promise.all(latest.observationIds.map(observationId =>
      tx.get(observationPath(uid, observationId))));
    if (cited.some(isDismissedBehaviourOutcome)) {
      const dismissed: IntelligenceSuggestion = { ...latest, status: 'dismissed', decidedAt: now };
      tx.set(path, dismissed);
      return dismissed;
    }
    const next: IntelligenceSuggestion = { ...latest, status: 'accepted', decidedAt: now };
    tx.set(path, next);
    return next;
  });
}
