/**
 * Which setup questions an import has already answered.
 *
 * ── The over-reach this file exists to prevent ───────────────────
 *
 * The obvious design maps every category to a question and skips whatever gets
 * enough hits. Under it, three `work_study` facts — "is a nursing student",
 * "works part time", "has a shift on Thursdays" — would count as an answer to
 * "tell me about your life", and the one screen where somebody says what they
 * are actually trying to do would never appear. Knowing *what* a person does is
 * not knowing what they are working towards.
 *
 * So `life` is never dropped by a category count. It has two modes and no third:
 * the full narrative, or a short "anything else we should know?" once the import
 * covered a lot. The floor is one screen, always.
 */
import { describe, expect, it } from '@jest/globals';
import {
  CATEGORY_QUESTION,
  LIFE_BRIEF_THRESHOLD,
  SHORT_QUESTION_THRESHOLD,
  answeredQuestions,
  lifeMode,
  remainingQuestions,
} from '../setupGaps';
import { SETUP_QUESTIONS } from '../setupChat';
import type { SuggestionCategory } from '../../../api/schemas/profile';

function many(category: SuggestionCategory, n: number): SuggestionCategory[] {
  return Array.from({ length: n }, () => category);
}

const EVERYTHING: SuggestionCategory[] = [
  ...many('work_study', 4), ...many('learning', 4), ...many('schedule', 4),
  ...many('household', 4), ...many('personal_project', 4), ...many('fitness_habit', 4),
  ...many('social', 4), ...many('other', 4),
];

describe('the narrative is never skipped', () => {
  it('survives an import that covered every category heavily', () => {
    const left = remainingQuestions(EVERYTHING).map((question) => question.id);
    expect(left).toContain('life');
  });

  it('survives an import that only talked about work and study', () => {
    // The tempting mapping, and the reason it is refused: eight facts about
    // somebody's job and courses answer none of the five questions. Every one
    // of them is still asked — the narrative briefly, since the assistant
    // clearly knew this person, and all four short ones in full.
    const left = remainingQuestions([...many('work_study', 4), ...many('learning', 4)]);
    expect(left.map((question) => question.id)).toEqual(['life', 'day', 'places', 'done', 'habits']);
    expect(left[0]!.kind).toBe('short');
  });

  it('is always the first thing asked', () => {
    expect(remainingQuestions(EVERYTHING)[0]!.id).toBe('life');
    expect(remainingQuestions([])[0]!.id).toBe('life');
  });

  it('goes brief, not away, once the import covered a lot', () => {
    const brief = remainingQuestions(EVERYTHING)[0]!;
    expect(brief.id).toBe('life');
    expect(brief.kind).toBe('short');
    expect(brief.promptKey).toBe('obSetupAnythingElse');
  });

  it('stays the full narrative below the threshold', () => {
    const few = many('schedule', LIFE_BRIEF_THRESHOLD - 1);
    expect(remainingQuestions(few)[0]!.kind).toBe('narrative');
    expect(lifeMode(few.length)).toBe('full');
  });

  it('turns brief exactly at the threshold', () => {
    expect(lifeMode(LIFE_BRIEF_THRESHOLD - 1)).toBe('full');
    expect(lifeMode(LIFE_BRIEF_THRESHOLD)).toBe('brief');
  });
});

describe('the short questions', () => {
  it('are skipped once enough candidates map to them', () => {
    const covered = answeredQuestions(many('schedule', SHORT_QUESTION_THRESHOLD));
    expect(covered.has('day')).toBe(true);
  });

  it('survive one lonely candidate', () => {
    expect(answeredQuestions(many('schedule', SHORT_QUESTION_THRESHOLD - 1)).has('day')).toBe(false);
  });

  it('drop out of the remaining list when covered', () => {
    const left = remainingQuestions(many('schedule', SHORT_QUESTION_THRESHOLD)).map((q) => q.id);
    expect(left).not.toContain('day');
    expect(left).toContain('places');
  });
});

describe('categories that answer nothing', () => {
  it('never skip a question', () => {
    for (const category of ['work_study', 'learning', 'social', 'other'] as SuggestionCategory[]) {
      expect(CATEGORY_QUESTION[category]).toBeNull();
      expect(answeredQuestions(many(category, 20)).size).toBe(0);
    }
  });
});

describe('the mapping itself', () => {
  it('names every category the API can send', () => {
    const categories: SuggestionCategory[] = [
      'work_study', 'schedule', 'household', 'social',
      'fitness_habit', 'learning', 'personal_project', 'other',
    ];
    for (const category of categories) expect(category in CATEGORY_QUESTION).toBe(true);
  });

  it('never maps anything onto the narrative', () => {
    // If it did, the count would be able to skip it after all.
    expect(Object.values(CATEGORY_QUESTION)).not.toContain('life');
  });

  it('only names questions that exist', () => {
    const ids = new Set(SETUP_QUESTIONS.map((question) => question.id));
    for (const target of Object.values(CATEGORY_QUESTION)) {
      if (target !== null) expect(ids.has(target)).toBe(true);
    }
  });
});

describe('with no import at all', () => {
  it('asks everything, in the original order', () => {
    expect(remainingQuestions([])).toEqual(SETUP_QUESTIONS);
  });
});
