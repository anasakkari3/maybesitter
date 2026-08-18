/**
 * Alpha review CLI — lists flagged sessions and prints flag details.
 *
 * Usage:
 *   node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/alpha-review.ts
 *   node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/alpha-review.ts --participant <id>
 *   node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/alpha-review.ts --session <id>
 *   node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/alpha-review.ts --delete-participant <id>
 *   node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/alpha-review.ts --delete-session <id>
 */
import { createFileAlphaFeedbackStore } from '../lib/alphaFeedback/alphaFeedbackStore';
import type { AlphaFeedbackFlag } from '../src/contracts/v1/feedbackFlagContracts';

const store = createFileAlphaFeedbackStore();

function main(): void {
  const args = process.argv.slice(2);

  // Handle deletion commands.
  if (args.includes('--delete-participant')) {
    const idx = args.indexOf('--delete-participant');
    const id = args[idx + 1];
    if (!id) { console.error('--delete-participant requires a participant ID'); process.exit(1); }
    const count = store.deleteByParticipant(id);
    console.log(`Deleted ${count} flag(s) for participant ${id}`);
    return;
  }
  if (args.includes('--delete-session')) {
    const idx = args.indexOf('--delete-session');
    const id = args[idx + 1];
    if (!id) { console.error('--delete-session requires a session ID'); process.exit(1); }
    const count = store.deleteBySession(id);
    console.log(`Deleted ${count} flag(s) for session ${id}`);
    return;
  }

  // Parse list filters.
  let participantFilter: string | undefined;
  let sessionFilter: string | undefined;
  const pIdx = args.indexOf('--participant');
  if (pIdx >= 0) participantFilter = args[pIdx + 1];
  const sIdx = args.indexOf('--session');
  if (sIdx >= 0) sessionFilter = args[sIdx + 1];

  const flags = store.list({ participantId: participantFilter, sessionId: sessionFilter });

  if (flags.length === 0) {
    console.log('No flagged sessions found.');
    return;
  }

  console.log(`\n=== Alpha Feedback Flags (${flags.length} total) ===\n`);

  // Group by session.
  const bySession = new Map<string, AlphaFeedbackFlag[]>();
  for (const flag of flags) {
    const list = bySession.get(flag.sessionId) ?? [];
    list.push(flag);
    bySession.set(flag.sessionId, list);
  }

  for (const [sessionId, sessionFlags] of Array.from(bySession.entries())) {
    const first = sessionFlags[0];
    console.log(`Session: ${sessionId}  (participant: ${first.participantId})`);
    console.log(`  First flag: ${first.createdAt}`);
    for (const flag of sessionFlags) {
      const note = flag.note ? ` — "${flag.note}"` : '';
      console.log(`  [${flag.category}] proposalId=${flag.proposalId}${note} (${flag.createdAt})`);
    }
    console.log();
  }

  // Summary by category.
  const summary = new Map<string, number>();
  for (const flag of flags) {
    summary.set(flag.category, (summary.get(flag.category) ?? 0) + 1);
  }
  console.log('--- Summary by category ---');
  for (const [cat, count] of Array.from(summary.entries()).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat}: ${count}`);
  }
}

main();
