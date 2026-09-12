/**
 * `firestore.rules`, executed (UC-1.0b, #141).
 *
 * The rules are the last line between one participant's tree and another's,
 * and a rules file nobody runs is a comment. These run the real file against
 * the emulator: a client may read its own tree and nothing else, and no client
 * may write anywhere — every write goes through the API, where validation
 * lives, and the Admin SDK bypasses rules entirely.
 *
 * Emulator-only. Run `npm run test:emulator`.
 */
import test, { after, before } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, getDocs, collection, setDoc, deleteDoc } from 'firebase/firestore';

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
if (!emulator) {
  throw new Error(
    'FIRESTORE_EMULATOR_HOST is unset. Run this file through `npm run test:emulator`, never against a real project.',
  );
}
const [host, port] = emulator.split(':');

let environment: RulesTestEnvironment;

before(async () => {
  environment = await initializeTestEnvironment({
    // `demo-` guarantees the emulator refuses to reach a real project, and the
    // `-rules` suffix keeps this file's data in its own project: the runner
    // executes test files concurrently against one emulator, and
    // `clearFirestore()` below wipes an entire project. Sharing
    // `demo-maybesitter` meant this file deleted documents other files had just
    // written — captureProposalStore.emulator.test.ts failed with "the proposal
    // was not stored", passing alone and failing in the suite.
    projectId: `${process.env.GCLOUD_PROJECT || 'demo-maybesitter'}-rules`,
    firestore: {
      host,
      port: Number(port),
      rules: readFileSync('firestore.rules', 'utf8'),
    },
  });
  await environment.clearFirestore();
  // Seeded with rules off, the way the Admin SDK writes in production.
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'users/userA'), { schemaVersion: 1, domainVersion: 1 });
    await setDoc(doc(db, 'users/userA/commitments/x'), { id: 'x', title: 'A commitment' });
    await setDoc(doc(db, 'users/userB'), { schemaVersion: 1, domainVersion: 1 });
    await setDoc(doc(db, 'users/userB/commitments/y'), { id: 'y', title: 'B commitment' });
    await setDoc(doc(db, 'incidents/i1'), { incidentId: 'i1' });
  });
});

after(async () => {
  await environment?.cleanup();
});

test('rules: a user reads their own document and their own subcollections', async () => {
  const db = environment.authenticatedContext('userA').firestore();
  await assertSucceeds(getDoc(doc(db, 'users/userA')));
  await assertSucceeds(getDoc(doc(db, 'users/userA/commitments/x')));
  await assertSucceeds(getDocs(collection(db, 'users/userA/commitments')));
  await assertSucceeds(getDoc(doc(db, 'users/userA/events/anything')));
});

test('rules: a user cannot read another user tree', async () => {
  const db = environment.authenticatedContext('userA').firestore();
  await assertFails(getDoc(doc(db, 'users/userB')));
  await assertFails(getDoc(doc(db, 'users/userB/commitments/y')));
  await assertFails(getDocs(collection(db, 'users/userB/commitments')));
});

test('rules: no client write succeeds, not even to its own tree', async () => {
  const db = environment.authenticatedContext('userA').firestore();
  await assertFails(setDoc(doc(db, 'users/userA'), { schemaVersion: 1 }));
  await assertFails(setDoc(doc(db, 'users/userA/commitments/x'), { id: 'x', title: 'edited' }));
  await assertFails(setDoc(doc(db, 'users/userA/commitments/new'), { id: 'new' }));
  await assertFails(deleteDoc(doc(db, 'users/userA/commitments/x')));
  await assertFails(setDoc(doc(db, 'users/userB/commitments/y'), { id: 'y' }));
});

test('rules: an unauthenticated read is denied', async () => {
  const db = environment.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(db, 'users/userA')));
  await assertFails(getDoc(doc(db, 'users/userA/commitments/x')));
  await assertFails(setDoc(doc(db, 'users/userA/commitments/x'), { id: 'x' }));
});

test('rules: the operator-only incident log is readable by no client at all', async () => {
  const signedIn = environment.authenticatedContext('userA').firestore();
  const anonymous = environment.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(signedIn, 'incidents/i1')));
  await assertFails(getDoc(doc(anonymous, 'incidents/i1')));
  await assertFails(setDoc(doc(signedIn, 'incidents/i2'), { incidentId: 'i2' }));
});
