/**
 * What survives between another assistant's profile and the user's screen.
 *
 * ── A sibling of `profileSuggestionValidator`, not a widening of it ──
 *
 * That function reads its caps from module constants, and parameterising them
 * would change the behaviour of a shipped, tested endpoint to serve a new one.
 * The discipline is copied instead: every rule is a drop, nothing is clamped or
 * truncated or coerced, and the sensitive filter runs last on the finished
 * content. A claim that arrived malformed is a claim this code has no basis to
 * repair, because repairing it means showing somebody a sentence about
 * themselves that neither they nor the model produced.
 *
 * ── Except for `relation`, where a drop would be the wrong answer ──
 *
 * "This updates item 41" when forty were shown is a bad citation attached to a
 * claim that may be perfectly true. Throwing the claim away to punish the
 * citation loses something real; so the relation is demoted to `new`, the
 * candidate is kept, and the counter records that it happened. Out-of-range is
 * never clamped to the last record — clamping would quietly supersede whichever
 * memory happened to be fortieth.
 *
 * ── The first content dedup in this repo ─────────────────────────
 *
 * Deliberately exact-match-only, after normalising case, spacing and trailing
 * punctuation. Fuzzy matching here would be this code deciding that two
 * sentences about a person mean the same thing, which is precisely the judgement
 * it is not entitled to make. A near-duplicate reaches the user as an `update`
 * candidate instead, where they can see both and choose.
 *
 * ── Counts, never content ────────────────────────────────────────
 *
 * A log line naming a dropped candidate would put the exact sentence this
 * filter exists to discard into the place logs go.
 */
import {
  CANDIDATE_RELATIONS,
  MAX_CANDIDATE_LENGTH,
  MAX_IMPORT_CANDIDATES,
  MIN_CANDIDATE_CONFIDENCE,
  type CandidateRelation,
  type ImportDropReason,
  type ImportValidationOutcome,
  type RawImportCandidate,
} from './aiContextImportContracts';
import { SUGGESTION_CATEGORIES, SUGGESTION_KINDS, type SuggestionCategory, type SuggestionKind } from './profileContracts';
import { isSensitive } from './sensitiveLexicon';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface ValidateImportOptions {
  /** Today, in UTC. A target date before this is dropped. */
  readonly now: Date;
  /** How many records the model was shown, so an index can be range-checked. */
  readonly existingCount: number;
  /** Normalised content of every active record, so a duplicate never lands twice. */
  readonly existingContents: ReadonlySet<string>;
}

/**
 * The comparison key for "the account already says this".
 *
 * NFC first so an Arabic or Hebrew string that differs only in composition
 * compares equal, then case, then spacing, then trailing punctuation — the four
 * ways the same sentence comes back looking different from two models.
 */
export function normalizeForComparison(content: string): string {
  return content
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:!?،؛…]+$/g, '')
    .trim();
}

export function validateImportCandidates(
  raw: unknown,
  options: ValidateImportOptions,
): ImportValidationOutcome {
  const dropped: Partial<Record<ImportDropReason, number>> = {};
  const drop = (reason: ImportDropReason) => { dropped[reason] = (dropped[reason] ?? 0) + 1; };

  const items = readCandidates(raw);
  const kept: RawImportCandidate[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    if (kept.length >= MAX_IMPORT_CANDIDATES) {
      drop('over_limit');
      continue;
    }
    const candidate = validateOne(item, options, drop);
    if (!candidate) continue;

    const key = normalizeForComparison(candidate.content);
    if (options.existingContents.has(key)) {
      drop('duplicate_of_existing');
      continue;
    }
    if (seen.has(key)) {
      drop('duplicate_candidate');
      continue;
    }
    seen.add(key);
    kept.push(candidate);
  }

  return { candidates: Object.freeze(kept), dropped: Object.freeze(dropped) };
}

/** A response that is not `{ candidates: [...] }` yields nothing, never a throw. */
function readCandidates(raw: unknown): readonly unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];
  const candidates = (raw as Record<string, unknown>).candidates;
  return Array.isArray(candidates) ? candidates : [];
}

function validateOne(
  raw: unknown,
  options: ValidateImportOptions,
  drop: (reason: ImportDropReason) => void,
): RawImportCandidate | null {
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
  // Code points, so a candidate in Arabic gets the same allowance as one in
  // English rather than half of it.
  if (Array.from(content).length > MAX_CANDIDATE_LENGTH) {
    drop('too_long');
    return null;
  }

  const confidence = item.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    drop('bad_confidence');
    return null;
  }
  if (confidence < MIN_CANDIDATE_CONFIDENCE) {
    drop('low_confidence');
    return null;
  }

  const targetDate = validateTargetDate(item.targetDate, options, drop);
  if (targetDate === undefined) return null;

  if (!CANDIDATE_RELATIONS.includes(item.relation as CandidateRelation)) {
    drop('unknown_relation');
    return null;
  }
  const { relation, relatesTo } = resolveRelation(
    item.relation as CandidateRelation,
    item.relatesTo,
    options.existingCount,
    drop,
  );

  // Last, and on the finished content — including on a phrase the model edited
  // into something the schema was happy with.
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
    relation,
    relatesTo,
  });
}

/**
 * The two demotions. Neither loses the candidate, because in both cases what
 * went wrong was the link and not the claim.
 */
function resolveRelation(
  relation: CandidateRelation,
  rawIndex: unknown,
  existingCount: number,
  drop: (reason: ImportDropReason) => void,
): { relation: CandidateRelation; relatesTo: number | null } {
  if (relation === 'new') {
    if (rawIndex !== null && rawIndex !== undefined) drop('spurious_relation');
    return { relation: 'new', relatesTo: null };
  }

  const usable = typeof rawIndex === 'number'
    && Number.isInteger(rawIndex)
    && rawIndex >= 1
    && rawIndex <= existingCount;
  if (!usable) {
    drop('unresolvable_relation');
    return { relation: 'new', relatesTo: null };
  }
  return { relation, relatesTo: rawIndex as number };
}

/** `undefined` means the whole candidate is dropped; `null` means no date. */
function validateTargetDate(
  raw: unknown,
  options: ValidateImportOptions,
  drop: (reason: ImportDropReason) => void,
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
  // code deciding when somebody meant.
  const today = Date.parse(`${options.now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  if (parsed < today) {
    drop('past_target_date');
    return undefined;
  }
  return raw;
}
