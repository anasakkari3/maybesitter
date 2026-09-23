/**
 * The strings that must never appear anywhere above the normalizer.
 *
 * Taken from the fixture the sandbox actually ships, not from a test-only
 * payload, so these guards are checking the data the feature really runs on.
 * They are chosen to be unmistakable: if one of these turns up in a response
 * body or a log line, nothing else could have put it there.
 */
export const RAW_FINANCIAL_SENTINELS: readonly string[] = Object.freeze([
  // Merchants and descriptions
  'MCDONALDS',
  'ZEBRAHOUSE',
  'NORTHWIND',
  'SUPERPHARM',
  'STREAMFLIX',
  'CLOUDNOTES',
  'OLDGYM',
  'ISRAEL ELECTRIC',
  'CARD PURCHASE',
  'STANDING ORDER',
  // Provider-owned identifiers
  'sbx-txn-',
  'sbx-acct-',
  'sbx-stream-',
  // Account names and numbers
  'Everyday Checking',
  'Rainy Day',
  'Platinum Card',
  '****4432',
  '****7781',
  '****8890',
]);

export function assertNoSentinel(
  haystack: string,
  assertOk: (ok: boolean, message: string) => void,
  where: string,
): void {
  for (const sentinel of RAW_FINANCIAL_SENTINELS) {
    assertOk(!haystack.includes(sentinel), `raw provider data reached ${where}: ${sentinel}`);
  }
}
