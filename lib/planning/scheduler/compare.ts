/**
 * The one string ordering this module sorts by.
 *
 * It existed three times — once in `scheduler.ts`, once in `digest.ts`, once
 * inline in `diff.ts` — which is precisely the hazard the sprint design names:
 * "two independent copies of *data or arithmetic* are a gap waiting for
 * whichever caller falls into it". An ordering is arithmetic. Three copies do
 * not check each other; they wait for one of them to be edited.
 *
 * **Integration follow-up.** This belongs in `lib/planning/shared/`, next to
 * `intervalsOverlap`, because #31 must sort identically or the cross-track
 * comparison of two plans becomes a comparison of two sort orders. It is here
 * rather than there because `lib/planning/shared/**` is owned by the sprint
 * base and no track may edit it. Move it at integration.
 *
 * Never `localeCompare`: its result depends on the runtime's ICU data and
 * default locale, so a digest built on it would differ between two machines
 * running identical code, and a plan's ordering would change with `LANG`.
 */

/**
 * Compare by Unicode code point.
 *
 * JavaScript's `<` and `>` compare UTF-16 *code units*, which is a different
 * order: an astral character (U+10000 and above) is stored as a surrogate pair
 * beginning in U+D800–U+DBFF, so it sorts *below* the private-use and CJK
 * compatibility characters in U+E000–U+FFFF even though its code point is far
 * higher. Nothing in this repo has an astral item id today, which is exactly
 * when a name that promises code points and delivers code units gets copied
 * somewhere it matters.
 *
 * The fast path is the whole point of the surrogate test: for strings with no
 * surrogates the two orders coincide, so the common case stays a single
 * comparison instead of two array allocations per call — and this runs inside
 * the sort that builds the digest's canonical form.
 */
const SURROGATE = /[\uD800-\uDFFF]/;

export function compareByCodePoint(left: string, right: string): number {
  if (left === right) return 0;
  if (!SURROGATE.test(left) && !SURROGATE.test(right)) {
    return left < right ? -1 : 1;
  }
  // `Array.from` iterates a string by code point, pairing surrogates.
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const shared = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < shared; index += 1) {
    const leftPoint = leftPoints[index].codePointAt(0) as number;
    const rightPoint = rightPoints[index].codePointAt(0) as number;
    if (leftPoint !== rightPoint) return leftPoint - rightPoint;
  }
  return leftPoints.length - rightPoints.length;
}
