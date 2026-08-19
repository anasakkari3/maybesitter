/**
 * The one set of size limits, and the one rule for whether an identifier is
 * safe to name in a message.
 *
 * These were written twice, independently, because two tracks each needed them
 * and neither could see the other. They came out different every time:
 *
 *   spans per step   engine 20    evaluator 64
 *   total spans      engine 500   evaluator 512
 *   steps            engine 200   evaluator 128
 *   nameable id      ≤32 chars, ≤2 runs            ≤28 chars, ≤4 runs, ≤8 digits
 *
 * That is the third time this sprint that *data* — as opposed to judgement —
 * was duplicated and drifted. The connective lexicon was the first, and the
 * lesson was already paid for: two independent implementations of a *decision*
 * are a check on each other; two independent copies of a *number* are a bug
 * waiting for whichever caller hits the gap between them. A proposal that the
 * engine refuses at 21 spans and the evaluator accepts to 64 is scored by the
 * evaluator on inputs the engine can never produce.
 *
 * Each limit below takes the stricter of the two, and the nameable-id rule
 * takes the union of both sets of constraints, for the same reason: whichever
 * side was more cautious had a case in mind, and no case was made for the
 * looser bound. The one exception is the separator-run bound, which is a real
 * difference between machine-minted and human-written ids rather than a
 * disagreement — so it is a declared parameter rather than a silent split.
 */

/* ── Proposal shape ──────────────────────────────────────────────── */

/**
 * Steps in one proposal.
 *
 * 128 rather than 200. Nothing about a commitment a person spoke produces a
 * hundred steps; the bound exists so an untrusted provider cannot make the
 * validator's pairwise passes expensive, and the tighter of the two does that
 * better.
 */
export const MAX_STEPS_PER_PROPOSAL = 128;

/**
 * Spans on a single step.
 *
 * 20 rather than 64. A step is stated across discontinuous parts of *one
 * sentence*; twenty fragments is already far past anything the golden set or a
 * real utterance contains, and the overlap pass is pairwise in this number.
 */
export const MAX_SPANS_PER_STEP = 20;

/** Spans across a whole proposal. 500 rather than 512 — the round number was arbitrary either way. */
export const MAX_TOTAL_SPANS = 500;

/** Dependency edges leaving one step. */
export const MAX_EDGES_PER_STEP = 50;

/* ── Text ────────────────────────────────────────────────────────── */

/** Source commitment text the boundary will read at all. */
export const MAX_SOURCE_TEXT_LENGTH = 10_000;

/** A title, stated timing or stated owner in a provider's draft. */
export const MAX_DRAFT_TEXT_LENGTH = 1_000;

/** A title a user typed when editing a proposed step. */
export const MAX_EDITED_TITLE_LENGTH = 500;

/* ── Reporting ───────────────────────────────────────────────────── */

/** Violations a single validation run will return before it stops adding. */
export const MAX_VIOLATIONS = 200;

/** Total `detail` bytes a single validation run will return. */
export const MAX_VIOLATION_DETAIL_TOTAL = 20_000;

/** Ids a proposal-level `detail` names before it starts counting instead. */
export const MAX_NAMED_IDS_IN_DETAIL = 8;

/* ── Naming an identifier in a message ───────────────────────────── */

/**
 * Whether an identifier may be repeated verbatim in a violation `detail`.
 *
 * The contract says `detail` never contains raw user text. A provider chooses
 * step ids and a corpus author chooses example ids, so both are as untrusted as
 * the commitment itself — and a character-class test alone is not enough: a
 * sentence written with hyphens for spaces
 * (`Tell-my-therapist-I-relapsed-on-Tuesday`) passed one earlier version of
 * this check, and `card_4111111111111111_cvv_123` passed another.
 *
 * Three bounds, because each catches what the others miss, and every one of
 * them was found by a payload that walked past the rest:
 *
 *  - **28 code units.** Long enough for any id in this repository — the longest
 *    is `seed-he-nosplit-procedures` at 26 — short enough that a sentence does
 *    not fit.
 *  - **Separator runs**, bounded per origin. See below: this is the one bound
 *    the two callers genuinely need different values for.
 *  - **8 digits total.** A card number written `4111-1111-1111-1111` has no run
 *    longer than four, so a run-length bound misses it while a total does not.
 *
 * This is a heuristic and is documented as one. The guarantee is not that it
 * classifies every string correctly — it is that a rejected id is reported by
 * *position* instead, which locates the thing just as well and carries nothing.
 */
const NAMEABLE_ID = /^[A-Za-z0-9_.:-]+$/;
const SEPARATOR_RUN = /[_.:-]+/g;
const DIGIT = /[0-9]/g;

/**
 * How many separator runs an identifier of a given origin may carry.
 *
 * This is the one place the two callers genuinely differ, and the difference is
 * a fact about the ids, not a disagreement about the rule. An engine mints
 * `s1`, `step_3`, `p_12:s4` — two runs is already generous. A corpus author
 * writes `seed-ar-en-multi-invoice`, which is four, and rejecting those makes
 * every dataset diagnostic positional and unreadable.
 *
 * Stated as a parameter rather than reimplemented per caller, because a
 * parameter is one rule with a declared difference and a second copy is two
 * rules with an undeclared one. That distinction is what this file exists for.
 *
 * Note what the looser bound costs, plainly: at four runs the check cannot
 * separate `seed-ar-en-multi-invoice` from `Tell-my-doctor-I-relapsed`. They
 * are structurally the same string. No heuristic separates them, which is why
 * the guarantee has never been the heuristic — it is that a rejected id is
 * reported by *position*, which locates the thing just as well and carries
 * nothing. The bounds only buy readability back for the ordinary case.
 */
export const ENGINE_ID_SEPARATOR_RUNS = 2;
export const CORPUS_ID_SEPARATOR_RUNS = 4;

export function isNameableId(value: unknown, maxSeparatorRuns: number = ENGINE_ID_SEPARATOR_RUNS): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.length > 28) return false;
  if (!NAMEABLE_ID.test(value)) return false;
  if ((value.match(SEPARATOR_RUN) ?? []).length > maxSeparatorRuns) return false;
  return (value.match(DIGIT) ?? []).length <= 8;
}
