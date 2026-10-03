import type { CaptureConfirmation } from '../../api/schemas/capture';
import { isolateAuto } from '../../i18n/bidi';
import { fill, type Lang, type Strings } from '../../i18n/strings';

type Collision = NonNullable<CaptureConfirmation['collisions']>[number];

/** The most clashes the one message names; the rest are counted, not listed. */
const MAX_NAMED = 3;

/**
 * What a confirm's clash warnings say, as at most one message (audit
 * 2026-10-03 #1: three items saved at one hour came back as six near-identical
 * «انتبه: هاد بيتعارض مع …» lines, one per pair and direction).
 *
 * The server reports, for each saved item, every commitment it lands on — so
 * two saved items that overlap each other are each other's clash, and the
 * same commitment comes back once per item it overlaps. Each commitment is
 * named once. One clash is the line it always was; more are one line naming
 * them (`MAX_NAMED` at most, «…» after) and saying what to do about it: Undo,
 * which sits right under it, or a new time for one of them.
 */
export function collisionLines(
  collisions: readonly Collision[],
  t: Strings,
  lang: Lang,
  whenOf: (startsAt: string) => string,
): string[] {
  const seen = new Set<string>();
  const unique = collisions.filter((collision) => (seen.has(collision.commitmentId) ? false : (seen.add(collision.commitmentId), true)));
  if (unique.length === 0) return [];
  if (unique.length === 1) {
    const only = unique[0]!;
    return [fill(t.savedCollision, { title: only.title, when: whenOf(only.startsAt) })];
  }
  const named = unique.slice(0, MAX_NAMED).map((collision) => {
    const title = lang === 'ar' ? `«${isolateAuto(collision.title)}»` : `"${isolateAuto(collision.title)}"`;
    return `${title} ${whenOf(collision.startsAt)}`;
  });
  const list = `${named.join(lang === 'ar' ? '، ' : ', ')}${unique.length > MAX_NAMED ? '…' : ''}`;
  return [fill(t.savedCollisionMany, { list })];
}
