/**
 * The pattern lexicon the post validator judges text with.
 *
 * ── Why these spellings exist twice in this repo ─────────────────────────
 *
 * `lib/services/responseEngine/validation.ts` already forbids eight shame words
 * on the shipped product surface, and `SHAME_PATTERNS` below repeats all eight
 * deliberately. Sprint 06's lesson says two copies of *data* are a gap waiting
 * for whichever caller falls into it, so a duplication has to be justified out
 * loud rather than left to be discovered:
 *
 *   - The gateway must not import the surface it guards. Sprint 05's rule is
 *     that a check owned by the thing it checks is not a check, and the merge's
 *     cross-track test compares this module against the product validator on the
 *     same inputs — an import in either direction would make that comparison
 *     compare a thing with itself.
 *   - `lib/services/**` is out of scope for this sprint and must not be
 *     modified, so the shared constant cannot be hoisted to a neutral place
 *     either. The integration that owns both files is where that move belongs.
 *
 * What stops the two from drifting is a test rather than a type:
 * `tests/safety/validators.test.ts` iterates the product's eight words and
 * asserts each still fires here. A divergence therefore fails rather than
 * quietly widening what the gateway lets through.
 *
 * ── What is deliberately *not* copied ────────────────────────────────────
 *
 * `LEGACY_AND_INTERNAL_PATTERNS` — the product's ban on `Tracking`, `Drafted`,
 * ISO dates and the word `command` in user copy — is a *presentation* rule about
 * scaffolding leaking into prose. This module has no opinion about it. Its
 * time-related rule is `FABRICATED_INSTANT`, which is about whether a stated
 * time was read from anything, and the two neither imply nor exclude each other:
 * a well-sourced date written as `2026-08-21` fails the product's rule and
 * passes this one, and `next Tuesday` invented from nothing does the reverse.
 *
 * No clock and no randomness is reachable from this file, and nothing here
 * orders anything — see `tests/safety/safetyBoundaries.test.ts`.
 */

/**
 * Labels applied to the person rather than the situation.
 *
 * The first eight are `SHAME_PATTERNS` from the product validator, spelled
 * identically. The rest are constructions that shame without using any of those
 * words, which is the half a word list cannot reach: "you always let this slip"
 * contains no forbidden term and is the more common way it actually shows up.
 *
 * The curly apostrophe is matched beside the straight one because real copy uses
 * it, and a filter that only knows `'` reports clean on the text a renderer
 * actually produces.
 */
import { INSTRUCTION_BEARING_ORIGINS, matchingVariants } from '../../src/contracts/v1/safetyContracts';

export const SHAME_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bavoidant\b/i,
  /\binconsistent\b/i,
  /\blazy\b/i,
  /\bfault\b/i,
  /\bfailed\b/i,
  /\bshame\b/i,
  /\bguilt\b/i,
  /\bdisappointed\b/i,
  /\byou always\b/i,
  /\byou never\b/i,
  // Both apostrophes: NFKC does not fold U+2019 to U+0027, and real copy uses it.
  /\bwhy can[’']?t you\b/i,
  /\byou keep (failing|slipping|putting)\b/i,
  /\byou should be ashamed\b/i,
  /\bundisciplined\b/i,
  /\bmaking excuses\b/i,
]);

/**
 * Removing the person's option to decline.
 *
 * New ground. The product's `strategyAlignmentErrors` checks that a pressure
 * message *matches its strategy* — an `easy_choice` must offer a keep/move
 * choice, a `blocker_probe` must ask about a blocker — and never that the
 * pressure itself was permissible. A perfectly aligned `escalate_choice` reading
 * "do it now or I stop helping you" passes every product check there is.
 */
export const COERCION_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bno choice\b/i,
  /\blast chance\b/i,
  /\bfinal warning\b/i,
  /\bor else\b/i,
  /\byou must\b/i,
  /\byou have to\b/i,
  /\bnot (an )?option\b/i,
  /\bi won[’']?t let you\b/i,
  /\bor i (will|[’']ll) (stop|refuse)\b/i,
]);

/**
 * Speaking about a write this module cannot perform — in any tense.
 *
 * **Deliberately stricter than the product's rule and narrower than its word
 * list, and both halves matter.**
 *
 * Stricter: `semanticValidationErrors` fires `no-change message implies
 * persistence` only when the plan declares `stateChange: 'none'`, so a plan that
 * omits the field reaches none of those branches. The gateway guards modules
 * that *propose*, so the trigger here is the claim itself — a proposal may never
 * say it already happened, whatever it declared.
 *
 * Narrower: the product's `CREATION_OR_TRACKING_CLAIM` matches bare `reminder`
 * and `remind`, which would make "shall I set a reminder?" a persistence claim.
 * An offer is not a claim, and a check that cannot tell them apart is one a
 * coaching track will be forced to route around. So every pattern below is
 * anchored on a **first-person subject**: the product asserting something about
 * its own capability, never a question about one and never a description of what
 * the user did.
 *
 * ── Why the tense anchor was not enough ──────────────────────────────────
 *
 * The first five patterns are anchored on a *completed* assertion — a
 * sentence-initial past participle, `I have saved`, an explicit `has been`. That
 * reading was too narrow by exactly one tense, and the gap was measured through
 * the real `evaluateSafetyGate` rather than argued:
 *
 *     "I'm keeping track of that for you."  -> allow
 *     "I'll keep an eye on that for you."   -> allow
 *     "I will save that for you."           -> allow
 *     "I'm tracking that one."              -> allow      … 12 of 12 allowed
 *     "I saved that for you."               -> PERSISTENCE_CLAIMED
 *
 * The product cannot keep track of anything, so "I will keep track" is exactly
 * as false as "I kept track" — the two are different tenses of one lie about one
 * non-existent capability, and #37's surveillance corpus is written in the tense
 * this list did not read. The final pattern closes it.
 *
 * ── And why it does not close it with a root list ────────────────────────
 *
 * #38 fixed the mirror of this defect by switching to roots and bought false
 * positives on `shameless`, `logician`, `storefront` and `notebook`. The cost is
 * asymmetric between the two modules: #38's list is checked against a *closed
 * template table*, where an over-catch is a test failure someone fixes in one
 * line. This one judges free text a producer wrote, where an over-catch blocks a
 * message a person was supposed to read, so the direction that is right there is
 * wrong here.
 *
 * The anchor is therefore the **subject and the auxiliary**, not the verb:
 * `I will`, `I'll`, `I am`, `I'm`, optionally `going to` / `about to` / `be`.
 * "Would you like me to keep an eye on it?" is an offer, "You said you'd keep an
 * eye on it" is about the user, and neither carries that anchor — which is what
 * `tests/safety/validators.test.ts`'s negative corpus pins, sentence by
 * sentence, alongside the twelve that must block.
 */
export const PERSISTENCE_CLAIM_PATTERNS: readonly RegExp[] = Object.freeze([
  /(^|[.!?]\s+)(saved|created|scheduled|updated|moved|cancelled|canceled|deleted|marked|added|removed)\b/i,
  // The surveillance verbs are here as well as in the future-tense pattern
  // below. "I logged that one for you." is a completed claim about a write this
  // module cannot perform, and it was reaching no pattern at all: the perfect
  // tense listed only the calendar verbs, so closing the future tense alone
  // still left two of #37's four English rows allowed.
  //
  // `noted` and `watched` are deliberately absent. "I noted that" ordinarily
  // means *understood*, and "I watched that happen" is a description, so both
  // would block ordinary sentences to catch a rarer phrasing — the trade this
  // list refuses everywhere else.
  /\bi\s*([’']ve|\s+have)?\s*(saved|created|scheduled|updated|moved|cancelled|canceled|deleted|marked|added|removed|logged|tracked|monitored|recorded|stored)\b/i,
  /\bi\s*(?:[’']ve|\s+have)?\s*kept\s+(track|tabs|an\s+eye)\b/i,
  /\b(has|have|had)\s+been\s+(saved|created|scheduled|updated|moved|cancelled|canceled|deleted|added|removed)\b/i,
  /\bit[’']?s\s+(done|saved|scheduled|created)\b/i,
  /\ball set\b/i,
  // Future and progressive, anchored on the first-person subject rather than on
  // the verb — see the "one tense" note above. Both inflections of each verb are
  // spelled out because `be` splits them: "I'll save" and "I'll be saving" are
  // the same promise.
  /\bi\s*(?:[’']ll|[’']m|\s+will|\s+am)\s+(?:(?:going|about)\s+to\s+)?(?:be\s+)?(?:sav(?:e|ing)|creat(?:e|ing)|schedul(?:e|ing)|updat(?:e|ing)|mov(?:e|ing)|cancel(?:l?ing)?|delet(?:e|ing)|mark(?:ing)?|add(?:ing)?|remov(?:e|ing)|track(?:ing)?|log(?:ging)?|not(?:e|ing)|record(?:ing)?|stor(?:e|ing)|monitor(?:ing)?|watch(?:ing)?|remind(?:ing)?|keep(?:ing)?\s+(?:track|an\s+eye|tabs|a\s+(?:note|record)))\b/i,
]);

/**
 * Text addressed to the system rather than to a person.
 *
 * Three languages, because the repo's fixtures and evaluation corpora are
 * AR/HE/EN and an injection filter that only reads English is a filter with a
 * documented bypass.
 *
 * `act as` and a bare `system` are **deliberately absent**. "Act as the
 * note-taker in tomorrow's meeting" and "the system is down again" are ordinary
 * sentences, and a detector that fires on them is one whose callers learn to
 * ignore it — which is worse than not having it, because the ignoring is
 * invisible. `tests/safety/validators.test.ts` pins both directions.
 */
export const INJECTION_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bignore\s+(all\s+)?(the\s+)?(previous|prior|above|earlier|preceding)\s+(instructions?|prompts?|rules?|messages?)/i,
  /\bdisregard\s+(the\s+|all\s+)?(above|previous|prior|earlier|preceding)\b/i,
  /\bforget\s+(everything|all\s+previous)\b/i,
  /\byou are now\b/i,
  /\bsystem\s+prompt\b/i,
  /\bnew\s+instructions\b/i,
  /\bdeveloper\s+mode\b/i,
  /\bjailbreak\b/i,
  /\boverride\s+your\b/i,
  /(^|\n)\s*(system|assistant)\s*:/i,
  /تجاهل\s+(كل\s+)?(ال)?(تعليمات|توجيهات|أوامر)/,
  /התעלם\s+מ(ה)?(הוראות|הנחיות)/,
]);

/**
 * How much text has to be shared before an echo is an echo.
 *
 * Sixteen characters rather than the eight `AUDIT_LEAK_DEFAULT_RUN_LENGTH` uses,
 * because the two questions differ. A leak check asks "did any fragment of this
 * escape", where a false positive costs a redaction. An echo check asks "did the
 * producer obey the injected text", where a false positive blocks a legitimate
 * message that happens to quote the user — and a user's own note is the most
 * likely thing a coaching message quotes.
 */
export const INSTRUCTION_ECHO_RUN_LENGTH = 16;

/**
 * The shortest identifier worth searching user-visible text for.
 *
 * A two-character id is a substring of ordinary English, so scanning for one
 * reports every message as a leak. Four is the floor, and the honest consequence
 * is that a leak of a three-character id is not caught by this scan.
 *
 * That is acceptable only because it is not the load-bearing defence. The
 * structural rule is that identifiers never enter prose in the first place —
 * findings locate everything by index, and `checkSafetyAudit` proves it for the
 * record. This scan is the second line, against a *producer* that put an id into
 * a sentence.
 */
export const MIN_IDENTIFIER_MATCH_LENGTH = 4;

/**
 * Does any pattern in `patterns` match `text`?
 *
 * **Matching is on `normalizeForComparison`, not on the raw string**, and that
 * is a correctness fix rather than a nicety. The first version matched raw text
 * while the echo comparison normalised, so the two disagreed about what "the
 * same text" is — and one zero-width space defeated the entire injection filter:
 *
 *     ignore all previous instructions        -> INJECTED_INSTRUCTION
 *     ignore<U+200B>all previous instructions -> nothing
 *     ignore<U+200F>all previous instructions -> nothing
 *     fullwidth i-g-n-o-r-e ...               -> nothing
 *
 * A model reads all four as the same instruction. `INSTRUCTION_ECHOED` went dark
 * with the same bypass, because a payload the pre stage never flagged is a
 * payload the post stage never looks for.
 *
 * Both normalisation variants are tested, because removing a format character
 * and replacing it with a space each leave a different bypass — see
 * `matchingVariants`. `ignore<ZWSP>all` needs the replacing form and
 * `ig<ZWSP>nore all` needs the removing one, and an attacker picks whichever is
 * missing.
 *
 * The patterns below are therefore written against normalised text: lower case,
 * single spaces. A pattern with an upper-case letter in it would silently never
 * fire, which is why the `i` flags are kept — they are belt and braces, not the
 * mechanism.
 *
 * Total: a non-string matches nothing.
 */
export function matchesAny(text: unknown, patterns: readonly RegExp[]): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  const variants = matchingVariants(text);
  for (const pattern of patterns) {
    // Every pattern here is flagless, so `test` carries no `lastIndex` state
    // between calls. An exported RegExp with `g` would make this function return
    // alternating answers for the same input, which is why none is exported for
    // a caller to reuse directly.
    for (const variant of variants) {
      if (pattern.test(variant)) return true;
    }
  }
  return false;
}

/**
 * Is this span an injection attempt?
 *
 * One definition, used by both stages. `preValidator` decides whether to report
 * `INJECTED_INSTRUCTION` and `postValidator` decides which texts an echo is
 * measured against, and the first version let those two disagree: the pre pass
 * exempted instruction-bearing origins and the post pass did not. So a
 * `system_template` whose text legitimately reads as an instruction was never
 * flagged, and yet a candidate quoting it was reported `INSTRUCTION_ECHOED` —
 * quoting the product's own template is not an attack succeeding.
 *
 * The mutation sweep is what surfaced it. With the two rules aligned, "flagged
 * as an injection" means one thing, and the gateway's untargeted-redaction
 * escalation becomes provably unreachable through the validators — which is a
 * fact worth knowing, and was invisible while the two rules disagreed.
 */
export function isInjectedSpan(origin: unknown, text: unknown): boolean {
  if ((INSTRUCTION_BEARING_ORIGINS as readonly unknown[]).includes(origin)) return false;
  return matchesAny(text, INJECTION_PATTERNS);
}
