import { createHash } from 'node:crypto';
import type { Checksum } from './contracts';

/**
 * Deterministic JSON encoding: object keys sorted, no incidental whitespace.
 * Two configs that differ only in key order must produce the same fingerprint,
 * otherwise config fingerprints cannot be compared across runs or tools.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(',')}}`;
  }

  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('cannot fingerprint a non-finite number');
  }

  if (value === undefined) return 'null';

  return JSON.stringify(value);
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

export function checksumOf(input: string | Uint8Array): Checksum {
  return { algorithm: 'sha256', value: sha256Hex(input) };
}

export function fingerprintConfig(config: unknown): Checksum {
  return checksumOf(canonicalJson(config));
}
