import type { DailyDigest, User } from '../../src/types/index';
import {
  getDefaultUser,
  SINGLE_USER_ID,
  updateAppData,
} from '../../src/server/dataStore';
import {
  applyLegacyItemAction,
  clearCommitments,
  getUnifiedAppSnapshot,
} from './domainAppSnapshotAdapter';

export type LegacyMetadataAction = {
  type: 'updateUser' | 'setDailyDigest' | 'confirmDailyDigest' | 'deleteAccount';
  user?: Partial<User>;
  digest?: DailyDigest;
};

export async function updateLegacyMetadata(body: LegacyMetadataAction): Promise<void> {
  await updateAppData((data) => {
    switch (body.type) {
      case 'updateUser':
        data.user = {
          ...data.user,
          ...body.user,
          id: SINGLE_USER_ID,
          preferences: {
            ...data.user.preferences,
            ...body.user?.preferences,
          },
        };
        break;
      case 'setDailyDigest':
      case 'confirmDailyDigest': {
        if (!body.digest) throw new Error('digest is required');
        const digest = { ...body.digest, userId: SINGLE_USER_ID };
        const idx = data.dailyDigests.findIndex((item) => item.date === digest.date && item.userId === SINGLE_USER_ID);
        if (idx === -1) data.dailyDigests.push(digest);
        else data.dailyDigests[idx] = digest;
        break;
      }
      case 'deleteAccount':
        data.user = getDefaultUser();
        data.dailyDigests = data.dailyDigests.filter((digest) => digest.userId !== SINGLE_USER_ID);
        break;
    }
  });
}

export async function confirmDailyDigestAndAcknowledgeDueItems(digest: DailyDigest, today?: string): Promise<void> {
  await updateLegacyMetadata({ type: 'confirmDailyDigest', digest });
  const effectiveToday = today || digest.date || new Date().toISOString().slice(0, 10);
  const snapshot = await getUnifiedAppSnapshot();
  for (const item of snapshot.items) {
    if (item.completedAt || item.acknowledgedAt || item.state === 'cancelled') continue;
    if (item.dueDate && item.dueDate <= effectiveToday) {
      applyLegacyItemAction(item.id, 'aware');
    }
  }
}

export async function resetSingleUserAccount(): Promise<void> {
  clearCommitments();
  await updateLegacyMetadata({ type: 'deleteAccount' });
}
