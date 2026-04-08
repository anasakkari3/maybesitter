/**
 * Schema validator for LLM-produced ExtractionResult JSON.
 *
 * Responsibilities:
 *  - Coerce and normalise fields into the ExtractionResult shape
 *  - Filter ambiguityFlags / missingFields to known enum values
 *  - Enforce safety rules (negation caps confidence)
 *  - Stamp parserVersion: 'ollama-v1'
 *  - Throw ValidationError when the payload is structurally unrecoverable
 */

import type {
  AmbiguityFlag,
  ExtractionResult,
  ExtractionType,
  MissingField,
} from './extractionTypes';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const PARSER_VERSION = 'ollama-v1';

const VALID_TYPES = new Set<ExtractionType>(['task', 'follow_up', 'informational_context', 'unknown']);
const VALID_AMBIGUITY_FLAGS = new Set<AmbiguityFlag>([
  'multiple_commitments',
  'vague_time',
  'vague_action',
  'weak_commitment_language',
  'informational_without_action',
  'contradictory_time',
  'negated_request',
]);
const VALID_MISSING_FIELDS = new Set<MissingField>(['action', 'time', 'person', 'commitment_strength']);

function clamp(value: unknown, min = 0, max = 1): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length === 0 ? null : s;
}

function isoStringOrNull(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (s.length === 0) return null;
  const ts = Date.parse(s);
  if (isNaN(ts)) throw new ValidationError(`${field} must be a valid date`);
  return new Date(ts).toISOString();
}

function boolOrDefault(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate and normalise raw JSON (already parsed) from the LLM into a well-typed ExtractionResult.
 *
 * @param raw     - The parsed JSON object from the LLM response
 * @param rawText - The original user input (stamped into the result)
 *
 * @throws {ValidationError} when `type` is missing or unrecognisable
 */
export function validateExtractionResult(raw: unknown, rawText: string): ExtractionResult {
  if (!isRecord(raw)) {
    throw new ValidationError('LLM output is not a JSON object');
  }
  const lowerRawText = rawText.toLowerCase();
  const rawTextHasNegatedReminder =
    /\b(don't|dont|do not|not)\s+(remind|remember|bug)\b/.test(lowerRawText) ||
    /\b(remind me|remember to|bug me)\s+not\b/.test(lowerRawText);

  // ── type ─────────────────────────────────────────────────────────────────
  const type = stringOrNull(raw['type']) as ExtractionType | null;
  if (!type || !VALID_TYPES.has(type)) {
    throw new ValidationError(`Invalid or missing extraction type: ${JSON.stringify(raw['type'])}`);
  }

  // ── ambiguityFlags / missingFields ─────────────────────────────────────
  const ambiguityFlags = (Array.isArray(raw['ambiguityFlags']) ? raw['ambiguityFlags'] : [])
    .map((f: unknown) => stringOrNull(f))
    .filter((f): f is AmbiguityFlag => f !== null && VALID_AMBIGUITY_FLAGS.has(f as AmbiguityFlag));
  if (rawTextHasNegatedReminder && !ambiguityFlags.includes('negated_request')) {
    ambiguityFlags.push('negated_request');
  }

  const missingFields = (Array.isArray(raw['missingFields']) ? raw['missingFields'] : [])
    .map((f: unknown) => stringOrNull(f))
    .filter((f): f is MissingField => f !== null && VALID_MISSING_FIELDS.has(f as MissingField));

  // ── confidence ────────────────────────────────────────────────────────
  const rawConf = isRecord(raw['confidence']) ? raw['confidence'] : {};
  let overallConfidence = clamp(rawConf['overall']);

  // Safety rule: negated requests must never auto-confirm
  if (ambiguityFlags.includes('negated_request')) {
    overallConfidence = Math.min(overallConfidence, 0.55);
  }

  const confidence: ExtractionResult['confidence'] = {
    overall: overallConfidence,
    type: clamp(rawConf['type']),
    action: clamp(rawConf['action']),
    time: clamp(rawConf['time']),
    priority: clamp(rawConf['priority']),
  };

  // ── priority ──────────────────────────────────────────────────────────
  const rawPriority = isRecord(raw['priority']) ? raw['priority'] : {};
  const priorityLevelRaw = stringOrNull(rawPriority['level']);
  const priorityLevel = (priorityLevelRaw === 'low' || priorityLevelRaw === 'high')
    ? priorityLevelRaw
    : 'normal';
  const prioritySourceRaw = stringOrNull(rawPriority['source']);
  const prioritySource = (prioritySourceRaw === 'inferred' || prioritySourceRaw === 'user_explicit')
    ? prioritySourceRaw
    : 'default';

  const priority: ExtractionResult['priority'] = {
    level: priorityLevel,
    source: prioritySource,
    pressureAllowed: false,
    pressureImplied: boolOrDefault(rawPriority['pressureImplied'], false),
  };

  // ── flexibility ───────────────────────────────────────────────────────
  const flexibility: ExtractionResult['flexibility'] =
    raw['flexibility'] === 'soft' ? 'soft' : 'movable';

  // ── assemble ──────────────────────────────────────────────────────────
  return {
    type,
    action: stringOrNull(raw['action']),
    title: stringOrNull(raw['title']),
    person: stringOrNull(raw['person']),
    dueAt: isoStringOrNull(raw['dueAt'], 'dueAt'),
    remindAt: isoStringOrNull(raw['remindAt'], 'remindAt'),
    priority,
    flexibility,
    confidence,
    missingFields,
    ambiguityFlags,
    explicitReminderRequest: rawTextHasNegatedReminder ? false : boolOrDefault(raw['explicitReminderRequest'], false),
    explicitPressureRequest: boolOrDefault(raw['explicitPressureRequest'], false),
    rawText,
    parserVersion: PARSER_VERSION,
  };
}
