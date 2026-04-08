import type { AppSnapshot } from '@/server/dataStore';
import { getUnifiedAppSnapshot } from '../../lib/services/domainAppSnapshotAdapter';

// Transitional compatibility endpoint:
// reminder state now lives in DomainState/commandService. The old item-based
// reminder engine is intentionally isolated from production reads so the UI
// cannot show a second item reality.
export async function runDueReminders(_now: Date = new Date()): Promise<AppSnapshot> {
  return getUnifiedAppSnapshot();
}
