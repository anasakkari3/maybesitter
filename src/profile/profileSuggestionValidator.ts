/**
 * What survives between the model and the user's screen (UC-2.7b, #168).
 *
 * ── Every rule here is a drop, never a fix ───────────────────────
 *
 * Nothing is clamped, truncated or coerced. A confidence of 1.4 is not read as
 * 1, and an 81-character suggestion is not shortened to 80. The reason is the
 * same in both cases: the output is a *claim about a person*, and a claim that
 * arrived malformed is a claim this code has no basis to repair. Repairing it
 * would mean showing somebody a sentence about themselves that neither they
 * nor the model actually produced.
 *
 * ── The sensitive filter runs last and runs on everything ────────
 *
 * Including on content the model got right in every other respect, and
 * including on the categories the schema does not have a slot for. The prompt
 * asks; this refuses. A product that writes down "has ADHD, takes Ritalin"
 * because the prompt was ignored once has done the harm regardless of whose
 * fault it was.
 *
 * ── Counts, never content ────────────────────────────────────────
 *
 * The outcome reports how many fell to each reason and nothing else. A log
 * line naming the dropped suggestion would put the exact sentence this filter
 * exists to discard into the place logs go.
 */
import {
  MAX_PROFILE_SUGGESTIONS,
  MAX_SUGGESTION_LENGTH,
  MIN_SUGGESTION_CONFIDENCE,
  SUGGESTION_CATEGORIES,
  SUGGESTION_KINDS,
  type DropReason,
  type ProfileSuggestion,
  type SuggestionCategory,
  type SuggestionKind,
  type ValidationOutcome,
} from './profileContracts';
import { isSensitive } from './sensitiveLexicon';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface ValidateOptions {
  /** Today, in UTC. A target date before this is dropped. */
  readonly now: Date;
}

export function validateProfileSuggestions(raw: unknown, options: ValidateOptions): ValidationOutcome {
  const dropped: Partial<Record<DropReason, number>> = {};
  const drop = (reason: DropReason) => { dropped[reason] = (dropped[reason] ?? 0) + 1; };

  const items = Array.isArray(raw) ? raw : [];
  const kept: ProfileSuggestion[] = [];

  for (const item of items) {
    if (kept.length >= MAX_PROFILE_SUGGESTIONS) {
      drop('over_limit');
      continue;
    }
    const suggestion = validateOne(item, options, drop);
    if (suggestion) kept.push(suggestion);
  }

  return { suggestions: Object.freeze(kept), dropped: Object.freeze(dropped) };
}

function validateOne(
  raw: unknown,
  options: ValidateOptions,
  drop: (reason: DropReason) => void,
): ProfileSuggestion | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    drop('unknown_kind');
    return null;
  }
  const item = raw as Record<string, unknown>;

  if (!SUGGESTION_KINDS.includes(item.kind as SuggestionKind)) {
    drop('unknown_kind');
    return null;
  }
  if (!SUGGESTION_CATEGORIES.includes(item.category as SuggestionCategory)) {
    drop('unknown_category');
    return null;
  }

  const content = typeof item.content === 'string' ? item.content.trim() : '';
  if (content === '') {
    drop('empty_content');
    return null;
  }
  // Code points, so a suggestion in Arabic gets the same allowance as one in
  // English rather than half of it.
  if (Array.from(content).length > MAX_SUGGESTION_LENGTH) {
    drop('too_long');
    return null;
  }

  const confidence = item.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    drop('bad_confidence');
    return null;
  }
  if (confidence < MIN_SUGGESTION_CONFIDENCE) {
    drop('low_confidence');
    return null;
  }

  const targetDate = validateTargetDate(item.targetDate, options, drop);
  if (targetDate === undefined) return null;

  // Last, and on the finished content — including on an edit the model made to
  // a phrase that started out clean.
  if (isSensitive(content)) {
    drop('sensitive');
    return null;
  }

  return Object.freeze({
    kind: item.kind as SuggestionKind,
    category: item.category as SuggestionCategory,
    content,
    targetDate,
    confidence,
  });
}

/** `undefined` means the whole suggestion is dropped; `null` means no date. */
function validateTargetDate(
  raw: unknown,
  options: ValidateOptions,
  drop: (reason: DropReason) => void,
): string | null | undefined {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string' || !ISO_DATE.test(raw)) {
    drop('bad_target_date');
    return undefined;
  }
  const parsed = Date.parse(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) {
    drop('bad_target_date');
    return undefined;
  }
  // A goal whose date has passed is not a goal, and re-dating it would be this
  // code deciding when somebody meant. The whole suggestion goes.
  const today = Date.parse(`${options.now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  if (parsed < today) {
    drop('past_target_date');
    return undefined;
  }
  return raw;
}
