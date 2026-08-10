/**
 * Prune expired alpha traces. Run from a scheduled job or manually.
 *   node scripts/alpha-trace-prune.ts [--older-than-days 30]
 */
import { createFileAlphaTraceStore } from '../lib/alphaTrace/alphaTraceStore';

const daysArg = process.argv.find((a) => a.startsWith('--older-than-days='));
const days = daysArg ? Number(daysArg.split('=')[1]) : 30;
const store = createFileAlphaTraceStore({ retentionTtlMs: days * 24 * 60 * 60 * 1_000 });
const pruned = store.prune();
console.log(`Pruned ${pruned} expired alpha trace session(s) (older than ${days} days).`);
