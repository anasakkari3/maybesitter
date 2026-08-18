/**
 * Expire stale runtime memory records. Run from a scheduled job or manually.
 *   node scripts/runtime-memory-prune.ts [--now=<iso>] [--data-dir=<path>]
 *
 * Unlike scripts/alpha-trace-prune.ts there is no --older-than-days flag: each
 * record's staleAfter boundary is stamped at write time from the store's TTL,
 * so retention is a write-time decision and prune only enforces it. Passing a
 * cutoff here would silently override what each record was written with.
 *
 * --now exists because the store never reads the system clock; the CLI is the
 * boundary where a real clock is legitimate, and overriding it makes a prune
 * run reproducible.
 *
 * Pruning marks records `expired` and removes them from retrieval. It does not
 * delete them — deletion is a separate, deliberate act (deleteById /
 * deleteScope), and collapsing the two would lose the distinction the store
 * exists to keep.
 */
import { createFileRuntimeMemoryStore } from '../lib/runtimeMemory/runtimeMemoryStore';

function flag(name: string): string | undefined {
  const match = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : undefined;
}

const now = flag('now') ?? new Date().toISOString();
const dataDir = flag('data-dir');
const store = createFileRuntimeMemoryStore(dataDir ? { dataDir } : undefined);
const expired = store.prune(now);
console.log(`Expired ${expired} stale runtime memory record(s) as of ${now}.`);
