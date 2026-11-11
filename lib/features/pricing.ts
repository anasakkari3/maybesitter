/**
 * What one model call costs, in integer nano-dollars.
 *
 * A budget that is a float drifts: a month of 0.0000003-dollar additions is not
 * the sum it should be. Nano-dollars keep every price an integer per token
 * (1¢ = 10,000,000 n$), so the ledger adds integers and a budget comparison is
 * exact.
 *
 * These are list prices, not invoices. GCP Billing is the source of truth; when
 * a price there moves, this table moves with it, and the budgets in
 * `catalog.ts` are re-read against it.
 *   - gemini-2.5-flash on Vertex: $0.30 / 1M input, $2.50 / 1M output
 *     (`thinkingBudget: 0`, so there are no thinking tokens to bill).
 */

export const NANO_USD_PER_CENT = 10_000_000;

export type PricedModel = 'gemini-2.5-flash';

interface Price {
  readonly inputNanoUsdPerToken: number;
  readonly outputNanoUsdPerToken: number;
}

const PRICES: Readonly<Record<PricedModel, Price>> = Object.freeze({
  'gemini-2.5-flash': { inputNanoUsdPerToken: 300, outputNanoUsdPerToken: 2_500 },
});

/**
 * The priced model a provider's model id bills as. Any Gemini id prices as
 * 2.5 Flash: it is the only one the product calls, and pricing an unknown id
 * at zero would let spend through uncounted, the wrong direction to be wrong in.
 */
export function pricedModelFor(_modelId: string | null | undefined): PricedModel {
  return 'gemini-2.5-flash';
}

function tokens(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value as number)) : 0;
}

export function costNanoUsd(model: PricedModel, usage: { promptTokens?: number; outputTokens?: number }): number {
  const price = PRICES[model];
  return tokens(usage.promptTokens) * price.inputNanoUsdPerToken + tokens(usage.outputTokens) * price.outputNanoUsdPerToken;
}

export function centsToNanoUsd(cents: number): number {
  return Math.max(0, Math.round(cents * NANO_USD_PER_CENT));
}

/** For display and tests; rounded to a hundredth of a cent. */
export function nanoUsdToCents(nanoUsd: number): number {
  return Math.round((nanoUsd / NANO_USD_PER_CENT) * 100) / 100;
}
