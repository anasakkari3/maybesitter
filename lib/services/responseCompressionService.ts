import type { FormattedResponse, ResponseFormatterNextStep } from './responseFormatter';

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stripPeriod(value: string): string {
  return normalize(value).replace(/[.]+$/g, '');
}

function stripTerminalPunctuation(value: string): string {
  return normalize(value).replace(/[.?!]+$/g, '');
}

function withTerminalPunctuation(value: string): string {
  const text = normalize(value);
  if (!text) return '';
  return /[.?!]$/.test(text) ? text : `${text}.`;
}

function lowercaseFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function sentenceParts(value: string): string[] {
  return normalize(value)
    .split(/(?<=[.?!])\s+/)
    .map(stripTerminalPunctuation)
    .filter(Boolean);
}

export function compressInterpretation(value: string): string {
  const parts = sentenceParts(value);
  if (parts.length === 0) return '';
  if (parts.length === 1) return withTerminalPunctuation(normalize(value));

  const [first, ...rest] = parts;
  const terminal = normalize(value).endsWith('?') ? '?' : normalize(value).endsWith('!') ? '!' : '.';
  return `${first}; ${rest.map(lowercaseFirst).join('; ')}${terminal}`;
}

function quotedTitle(action: string): string | null {
  return action.match(/"([^"]+)"/)?.[1] || null;
}

function compressAction(action: string): string | null {
  const title = quotedTitle(action);

  if (/^Created a draft/i.test(action)) {
    return title ? `Drafted "${title}"` : 'Drafted commitment';
  }

  if (/^Confirmed the commitment and scheduled a reminder/i.test(action)) {
    return 'Confirmed and scheduled reminder';
  }

  if (/^Confirmed the commitment/i.test(action)) return 'Confirmed commitment';
  if (/^Marked the reminder as acknowledged/i.test(action)) return 'Acknowledged reminder';
  if (/^Marked the commitment complete/i.test(action)) return 'Marked complete';
  if (/^Postponed the commitment/i.test(action)) return 'Postponed';
  if (/^Dropped the commitment/i.test(action)) return 'Dropped';
  if (/^Delivered a reminder/i.test(action)) return 'Delivered reminder';
  if (/^Marked a reminder as ignored/i.test(action)) return 'Marked reminder ignored';
  if (/^Triggered an escalation/i.test(action)) return 'Escalated';

  const cleaned = stripPeriod(action);
  return cleaned || null;
}

export function compressActions(actions: readonly string[]): string[] {
  const compressed = actions
    .map(compressAction)
    .filter((action): action is string => Boolean(action));

  const hasDraft = compressed.find((action) => action.startsWith('Drafted '));
  const hasScheduled = compressed.includes('Confirmed and scheduled reminder');
  if (hasDraft && hasScheduled) {
    const merged = `${hasDraft}; confirmed and scheduled reminder`;
    return [
      merged,
      ...compressed.filter((action) => action !== hasDraft && action !== 'Confirmed and scheduled reminder'),
    ].slice(0, 2);
  }

  return Array.from(new Set(compressed)).slice(0, 2);
}

function compressNextStep(nextStep: ResponseFormatterNextStep): ResponseFormatterNextStep {
  if (!nextStep.message) return nextStep;
  return {
    type: nextStep.type,
    message: compressInterpretation(nextStep.message),
  };
}

export function compressResponse(response: FormattedResponse): FormattedResponse {
  return {
    message: withTerminalPunctuation(response.message),
    interpretation: compressInterpretation(response.interpretation),
    actions: compressActions(response.actions),
    nextStep: compressNextStep(response.nextStep),
  };
}
