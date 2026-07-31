import type { Checksum, LockedArtifactRecord } from './contracts';
import { canonicalJson, checksumOf } from './fingerprint';

export const LEDGER_CHAIN_GENESIS = '';

/**
 * The lock ledger is append-only, so consistency between the registry and the
 * ledger is not on its own enough: someone can edit a locked artifact and then
 * edit its ledger row to match. Each row therefore commits to every row before
 * it. Rewriting any earlier row invalidates every chain checksum after it, so a
 * silent in-place edit is not expressible — the only consistent way to change a
 * locked artifact is to append a supersession row.
 */
export function computeChainChecksum(
  record: Omit<LockedArtifactRecord, 'chainChecksum'>,
  previousChainChecksum: string,
): Checksum {
  const { chainChecksum: _ignored, ...payload } = record as LockedArtifactRecord;
  return checksumOf(canonicalJson({ previous: previousChainChecksum, record: payload }));
}

/** Recomputes the whole chain, in order, and returns the expected checksums. */
export function computeChain(
  records: readonly Omit<LockedArtifactRecord, 'chainChecksum'>[],
): readonly Checksum[] {
  const chain: Checksum[] = [];
  let previous = LEDGER_CHAIN_GENESIS;

  for (const record of records) {
    const next = computeChainChecksum(record, previous);
    chain.push(next);
    previous = next.value;
  }

  return chain;
}

/** Head of the chain, the single value a reviewer can pin in a release gate. */
export function chainHead(records: readonly LockedArtifactRecord[]): string {
  const chain = computeChain(records);
  return chain.length === 0 ? LEDGER_CHAIN_GENESIS : chain[chain.length - 1].value;
}
