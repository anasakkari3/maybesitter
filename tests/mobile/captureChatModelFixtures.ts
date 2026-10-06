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

type PromptEntry = { ref: string; locked: boolean };

export function recordedFullListAnswer(
  reply: unknown,
  action: RecordedFullListAnswer['action'],
  items: unknown[],
): RecordedFullListAnswer {
  return { reply, action, items };
}

function currentProposalFrom(prompt: string): PromptEntry[] {
  const lines = prompt.split('\n');
  const boundary = lines.indexOf('BEGIN_UNTRUSTED_USER_MESSAGE');
  if (boundary < 0 || boundary + 1 >= lines.length) throw new Error('capture-chat prompt has no untrusted payload');
  const data = JSON.parse(lines[boundary + 1]!) as { currentProposal?: unknown };
  if (!Array.isArray(data.currentProposal)) return [];
  return data.currentProposal.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const entry = value as Record<string, unknown>;
    return typeof entry.ref === 'string' && typeof entry.locked === 'boolean'
      ? [{ ref: entry.ref, locked: entry.locked }]
      : [];
  });
}

function isV5Answer(value: Record<string, unknown>): boolean {
  return Array.isArray(value.locked) && Array.isArray(value.open) && Array.isArray(value.added);
}

/** Render a recorded fixture as the exact v5 JSON a fake model returns. */
export function renderRefModelAnswer(answer: unknown, prompt: string): string {
  if (typeof answer === 'string') return answer;
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return JSON.stringify(answer);
  const record = answer as Record<string, unknown>;
  if (isV5Answer(record)) return JSON.stringify(record);
  if (!Array.isArray(record.items) || typeof record.action !== 'string') return JSON.stringify(record);

  const fixture = record as RecordedFullListAnswer;
  if (fixture.action === 'chat') {
    return JSON.stringify({ reply: fixture.reply, action: fixture.action, locked: [], open: [], added: [] });
  }
  const current = currentProposalFrom(prompt);
  if (current.length === 0) {
    return JSON.stringify({ reply: fixture.reply, action: fixture.action, locked: [], open: [], added: fixture.items });
  }
  const locked: Array<Record<string, unknown>> = [];
  const open: Array<Record<string, unknown>> = [];
  current.forEach((entry, index) => {
    const fields = fixture.items[index];
    const operation = fields === undefined
      ? { ref: entry.ref, op: 'remove' }
      : entry.locked ? { ref: entry.ref, op: 'keep' } : { ref: entry.ref, op: 'update', fields };
    (entry.locked ? locked : open).push(operation);
  });
  return JSON.stringify({
    reply: fixture.reply,
    action: fixture.action,
    locked,
    open,
    added: fixture.items.slice(current.length),
  });
}
