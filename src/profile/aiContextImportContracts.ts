/**
 * What another company's assistant may propose about somebody, and what
 * survives validation (AI Context Import).
 *
 * ── A candidate is not a fact, and a link is not a decision ──────
 *
 * Nothing here is stored. These are proposals held for thirty minutes while
 * the user looks at them, and only the ones they keep become memory records —
 * the same rule `profileContracts` states, for the same reason. This file is a
 * sibling of that one rather than an extension of it: the describe endpoint is
 * calibrated for a thousand characters somebody typed with their thumbs, and
 * widening its constants to fit a machine-written profile would change a
 * shipped, tested path to serve a new one.
 *
 * What is genuinely new here is `relation`. A candidate may say it updates or
 * contradicts something the account already remembers. That is a claim by a
 * model about the user's own confirmed history, so it is carried as an opaque
 * index the server resolves, never as an id the model was shown, and never as
 * an instruction to overwrite anything.
 */
import type { DropReason, SuggestionCategory, SuggestionKind } from './profileContracts';

/**
 * The most pasted text the endpoint will read. Never stored.
 *
 * Four times `MAX_DESCRIPTION_LENGTH`, and not a round number chosen for
 * comfort: `MAX_INPUT_CHARACTERS` is 20,000 against the whole built prompt, so
 * after the rule block, forty numbered records at 200 code points each and the
 * framing, this is what is left with room to spare. `aiContextImportContracts`
 * test proves the sum rather than trusting this sentence.
 */
export const MAX_IMPORT_LENGTH = 4_000;

/**
 * The most existing records the model is shown, newest-observed first.
 *
 * Forty covers three imports' worth plus a routine survey and manual entries,
 * and is the largest number the input ceiling permits while leaving room for a
 * generous paste. Above it the list is truncated and says so — see
 * `existingTruncated`, which exists so that truncation is a fact the user is
 * told rather than a silent change in behaviour.
 */
export const MAX_EXISTING_MEMORY_RECORDS = 40;

export const AI_CONTEXT_IMPORT_PROMPT_VERSION = 'ai-context-import-v1';

/**
 * Same thirty minutes as a describe proposal, and additionally because the
 * snapshot of existing memory inside it ages: after half an hour the records
 * it names may no longer be what the account remembers.
 */
export const AI_CONTEXT_IMPORT_TTL_MS = 30 * 60 * 1_000;

/** A structured profile yields more distinct statements than one paragraph. */
export const MAX_IMPORT_CANDIDATES = 18;

/**
 * Longer than a describe suggestion's 80 — an assistant writes fuller
 * sentences — and well under `MAX_MEMORY_CONTENT_LENGTH`, so nothing
 * downstream ever has to truncate a claim about a person.
 */
export const MAX_CANDIDATE_LENGTH = 120;

/** Below this the model is guessing, and a guess about a person is not kept. */
export const MIN_CANDIDATE_CONFIDENCE = 0.6;

/**
 * An import is a bootstrap, not a habit. "Tried ChatGPT, then Claude, then
 * fixed a bad paste" is three, and a fourth in one day is a loop rather than a
 * person.
 */
export const MAX_IMPORTS_PER_DAY = 3;

/**
 * A closed union that is expected to grow — a later deep import adds
 * `'chatgpt_export'`. It is validated against `IMPORT_ASSISTANTS` in one place
 * per tier and never switched on, so growing it stays a one-line change.
 */
export type ImportAssistant = 'chatgpt' | 'gemini' | 'claude' | 'other';

export const IMPORT_ASSISTANTS: readonly ImportAssistant[] = ['chatgpt', 'gemini', 'claude', 'other'];

export function isImportAssistant(value: unknown): value is ImportAssistant {
  return typeof value === 'string' && (IMPORT_ASSISTANTS as readonly string[]).includes(value);
}

/**
 * What a candidate says about the account's existing memory.
 *
 * `conflict` is deliberately not "the new one wins". It is the model saying
 * two things cannot both be true and declining to choose, which is the only
 * honest thing it can do about a fact a human already confirmed.
 */
export type CandidateRelation = 'new' | 'update' | 'conflict';

export const CANDIDATE_RELATIONS: readonly CandidateRelation[] = ['new', 'update', 'conflict'];

/** What the model returns. `relatesTo` is a 1-based index, never an id. */
export interface RawImportCandidate {
  readonly kind: SuggestionKind;
  readonly category: SuggestionCategory;
  /** In the user's own language, third person, neutral. */
  readonly content: string;
  /** `YYYY-MM-DD`, and only when the assistant stated one. */
  readonly targetDate: string | null;
  readonly confidence: number;
  readonly relation: CandidateRelation;
  readonly relatesTo: number | null;
}

/** What the client gets: the index resolved to an id it already holds. */
export interface ImportCandidate extends Omit<RawImportCandidate, 'relatesTo'> {
  readonly relatesToId: string | null;
}

/**
 * Why a candidate was dropped or demoted. Counted, never attached to content.
 *
 * The two `relation` entries that do not drop are the point: a wrong link is
 * not a wrong claim. A candidate whose `relatesTo` cannot be resolved still
 * says something true about the person, so it is demoted to `new` and kept.
 */
export type ImportDropReason =
  | DropReason
  | 'unknown_relation'
  | 'unresolvable_relation'
  | 'spurious_relation'
  | 'duplicate_of_existing'
  | 'duplicate_candidate';

export interface ImportValidationOutcome {
  readonly candidates: readonly RawImportCandidate[];
  readonly dropped: Readonly<Partial<Record<ImportDropReason, number>>>;
}

export interface ImportSummary {
  readonly new: number;
  readonly updates: number;
  readonly conflicts: number;
}

/** What the import endpoint answers with. The pasted text is not in it. */
export interface AiContextImportProposal {
  readonly proposalId: string;
  readonly assistant: ImportAssistant;
  readonly candidates: readonly ImportCandidate[];
  readonly summary: ImportSummary;
  /** How many records the model was actually shown. */
  readonly existingConsidered: number;
  /** How many the account has. Larger than the above means truncation. */
  readonly existingTotal: number;
  readonly existingTruncated: boolean;
  readonly createdAt: string;
  readonly promptVersion: string;
  readonly model: string | null;
}
