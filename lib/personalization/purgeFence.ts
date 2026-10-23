export interface PersonalizationPurgeSnapshot {
  state: string;
  epoch: number;
  completedAt: string | null;
}

export function purgeOf(user: unknown): PersonalizationPurgeSnapshot {
  const purge = (user as { personalizationPurge?: {
    state?: unknown;
    epoch?: unknown;
    completedAt?: unknown;
  } } | null)?.personalizationPurge;
  return {
    state: typeof purge?.state === 'string' ? purge.state : 'active',
    epoch: typeof purge?.epoch === 'number' && Number.isFinite(purge.epoch) ? purge.epoch : 0,
    completedAt: typeof purge?.completedAt === 'string' ? purge.completedAt : null,
  };
}

export function personalizationPurgeMatches(user: unknown, epoch: number): boolean {
  const purge = purgeOf(user);
  return purge.state === 'active' && purge.epoch === epoch;
}
