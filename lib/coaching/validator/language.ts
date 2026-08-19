/**
 * The language validator (Sprint 09, issue #38).
 *
 * Three checks over the realized prose, all of which are checks on **text**
 * rather than on the adapter that produced it — so they hold equally for the
 * template path and for a model path that does not exist yet:
 *
 *   1. **No forbidden lexicon.** Shame language and internal scaffolding.
 *   2. **No claim of persistence**, and in an acknowledged completion that is
 *      the acceptance criterion `COMPLETION_DESCRIBED_AS_TRACKING` names.
 *   3. **No caller-chosen identifier in prose.**
 *
 * ## How this relates to the shipped `validation.ts`
 *
 * `lib/services/responseEngine/validation.ts` does the same three jobs for the
 * assistant turn. Nothing here imports it. Where the two decide the same thing:
 *
 * - **Same rule, same words: shame.** `COACHING_FORBIDDEN_LANGUAGE.shame` is
 *   the engine's `SHAME_PATTERNS` verbatim. A user reading two surfaces of one
 *   product must not find one of them willing to say "you failed".
 * - **Deliberately stricter: persistence.** The engine's
 *   `CREATION_OR_TRACKING_CLAIM` fires only when
 *   `facts.stateChange === 'completed'`, because outside a completion the
 *   engine genuinely creates reminders and honestly says so. This module writes
 *   nothing (`COACHING_PERSISTENCE_POLICY.describesNoStateChange`), so every
 *   one of those verbs is a false claim here whatever the intent.
 * - **Superset: the surveillance vocabulary.** `logging`, `noting`,
 *   `monitoring`, `watching`, `keeping track`, `following up on`. "Completion
 *   is not described as tracking" is not only about the word `tracking`: "I'll
 *   keep an eye on that" said about something the user just finished is the
 *   same false claim in friendlier words, and it is the sentence a template
 *   author reaches for.
 * - **Same rule: no semicolons.** The engine's structural rule, adopted.
 * - **Deliberately different: sentence counting.** The engine counts terminal
 *   punctuation in one message string. This module's sentences are an array, so
 *   the count is structural — but each *element* is still checked for a single
 *   terminal mark, because a template carrying two sentences would put two
 *   claims' worth of assertion behind one claim's evidence.
 *
 * ## The limitation, stated rather than discovered
 *
 * **The lexicons are English.** An Arabic or Hebrew template that described
 * tracking would pass every check in this file. That is a real gap and it is
 * not closed here: closing it needs per-locale lexicons written by someone who
 * speaks the language, which is #37's evaluation set rather than this track's
 * guesswork — a list of Arabic shame words invented by an English-speaking
 * author is worse than none, because it reads as coverage.
 *
 * What *does* hold in all three locales is the structural guarantee:
 * `COACHING_TEMPLATES` is a closed table with no interpolation, and
 * `tests/coaching/realizer.test.ts` walks every string in it in every locale.
 * So the gap is "a bad translation could be added and this file would not
 * notice", not "user text could flow through". **Revisit when** #37 lands
 * per-locale lexicons; this function takes them as data for that reason.
 */

import {
  COACHING_FORBIDDEN_LANGUAGE,
  isEvidenceBackedClaim,
  type CoachingDefect,
  type CoachingOutput,
} from '../../../src/contracts/v1/coachingContracts';

/**
 * The shortest identifier this scan will look for.
 *
 * Four, and the floor exists because a shorter run cannot be distinguished from
 * ordinary prose: a `commitmentId` of `"one"` would match every sentence in the
 * table. #39 draws the same line at eight for its audit-leak scan
 * (`AUDIT_LEAK_DEFAULT_RUN_LENGTH`) over free-form detail strings; four is
 * right here because the corpus being scanned is a closed template table rather
 * than arbitrary text, so a false positive is caught by a test at build time
 * and never by a user.
 *
 * The floor is the reason this check is a backstop and not the guarantee. The
 * guarantee is that `COACHING_TEMPLATES` interpolates nothing at all.
 */
export const MIN_SCANNED_IDENTIFIER_LENGTH = 4;

/** The lexicons, as data, so a per-locale set can be supplied later. */
export interface CoachingLexicons {
  readonly shame: readonly string[];
  readonly scaffold: readonly string[];
  readonly trackingVerbs: readonly string[];
}

export const DEFAULT_COACHING_LEXICONS: CoachingLexicons = COACHING_FORBIDDEN_LANGUAGE;

function escapeForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether `text` contains `word` as a prefix-anchored token.
 *
 * Anchored on the left with a Unicode-aware non-letter/non-digit boundary and
 * **open on the right**, so `remind` catches `reminder` and `reminding`. A
 * forbidden list should over-catch: a false positive against a closed template
 * table is a test failure someone fixes in one line, and a false negative is a
 * sentence a user reads.
 *
 * The boundary is `\p{L}\p{N}` with the `u` flag rather than `\b`, which is
 * ASCII-only — an English word embedded in Arabic or Hebrew text is exactly the
 * case `\b` gets wrong, and it is the case this module has.
 *
 * A fresh `RegExp` per call, never a shared one. `recommendationContracts`
 * records why `isInstant` is a predicate rather than an exported pattern: a
 * shared `RegExp` is one edit from carrying a `g` flag, and then `lastIndex`
 * persists across unrelated callers and `test` returns alternating answers for
 * the same input.
 */
export function containsToken(text: string, word: string): boolean {
  if (typeof text !== 'string' || typeof word !== 'string' || word.length === 0) return false;
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeForPattern(word)}`, 'iu');
  return pattern.test(text);
}

function terminalMarkCount(text: string): number {
  const matches = text.match(/[.?!](?:\s|$)/g);
  return matches === null ? 0 : matches.length;
}

/**
 * Check the prose.
 *
 * `identifiers` is every caller-chosen free string the recommendation carries —
 * its id, its scope, every `commitmentId`, every `proposalId`, every `nodeId`.
 * Supplied rather than extracted here, because extraction would mean this file
 * walking a `Recommendation`, and the walk would then be a second reader of a
 * shape `lib/recommendation` already owns.
 *
 * Returns findings; it does not throw, for any input.
 */
export function checkCoachingLanguage(
  output: CoachingOutput,
  identifiers: readonly string[],
  lexicons: CoachingLexicons = DEFAULT_COACHING_LEXICONS,
): readonly CoachingDefect[] {
  const defects: CoachingDefect[] = [];
  const safe = output === null || output === undefined ? ({} as CoachingOutput) : output;
  const sentences = Array.isArray(safe.sentences) ? safe.sentences : [];
  const claims = Array.isArray(safe.claims) ? safe.claims : [];

  // Whether this turn acknowledges a completion decides *which* code a
  // persistence verb earns. One condition, two codes: "you finished that, I'm
  // tracking it" and "I saved that for you" are different lies told by
  // different templates and fixed in different places.
  const acknowledgesCompletion = claims.some(
    (claim) => claim !== null && claim !== undefined && !isEvidenceBackedClaim(claim) && claim.kind === 'user_completed',
  );

  for (let index = 0; index < sentences.length; index += 1) {
    const sentence = sentences[index];
    const text = sentence === null || sentence === undefined ? undefined : sentence.text;
    if (typeof text !== 'string' || text.trim().length === 0) continue;

    for (const word of lexicons.shame) {
      if (containsToken(text, word)) {
        defects.push({ code: 'FORBIDDEN_LANGUAGE', claimIndex: null, sentenceIndex: index, detail: 'sentence carries shame language' });
      }
    }
    for (const word of lexicons.scaffold) {
      if (containsToken(text, word)) {
        defects.push({ code: 'FORBIDDEN_LANGUAGE', claimIndex: null, sentenceIndex: index, detail: 'sentence carries internal scaffolding language' });
      }
    }
    for (const word of lexicons.trackingVerbs) {
      if (!containsToken(text, word)) continue;
      defects.push(
        acknowledgesCompletion
          ? {
              code: 'COMPLETION_DESCRIBED_AS_TRACKING',
              claimIndex: null,
              sentenceIndex: index,
              detail: 'a completion is described as something the system created, saved or is tracking',
            }
          : {
              code: 'FORBIDDEN_LANGUAGE',
              claimIndex: null,
              sentenceIndex: index,
              detail: 'sentence claims a write this module never performs',
            },
      );
    }

    if (text.includes(';')) {
      defects.push({ code: 'FORBIDDEN_LANGUAGE', claimIndex: null, sentenceIndex: index, detail: 'semicolon in user-visible text' });
    }
    if (terminalMarkCount(text) !== 1) {
      defects.push({
        code: 'SENTENCE_LIMIT_EXCEEDED',
        claimIndex: null,
        sentenceIndex: index,
        detail: 'a sentence must carry exactly one terminal mark, so one claim backs one assertion',
      });
    }

    const lowered = text.toLowerCase();
    for (const identifier of identifiers) {
      if (typeof identifier !== 'string' || identifier.length < MIN_SCANNED_IDENTIFIER_LENGTH) continue;
      if (lowered.includes(identifier.toLowerCase())) {
        // The identifier is *not* quoted in the detail. Sprint 07's recorded
        // leak went out through exactly such a field while a test watched the
        // title.
        defects.push({
          code: 'IDENTIFIER_IN_PROSE',
          claimIndex: null,
          sentenceIndex: index,
          detail: 'a caller-chosen identifier from the recommendation appears in user-visible text',
        });
      }
    }
  }

  return defects;
}
