import type { Seed, SeedKind, SeedStatus } from '../../api/schemas/seeds';

/**
 * How a seed is labelled, in words a person wrote (#519).
 *
 * Keys, never sentences composed here, and no Must / Should / Nice anywhere:
 * classifying something the person has not decided on would be the product
 * having an opinion about a maybe, which is exactly what the issue forbids.
 */
const KIND_KEY: Record<SeedKind, string> = {
  consideration: 'seedKindConsideration',
  waiting_for: 'seedKindWaitingFor',
  idea: 'seedKindIdea',
  possible_goal: 'seedKindPossibleGoal',
};

export function seedKindLabel(kind: SeedKind, strings: Record<string, string>): string {
  return strings[KIND_KEY[kind]] ?? '';
}

/**
 * The one line under a seed that says where it stands, or nothing.
 *
 * `open` deliberately has no line. "Open" is the ordinary state and a badge
 * saying so would be noise; the absence of a badge is the state.
 */
export function seedStatusLabel(seed: Seed, strings: Record<string, string>): string | null {
  if (seed.status === 'promoted') {
    return seed.promotedTo?.kind === 'goal'
      ? strings.seedStatusPromotedGoal ?? null
      : strings.seedStatusPromotedTask ?? null;
  }
  const key: Partial<Record<SeedStatus, string>> = {
    snoozed: 'seedStatusSnoozed',
    waiting: 'seedStatusWaiting',
    dismissed: 'seedStatusDismissed',
  };
  const name = key[seed.status];
  return name ? strings[name] ?? null : null;
}

/**
 * Which seeds are still live, newest first.
 *
 * Promoted and dismissed rows are kept by the server — they are part of what
 * it holds about somebody, and the export carries them — but they are not what
 * this screen is for. A list that grew every dismissal for ever would make the
 * one thing the person is actually still turning over harder to find.
 */
export function liveSeeds(seeds: readonly Seed[]): Seed[] {
  return seeds.filter((seed) => seed.status !== 'promoted' && seed.status !== 'dismissed');
}

/** True when this seed has a "bring it back" date the person set themselves. */
export function hasRevisit(seed: Seed): boolean {
  return seed.revisitAt !== null;
}
