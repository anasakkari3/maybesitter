/**
 * The storage contract against real Firestore (UC-1.0b, #141).
 *
 * The same suite `tests/storage/storageContract.test.ts` runs against the
 * memory adapter. Running both is the point: a rule the memory adapter
 * enforces but Firestore does not (or the other way round) means `npm test`
 * is green about something production does differently.
 *
 * Emulator-only, so it is not in `npm test`. Run `npm run test:emulator`.
 */
import { randomUUID } from 'node:crypto';
import { createFirestoreStorage } from '../../lib/storage/firestoreAdapter.ts';
import { storageContractSuite } from './storageContractSuite.ts';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    'FIRESTORE_EMULATOR_HOST is unset. Run this file through `npm run test:emulator`, never against a real project.',
  );
}

const adapter = createFirestoreStorage();

storageContractSuite('firestore', async () => ({
  adapter,
  // A fresh root per case: the emulator keeps data for the whole exec run.
  scope: `s${randomUUID().replace(/-/g, '')}`,
}));
