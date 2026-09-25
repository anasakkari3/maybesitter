/**
 * A transaction the database closed underneath its own reads is run again (#419).
 *
 * The emulator suite failed one run in N with `3 INVALID_ARGUMENT: Transaction
 * is invalid or closed.` after ~9 s, from the two tests that race
 * transactions on purpose. The chain, traced at the adapter boundary: a read
 * inside the transaction waits behind another transaction's locks and is
 * aborted at the emulator's 2 s lock timeout, as a stream that dies before its
 * headers; gax's `retry-request` reads that as "no response" and re-issues the
 * identical read — same transaction id — ~2 s later; the emulator has closed
 * the transaction by then and answers `INVALID_ARGUMENT`; the SDK only
 * recognises production's wording of that (`/transaction has expired/`), so
 * the whole `runTransaction` fails with attempts still in its budget.
 *
 * No emulator here. The fake runner is one `db.runTransaction` that surfaces
 * exactly the error the SDK surfaces when it reused a closed transaction, and
 * the assertions are about what the adapter does with it: run again, from
 * scratch, within the same budget — and never for an `INVALID_ARGUMENT` that
 * really is one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isClosedTransactionError, retryClosedTransaction } from '../../lib/storage/firestoreAdapter.ts';
import { MAX_TRANSACTION_ATTEMPTS } from '../../lib/storage/storageAdapter.ts';

/** The error `@google-cloud/firestore` rejects with after the emulator's `reuseExisting` refused the id. */
function closedByEmulator(): Error & { code: number; details: string } {
  return Object.assign(new Error('3 INVALID_ARGUMENT: Transaction is invalid or closed.'), {
    code: 3,
    details: 'Transaction is invalid or closed.',
  });
}

/** Production's wording for the same event, which the SDK itself retries. */
function expiredInProduction(): Error & { code: number } {
  return Object.assign(new Error('3 INVALID_ARGUMENT: The referenced transaction has expired or is no longer valid.'), { code: 3 });
}

/** An `INVALID_ARGUMENT` that means what it says: the write will never be accepted. */
function refusedWrite(): Error & { code: number } {
  return Object.assign(new Error('3 INVALID_ARGUMENT: Property events contains an invalid nested entity.'), { code: 3 });
}

/**
 * A `db.runTransaction` stand-in: the SDK has already spent whatever inner
 * attempts it was going to, and rejects with `errors[run - 1]`, or resolves
 * once the script runs out.
 */
function fakeRunner(errors: Error[]): { runs: number[]; attempt: (run: number) => Promise<string> } {
  const runs: number[] = [];
  return {
    runs,
    attempt: async (run) => {
      runs.push(run);
      const error = errors[run - 1];
      if (error) throw error;
      return `committed on run ${run}`;
    },
  };
}

test('a transaction the emulator closed under its reads is run again from scratch', async () => {
  const runner = fakeRunner([closedByEmulator()]);
  assert.equal(await retryClosedTransaction(runner.attempt), 'committed on run 2');
  assert.deepEqual(runner.runs, [1, 2], 'the second run must start from the top, as run 2');
});

test('production wording for the same event is treated the same way', async () => {
  const runner = fakeRunner([expiredInProduction()]);
  assert.equal(await retryClosedTransaction(runner.attempt), 'committed on run 2');
  assert.deepEqual(runner.runs, [1, 2]);
});

test('an INVALID_ARGUMENT that really is one is not run again', async () => {
  const runner = fakeRunner([refusedWrite()]);
  await assert.rejects(retryClosedTransaction(runner.attempt), /invalid nested entity/);
  assert.deepEqual(runner.runs, [1], 'a refused write re-run is a refused write, five times');
});

test('ABORTED is left to the SDK, which has already retried it', async () => {
  const aborted = Object.assign(new Error('10 ABORTED: Transaction lock timeout.'), { code: 10 });
  const runner = fakeRunner([aborted]);
  await assert.rejects(retryClosedTransaction(runner.attempt), /lock timeout/);
  assert.deepEqual(runner.runs, [1]);
});

test('closed transactions spend the same budget: the last one escapes', async () => {
  const runner = fakeRunner(Array.from({ length: MAX_TRANSACTION_ATTEMPTS + 2 }, closedByEmulator));
  await assert.rejects(retryClosedTransaction(runner.attempt), (error: unknown) => isClosedTransactionError(error));
  assert.deepEqual(
    runner.runs,
    Array.from({ length: MAX_TRANSACTION_ATTEMPTS }, (_, i) => i + 1),
    `exactly ${MAX_TRANSACTION_ATTEMPTS} runs, never one more`,
  );
});

test('a closed transaction is recognised by status and wording together', () => {
  assert.equal(isClosedTransactionError(closedByEmulator()), true);
  assert.equal(isClosedTransactionError(expiredInProduction()), true);
  assert.equal(isClosedTransactionError(refusedWrite()), false, 'the status alone must not match');
  assert.equal(
    isClosedTransactionError(Object.assign(new Error('10 ABORTED: Transaction is invalid or closed.'), { code: 10 })),
    false,
    'the wording alone must not match',
  );
  assert.equal(isClosedTransactionError(new Error('Transaction is invalid or closed.')), false, 'no gRPC status, no match');
  assert.equal(isClosedTransactionError(null), false);
});
