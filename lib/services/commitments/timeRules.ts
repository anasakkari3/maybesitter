/**
 * When a commitment time the user just supplied is refused (#352).
 *
 * -- Why this is a module and not three comparisons -----------------
 *
 * The rule lived in `captureBoundary/applyEdits.ts`, where the capture path
 * enforced it, and nowhere else. `PATCH /api/mobile/commitments/:id` accepted a
 * past `dueDate` because it had simply never been given the clock, so the same
 * product rule held on the screen a person reaches it through and not at the
 * boundary a request reaches it through. Writing the comparison a second time
 * next to the PATCH would have made two copies that agree today; the next
 * change to either -- `<` to `<=`, or a grace window -- would have made them
 * disagree, silently, in the direction that stores a reminder nothing will
 * fire.
 *
 * So the comparison lives here once and both callers ask it.
 *
 * -- Why it takes an instant and not a string ----------------------
 *
 * The two callers parse differently on purpose. The capture path reads an edit
 * with `Date.parse`; `/api/mobile` reads a client field with `parseIsoInstant`,
 * which resolves an offset-less datetime as UTC rather than as the server's own
 * zone (see `lib/services/mobile/time.ts`). Folding parsing in here would have
 * to pick one of those and change the other's behaviour. This module owns the
 * decision, not the reading.
 *
 * -- Why it reports rather than throws -----------------------------
 *
 * Each path already has a refusal its callers understand: the capture boundary
 * raises `InvalidEditError`, which becomes `invalid_edit`; the mobile services
 * raise the message `<field> must not be in the past`, which the route turns
 * into HTTP 400. A shared error type would have replaced two vocabularies the
 * clients already read with a third.
 */

/** The wording every `/api/mobile` refusal of a past time already used. */
export function pastTimeMessage(field: string): string {
  return `${field} must not be in the past`;
}

/**
 * Whether an instant the user has just chosen is behind the clock.
 *
 * Exactly `now` is not past: a time chosen at this millisecond is a time the
 * user picked, and the boundary is exclusive so that it stays one.
 *
 * This judges a time being *supplied*, never one already stored. There is no
 * "overdue" in this product -- a commitment whose hour has gone is still
 * active -- so a caller must not run an untouched time through it, or fixing a
 * typo in yesterday's title would become impossible.
 */
export function isPastCommitmentTime(instant: Date | number, now: Date): boolean {
  const millis = instant instanceof Date ? instant.getTime() : instant;
  return millis < now.getTime();
}
