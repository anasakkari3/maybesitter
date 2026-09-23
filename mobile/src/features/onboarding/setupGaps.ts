/**
 * Which setup questions an import has already answered.
 *
 * ── Beside `setupChat`, not inside it ────────────────────────────
 *
 * That file is the questions and their caps. This is a mapping from a different
 * feature's taxonomy onto them, and it is the part most likely to be wrong —
 * worth being able to read, and to change, on its own.
 *
 * ── Why the narrative is never skipped ───────────────────────────
 *
 * The obvious design maps every category to a question and skips whatever gets
 * enough hits. Under it, three `work_study` candidates — "is a nursing
 * student", "works part time", "has a shift on Thursdays" — would count as an
 * answer to "tell me about your life", and the one screen where somebody says
 * what they are actually trying to do would never appear. Knowing *what* a
 * person does is not knowing what they are working towards, and a tally cannot
 * tell the two apart.
 *
 * So `work_study` and `learning` map to nothing. They inform the narrative;
 * they do not answer it. And `life` has two modes and no third: the full
 * narrative, or a short "anything else we should know?" once the import covered
 * a lot. The floor is one screen, always — a setup chat with nothing in it is
 * not an outcome, and the user should get somewhere to put whatever the import
 * missed.
 *
 * If this ever needs to be smarter, the honest way is a `coversQuestionIds`
 * field on the candidate — the model saying what it answered — not a richer
 * count. A count is this module guessing.
 */
import type { SuggestionCategory } from '../../api/schemas/profile';
import { SETUP_QUESTIONS, type SetupQuestion, type SetupQuestionId } from './setupChat';

/**
 * Which short question a category stands in for, or `null` for none.
 *
 * `social` and `other` are null because no question asks them: letting them
 * skip something would be a candidate about a person's friends removing the
 * question about where their day happens.
 */
export const CATEGORY_QUESTION: Record<SuggestionCategory, SetupQuestionId | null> = {
  schedule: 'day',
  household: 'places',
  personal_project: 'done',
  fitness_habit: 'habits',
  work_study: null,
  learning: null,
  social: null,
  other: null,
};

/**
 * Two candidates mapped to a short question stand in for it.
 *
 * One is a coincidence — a single sentence mentioning an evening does not
 * describe a day.
 */
export const SHORT_QUESTION_THRESHOLD = 2;

/**
 * At this many confirmed candidates the narrative goes brief.
 *
 * Six is "the assistant actually knew this person", as opposed to a thin
 * profile that happened to hit two categories.
 */
export const LIFE_BRIEF_THRESHOLD = 6;

function questionById(id: SetupQuestionId): SetupQuestion {
  return SETUP_QUESTIONS.find((question) => question.id === id)!;
}

/**
 * The narrative, shortened.
 *
 * `kind: 'short'` is not cosmetic: `answerCap` switches on it, so the brief
 * version picks up the 150-character allowance instead of 600 without anything
 * else having to know. The id is unchanged, so the same screen renders it and
 * the answer lands in the same place.
 */
export const LIFE_BRIEF: SetupQuestion = {
  ...questionById('life'),
  kind: 'short',
  promptKey: 'obSetupAnythingElse',
  // No inspiration chips on a closing question: they belong to the open one.
  chipKeys: [],
};

export function lifeMode(candidateCount: number): 'full' | 'brief' {
  return candidateCount >= LIFE_BRIEF_THRESHOLD ? 'brief' : 'full';
}

/** The short questions the import has covered. Never includes `life`. */
export function answeredQuestions(
  categories: readonly SuggestionCategory[],
): ReadonlySet<SetupQuestionId> {
  const hits = new Map<SetupQuestionId, number>();
  for (const category of categories) {
    const target = CATEGORY_QUESTION[category];
    if (!target) continue;
    hits.set(target, (hits.get(target) ?? 0) + 1);
  }

  const covered = new Set<SetupQuestionId>();
  for (const [id, count] of hits) {
    if (count >= SHORT_QUESTION_THRESHOLD) covered.add(id);
  }
  return covered;
}

/**
 * What is still worth asking, in the original order, narrative first.
 *
 * An empty `categories` means no import happened, and the answer is every
 * question exactly as it was — the same array, so nothing downstream can tell
 * the difference.
 */
export function remainingQuestions(
  categories: readonly SuggestionCategory[],
): readonly SetupQuestion[] {
  if (categories.length === 0) return SETUP_QUESTIONS;

  const covered = answeredQuestions(categories);
  const life = lifeMode(categories.length) === 'brief' ? LIFE_BRIEF : questionById('life');

  return [
    life,
    ...SETUP_QUESTIONS.filter((question) => question.id !== 'life' && !covered.has(question.id)),
  ];
}
