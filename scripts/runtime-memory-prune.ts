/**
 * Expire stale runtime memory records, across every user (UC-1.0c, #142).
 *
 *   node --loader ./scripts/ts-resolver.mjs scripts/runtime-memory-prune.ts [--now=<iso>]
 *
 * ── Cross-user by construction ───────────────────────────────────
 *
 * Records live at `users/{uid}/memory/{memoryId}`, so an operator prune is a
 * collection-group read over `memory` rather than a walk of one directory.
 * That is what `prune()` does internally, and it is why this script no longer
 * takes a `--data-dir`: there is no directory to point it at, and a flag that
 * silently did nothing would be worse than its absence.
 *
 * UC-1.0d (#143) exposes this as a job type on the jobs endpoint; this entry
 * point stays for an operator running it by hand.
 *
 * ── Why there is still no --older-than-days ──────────────────────
 *
 * Each record's `staleAfter` boundary is stamped at write time from the
 * store's TTL, so retention is a write-time decision and prune only enforces
 * it. Passing a cutoff here would silently override what each record was
 * written with.
 *
 * `--now` exists because the store never reads the system clock; the CLI is
 * the boundary where a real clock is legitimate, and overriding it makes a
 * prune run reproducible.
 *
 * Pruning marks records `expired` and removes them from retrieval. It does not
 * delete them — deletion is a separate, deliberate act (deleteById /
 * deleteScope), and collapsing the two would lose the distinction the store
 * exists to keep.
 */
import { createStorageRuntimeMemoryStore } from '../lib/runtimeMemory/runtimeMemoryStore';

function flag(name: string): string | undefined {
  const match = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : undefined;
}

async function main(): Promise<void> {
  const now = flag('now') ?? new Date().toISOString();
  const expired = await createStorageRuntimeMemoryStore().prune(now);
  console.log(`Expired ${expired} stale runtime memory record(s) as of ${now}.`);
}

void main().catch((error: unknown) => {
  console.error('runtime memory prune failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
