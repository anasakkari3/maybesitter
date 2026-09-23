/**
 * A `FinancialDataPort` backed by fixtures, and nothing else.
 *
 * This is where a real aggregator's transport will go, and until one does this
 * is what the whole feature runs on. It is in a directory called `sandbox`
 * rather than `production` on purpose: the honest status of the data source is
 * something a reader should learn from the import path, not from a changelog.
 * Replacing it means adding `production/<vendor>Transport.ts` that implements
 * the same four verbs. Nothing above this file changes.
 *
 * ── Why the dates move ───────────────────────────────────────────
 *
 * A fixture with hard-coded dates is useful for about a month and then shows
 * every demo a payday that happened last spring. The dates here are anchored
 * to the fixture's own `epoch` and shifted by whole months towards the caller's
 * `asOf`, which keeps rent on the 1st, the card on the 25th and the salary on
 * the 28th while keeping them current. Whole months, never whole days, because
 * a day-shift walks a monthly bill off its day of the month.
 *
 * It is still deterministic: the same `asOf` produces the same bytes, which is
 * what lets the builder's tests assert exact totals against it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  FinancialAccountPayload,
  FinancialBalancePayload,
  FinancialDataPort,
  FinancialReadRequest,
  FinancialRecurringStreamPayload,
  FinancialTransactionPayload,
} from '../port';

export interface SandboxFinancialFixture {
  readonly epoch: string;
  readonly accounts: readonly FinancialAccountPayload[];
  readonly balances: readonly FinancialBalancePayload[];
  readonly transactions: readonly FinancialTransactionPayload[];
  readonly recurring: readonly FinancialRecurringStreamPayload[];
}

export interface SandboxFinancialTransportInput {
  /** The instant the sandbox should look current as of. */
  readonly asOf: string;
  readonly fixture?: SandboxFinancialFixture;
}

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

export function loadSandboxFixture(name = 'household'): SandboxFinancialFixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf8')) as SandboxFinancialFixture;
}

/**
 * Add whole months, keeping the day of the month where it can.
 *
 * A bill on the 31st has no 31st to land on in the next month. Clamping to the
 * last day of the target month is what a bank does with a standing order, and
 * it is the only option that does not silently move the payment into the month
 * after.
 */
export function shiftMonths(iso: string, months: number): string {
  const source = new Date(iso);
  const day = source.getUTCDate();
  const target = new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  target.setUTCHours(
    source.getUTCHours(), source.getUTCMinutes(), source.getUTCSeconds(), source.getUTCMilliseconds(),
  );
  return target.toISOString();
}

function monthsBetween(from: string, to: string): number {
  const a = new Date(from);
  const b = new Date(to);
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
}

export function createSandboxFinancialTransport(input: SandboxFinancialTransportInput): FinancialDataPort {
  const fixture = input.fixture ?? loadSandboxFixture();
  const offset = monthsBetween(fixture.epoch, input.asOf);
  const move = (iso: string) => shiftMonths(iso, offset);

  const balances = fixture.balances.map((row) => ({ ...row, observedAt: move(row.observedAt) }));
  const transactions = fixture.transactions.map((row) => ({ ...row, postedAt: move(row.postedAt) }));
  const recurring = fixture.recurring.map((stream) => ({
    ...stream,
    lastDate: move(stream.lastDate),
    predictedNextDate: stream.predictedNextDate === null ? null : move(stream.predictedNextDate),
  }));

  const within = (at: string, request: FinancialReadRequest) =>
    (request.since === null || at >= request.since) && (request.until === null || at < request.until);

  return {
    listAccounts: async () => fixture.accounts,
    listBalances: async () => balances,
    listTransactions: async (request) => transactions.filter((row) => within(row.postedAt, request)),
    listRecurring: async () => recurring,
  };
}

export const SANDBOX_FINANCIAL_TRANSPORT_POLICY = Object.freeze({
  readsNetwork: false,
  readsCredentialVault: false,
  isProductionDataSource: false,
});
