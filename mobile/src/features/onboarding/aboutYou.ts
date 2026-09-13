/**
 * The self-description step's own rules (UC-2.7b, #168).
 *
 * Mirrors `src/profile/profileContracts.ts` on the server. Kept as a small
 * client copy rather than imported, because `mobile/` has its own toolchain
 * and the root `tsconfig` excludes it — and the fixtures generated from the
 * real handlers are what keep the two honest.
 */
export const MAX_DESCRIPTION_LENGTH = 1_000;

/** What the review list holds while the user decides. */
export interface ReviewChoice {
  /** Ticked. **False by default**, always — see `initialChoices`. */
  accepted: boolean;
  /** The user's edit, or null when they left it as proposed. */
  edited: string | null;
}

/**
 * Every suggestion, unticked.
 *
 * The default is the whole point of the screen: these are guesses a model made
 * about a person, and a pre-ticked box would make "nothing persists without
 * explicit confirmation" false while still looking like a choice.
 */
export function initialChoices(count: number): ReviewChoice[] {
  return Array.from({ length: count }, () => ({ accepted: false, edited: null }));
}

export interface AcceptedSuggestion {
  index: number;
  content?: string;
}

/**
 * What to send to confirm: only the ticked ones, with an edit when there is a
 * real one.
 *
 * An "edit" that matches the original is not sent as an edit — it would store
 * the fact as the user's own words when they only opened the field and closed
 * it, and the provenance chip would then claim they wrote something they did
 * not.
 */
export function acceptedFrom(
  choices: readonly ReviewChoice[],
  suggestions: readonly { content: string }[],
): AcceptedSuggestion[] {
  const accepted: AcceptedSuggestion[] = [];
  choices.forEach((choice, index) => {
    if (!choice.accepted) return;
    const original = suggestions[index]?.content ?? '';
    const edited = choice.edited?.trim() ?? '';
    accepted.push(edited !== '' && edited !== original ? { index, content: edited } : { index });
  });
  return accepted;
}
