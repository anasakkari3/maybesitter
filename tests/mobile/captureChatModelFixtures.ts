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
  /** Exact newest-message citation for each item; null means no operation. */
  sources?: Array<string | null>;
  /** Recorded fields intentionally rendered as v5 keep operations, by zero-based item index. */
  expectedKeeps?: number[];
};

type PromptEntry = { ref: string; locked: boolean; title: string; date: string | null; time: string | null };

type PromptData = { current: PromptEntry[] };

export function recordedFullListAnswer(
  reply: unknown,
  action: RecordedFullListAnswer['action'],
  items: unknown[],
  sources?: Array<string | null>,
  expectedKeeps?: number[],
): RecordedFullListAnswer {
  return { reply, action, items, ...(sources ? { sources } : {}), ...(expectedKeeps ? { expectedKeeps } : {}) };
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
  return { current };
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

/** Render a recorded fixture as the exact v5 JSON a fake model returns. */
export function renderRefModelAnswer(answer: unknown, prompt: string): string {
  if (typeof answer === 'string') return answer;
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return JSON.stringify(answer);
  const record = answer as Record<string, unknown>;
  const promptData = promptDataFrom(prompt);
  if (isV5Answer(record)) return JSON.stringify(record);
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
    const source = fixture.sources?.[index];
    const expectedKeep = fixture.expectedKeeps?.includes(index) === true;
    if (fields !== undefined && !entry.locked && !isSamePoint(fields, entry) && !source && !expectedKeep) {
      throw new Error(`recorded fixture update is missing an explicit citation for item ${index + 1}`);
    }
    const operation = fields === undefined
      ? { ref: entry.ref, op: 'remove', ...(source ? { source } : {}) }
      : entry.locked || isSamePoint(fields, entry) || expectedKeep
        ? { ref: entry.ref, op: 'keep' }
        : { ref: entry.ref, op: 'update', fields, ...(source ? { source } : {}) };
    (entry.locked ? locked : open).push(operation);
  });
  const added = fixture.items.slice(current.length).map((fields, index) => {
    const source = fixture.sources?.[current.length + index];
    if (!source) throw new Error(`recorded fixture add is missing an explicit citation for item ${current.length + index + 1}`);
    return fields && typeof fields === 'object' && !Array.isArray(fields) && source
      ? { ...(fields as Record<string, unknown>), source }
      : fields;
  });
  return JSON.stringify({
    reply: fixture.reply,
    action: fixture.action,
    locked,
    open,
    added,
  });
}
