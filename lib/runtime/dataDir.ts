import path from 'node:path';

/**
 * The local data directory used when `MAYBESITTER_DATA_DIR` is unset:
 * `<cwd>/.maybesitter`. Exposed separately so a check that must compare a
 * configured directory against the local default (pilot runtime config) can do
 * so without the env var short-circuiting the comparison.
 */
export function localDataDir(): string {
  return path.join(process.cwd(), '.maybesitter');
}

/**
 * The one place a module decides where its runtime data lives.
 *
 * `MAYBESITTER_DATA_DIR` when set (a durable volume in pilot mode, a per-process
 * temp dir under `npm test`), otherwise `<cwd>/.maybesitter`. Resolved at call
 * time, so a caller that reads it lazily follows the environment of the moment.
 */
export function resolveDataDir(...sub: string[]): string {
  return path.join(process.env.MAYBESITTER_DATA_DIR || localDataDir(), ...sub);
}
