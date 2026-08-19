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
 * Speaking in the perfect tense about a write.
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
 * anchored on a completed assertion: a sentence-initial past participle, a first
 * person subject with a past-tense verb, or an explicit `has been`.
 */
export const PERSISTENCE_CLAIM_PATTERNS: readonly RegExp[] = Object.freeze([
  /(^|[.!?]\s+)(saved|created|scheduled|updated|moved|cancelled|canceled|deleted|marked|added|removed)\b/i,
  /\bi\s*([’']ve|\s+have)?\s*(saved|created|scheduled|updated|moved|cancelled|canceled|deleted|marked|added|removed)\b/i,
  /\b(has|have|had)\s+been\s+(saved|created|scheduled|updated|moved|cancelled|canceled|deleted|added|removed)\b/i,
  /\bit[’']?s\s+(done|saved|scheduled|created)\b/i,
  /\ball set\b/i,
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

/** Does any pattern in `patterns` match `text`? Total: a non-string matches nothing. */
export function matchesAny(text: unknown, patterns: readonly RegExp[]): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  for (const pattern of patterns) {
    // Every pattern here is flagless, so `test` carries no `lastIndex` state
    // between calls. An exported RegExp with `g` would make this function return
    // alternating answers for the same input, which is why none is exported for
    // a caller to reuse directly.
    if (pattern.test(text)) return true;
  }
  return false;
}
