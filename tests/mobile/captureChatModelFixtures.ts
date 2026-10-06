/**
 * Adapts recorded pre-v5 full-list model fixtures at the test boundary.
 * The fake provider returns the production v5 ref shape, so the production
 * parser and ref merge are exercised without a compatibility path in runtime
 * code. New identity-focused tests should write v5 operations directly.
 */

export type RecordedFullListAnswer = {
  reply: unknown;
  action: 'propose' | 'update' | 'ask' | 'chat';
  items: unknown[];
};

import { splitCaptureClauseDetails } from '../../src/extraction/clauseSplitter.ts';
import { contentWords } from '../../lib/services/captureBoundary/chatEvidence.ts';

type PromptEntry = { ref: string; locked: boolean; title: string; date: string | null; time: string | null };

type PromptData = { current: PromptEntry[]; newestMessage: string };

export function recordedFullListAnswer(
  reply: unknown,
  action: RecordedFullListAnswer['action'],
  items: unknown[],
): RecordedFullListAnswer {
  return { reply, action, items };
}

function promptDataFrom(prompt: string): PromptData {
  const lines = prompt.split('\n');
  const boundary = lines.indexOf('BEGIN_UNTRUSTED_USER_MESSAGE');
  if (boundary < 0 || boundary + 1 >= lines.length) throw new Error('capture-chat prompt has no untrusted payload');
  const data = JSON.parse(lines[boundary + 1]!) as { currentProposal?: unknown; conversation?: unknown };
  const current = !Array.isArray(data.currentProposal) ? [] : data.currentProposal.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const entry = value as Record<string, unknown>;
    return typeof entry.ref === 'string' && typeof entry.locked === 'boolean'
      ? [{
        ref: entry.ref,
        locked: entry.locked,
        title: typeof entry.title === 'string' ? entry.title : '',
        date: typeof entry.date === 'string' ? entry.date : null,
        time: typeof entry.time === 'string' ? entry.time : null,
      }]
      : [];
  });
  const conversation = Array.isArray(data.conversation) ? data.conversation : [];
  const newest = conversation.at(-1);
  return {
    current,
    newestMessage: newest && typeof newest === 'object' && !Array.isArray(newest)
      && typeof (newest as Record<string, unknown>).text === 'string'
      ? (newest as Record<string, string>).text
      : '',
  };
}

function isV5Answer(value: Record<string, unknown>): boolean {
  return Array.isArray(value.locked) && Array.isArray(value.open) && Array.isArray(value.added);
}

function titleOf(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const entry = value as Record<string, unknown>;
  return typeof entry.title === 'string' ? entry.title : typeof entry.action === 'string' ? entry.action : '';
}

function isSamePoint(fields: unknown, before: PromptEntry): boolean {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return false;
  const entry = fields as Record<string, unknown>;
  const spec = entry.localTimeSpec && typeof entry.localTimeSpec === 'object' && !Array.isArray(entry.localTimeSpec)
    ? entry.localTimeSpec as Record<string, unknown>
    : null;
  return titleOf(fields).trim() === before.title
    && (typeof spec?.date === 'string' ? spec.date : null) === before.date
    && (typeof spec?.time === 'string' ? spec.time : null) === before.time;
}

function messageTargetsEntry(message: string, current: readonly PromptEntry[], index: number): boolean {
  if (/^\s*(?:ok(?:ay)?|thanks?|تمام|شكرا|شكرًا|כן|תודה)[.!؟?]*\s*$/i.test(message)) return false;
  const words = contentWords(message);
  if (contentWords(current[index]!.title).some((word) => words.includes(word))) return true;
  const namesSecond = /(?:\bsecond\b|(?:^|\s)و?(?:التانيه|التانية|الثانيه|الثانية)(?=\s|$))/i.test(message);
  const namesFirst = /(?:\bfirst\b|(?:^|\s)و?(?:الاول|الأول|الاولى|الأولى)(?=\s|$))/i.test(message);
  if (namesFirst || namesSecond) return (index === 0 && namesFirst) || (index === 1 && namesSecond);
  return current.length === 1;
}

/** Test-only adapter for recordings made before capture-chat-v9 citations. */
function withFixtureCitations(answer: Record<string, unknown>, newestMessage: string, current: readonly PromptEntry[]): Record<string, unknown> {
  if (!newestMessage) return answer;
  const open = Array.isArray(answer.open) ? answer.open.map((value) => {
    const operation = { ...(value as Record<string, unknown>) };
    const beforeIndex = current.findIndex((entry) => entry.ref === operation.ref);
    const before = beforeIndex >= 0 ? current[beforeIndex] : undefined;
    return operation.op === 'update' && before
      && (isSamePoint(operation.fields, before) || !messageTargetsEntry(newestMessage, current, beforeIndex))
      ? { ref: operation.ref, op: 'keep' }
      : operation;
  }) : [];
  const added = Array.isArray(answer.added) ? answer.added.map((value) => (
    value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : value
  )) : [];
  const targets = [
    ...open.flatMap((operation, index) => operation.op === 'update' && operation.source === undefined
      ? [{ kind: 'open' as const, index, title: titleOf(operation.fields) }]
      : []),
    ...added.flatMap((fields, index) => fields && typeof fields === 'object' && !Array.isArray(fields)
      && !Object.prototype.hasOwnProperty.call(fields, 'source')
      ? [{ kind: 'added' as const, index, title: titleOf(fields) }]
      : []),
  ];
  if (targets.length === 0) return answer;
  let clauses = splitCaptureClauseDetails(newestMessage).map((clause) => clause.text.trim()).filter(Boolean);
  // Older recordings sometimes answer two ordinal clauses joined only by
  // Arabic waw ("the first ... and the second ..."). The production model is
  // now required to cite those spans itself; this test-only adapter gives the
  // pre-v9 recording the two literal, non-overlapping spans it would cite.
  if (targets.length > 1 && clauses.length < targets.length) {
    const ordinalStarts = Array.from(newestMessage.matchAll(/(?:^|\s)(?:و\s*)?(?:first|second|third|الأولى|الاولى|الأول|الاول|الثانية|التانية|الثاني|التاني|الثالثة|التالتة|الثالث|التالت)(?=\s|$)/gi))
      .map((match) => match.index ?? 0);
    if (ordinalStarts.length >= targets.length) {
      clauses = ordinalStarts.map((start, index) => newestMessage.slice(start, ordinalStarts[index + 1] ?? newestMessage.length).trim());
    }
  }
  const unused = new Set(clauses.map((_, index) => index));
  targets.forEach((target) => {
    let source = newestMessage;
    if (targets.length > 1 && clauses.length >= targets.length) {
      const title = contentWords(target.title);
      const scored = Array.from(unused).map((index) => ({
        index,
        score: title.filter((word) => contentWords(clauses[index]!).includes(word)).length,
      })).sort((a, b) => b.score - a.score || a.index - b.index);
      const picked = scored[0];
      if (picked) {
        source = clauses[picked.index]!;
        unused.delete(picked.index);
      }
    }
    if (target.kind === 'open') open[target.index]!.source = source;
    else (added[target.index] as Record<string, unknown>).source = source;
  });
  return { ...answer, open, added };
}

/** Render a recorded fixture as the exact v5 JSON a fake model returns. */
export function renderRefModelAnswer(answer: unknown, prompt: string): string {
  if (typeof answer === 'string') return answer;
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return JSON.stringify(answer);
  const record = answer as Record<string, unknown>;
  const promptData = promptDataFrom(prompt);
  if (isV5Answer(record)) return JSON.stringify(withFixtureCitations(record, promptData.newestMessage, promptData.current));
  if (!Array.isArray(record.items) || typeof record.action !== 'string') return JSON.stringify(record);

  const fixture = record as RecordedFullListAnswer;
  if (fixture.action === 'chat') {
    return JSON.stringify({ reply: fixture.reply, action: fixture.action, locked: [], open: [], added: [] });
  }
  const current = promptData.current;
  if (current.length === 0) {
    return JSON.stringify({ reply: fixture.reply, action: fixture.action, locked: [], open: [], added: fixture.items });
  }
  const locked: Array<Record<string, unknown>> = [];
  const open: Array<Record<string, unknown>> = [];
  current.forEach((entry, index) => {
    const fields = fixture.items[index];
    const operation = fields === undefined
      ? { ref: entry.ref, op: 'remove' }
      : entry.locked || isSamePoint(fields, entry) || !messageTargetsEntry(promptData.newestMessage, current, index)
        ? { ref: entry.ref, op: 'keep' }
        : { ref: entry.ref, op: 'update', fields };
    (entry.locked ? locked : open).push(operation);
  });
  return JSON.stringify(withFixtureCitations({
    reply: fixture.reply,
    action: fixture.action,
    locked,
    open,
    added: fixture.items.slice(current.length),
  }, promptData.newestMessage, current));
}
