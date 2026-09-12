/**
 * Deletes one account on an operator's instruction (UC-1.5, #149).
 *
 * For the requests that arrive outside the app: someone who uninstalled it, or
 * emailed support from the address they signed in with. The runbook is
 * docs/operations/ACCOUNT_DELETION.md.
 *
 *   MAYBESITTER_STORAGE_BACKEND=firestore \
 *   MAYBESITTER_FIRESTORE_DATABASE_ID=staging \
 *   MAYBESITTER_DELETION_RECEIPT_PEPPER=… \
 *     node --loader ./scripts/ts-resolver.mjs scripts/delete-account.ts <uid>
 *
 * It calls the same `deleteAccount` the app's own endpoint calls. That is the
 * point: a second implementation for operators would be the one that drifts,
 * and the drift would be found by a user who was told they were deleted.
 *
 * It prints the receipt id and the step outcomes, and nothing else. Not the
 * email that made the request, not what was deleted — the operator needs a
 * reference to reply with, not a copy of the data.
 */
import { deleteAccount, subjectTag } from '../lib/account/accountDeletion';

async function main(): Promise<void> {
  const uid = process.argv[2];
  if (!uid) {
    console.error('usage: delete-account.ts <uid>');
    console.error('the uid comes from the Firebase console, or getUserByEmail — never from the ticket text');
    process.exit(2);
  }

  const receipt = await deleteAccount(uid, { initiatedBy: 'operator' });

  console.log(`receiptId:   ${receipt.receiptId}`);
  console.log(`subject:     ${subjectTag(receipt.subjectHash)}…`);
  console.log(`deletedAt:   ${receipt.deletedAt}`);
  console.log(`docsDeleted: ${receipt.docsDeleted}`);
  for (const [step, outcome] of Object.entries(receipt.steps)) {
    console.log(`  ${step.padEnd(20)} ${outcome}`);
  }
  const failed = Object.entries(receipt.steps).filter(([, outcome]) => outcome === 'failed');
  if (failed.length > 0) {
    // The account is gone either way; an external revocation that did not land
    // is something a person has to chase, so it must not exit 0 silently.
    console.error(`\n${failed.length} step(s) failed: ${failed.map(([step]) => step).join(', ')}`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error('deletion failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
