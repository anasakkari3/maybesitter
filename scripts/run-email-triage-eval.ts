/**
 * The live Gmail triage eval. **Manual. Never run in CI.**
 *
 *   MAYBESITTER_LIVE_TRIAGE_EVAL=1 MAYBESITTER_LLM_PROVIDER=gemini \
 *   MAYBESITTER_GCP_PROJECT=<project> MAYBESITTER_VERTEX_LOCATION=europe-west1 \
 *   node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/run-email-triage-eval.ts \
 *     --set <golden.jsonl> --out <report.json> [--max-cents 10]
 *
 * ── What it answers ──────────────────────────────────────────────
 *
 * The owner's rule for every cost cut is "never harm quality": triage may ship
 * in enforce mode only if, on a labelled set of real mail, no message that
 * holds a commitment scores under the threshold. This scores every message
 * with the production scorer (`scoreEmailRelevance`, Gemini header fallback,
 * the same prompt, schema and 600-character cut) and reports, per threshold:
 * how many labelled commitments would have been skipped, and how much mail
 * would have been skipped in total.
 *
 * ── The set lives outside the repository ─────────────────────────
 *
 * One JSON object per line: `{ id, from, subject, body, label }`, where label
 * is 1 (holds something to act on), 0 (does not) or "m" (borderline). It is
 * someone's mail, so it is never committed. The report holds message ids,
 * labels, scores and counts, never a sender, subject or body.
 *
 * ── It refuses to run by accident, and it stops at a price ───────
 *
 * Without `MAYBESITTER_LIVE_TRIAGE_EVAL=1` it prints what it would do and exits
 * 0. It adds up the tokens Vertex reports and stops before the next call once
 * `--max-cents` (default 10) would be passed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { costNanoUsd, nanoUsdToCents } from '../lib/features/pricing.ts';
import { shareLlmProvider } from '../lib/llm/shareProvider.ts';
import { isConversationReply, scoreEmailRelevance } from '../lib/intelligence/emailTriage.ts';
import { consentGatedProvider } from '../lib/llm/consentGatedProvider.ts';

interface GoldenMail {
  readonly id: string;
  readonly from: string;
  readonly subject: string;
  readonly body: string;
  readonly label: 0 | 1 | 'm';
}

const THRESHOLDS = [0.05, 0.1, 0.15, 0.2, 0.3, 0.5] as const;
const CONCURRENCY = 4;

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

async function main(): Promise<void> {
  const setPath = arg('set');
  const outPath = arg('out');
  const maxCents = Number(arg('max-cents') ?? '10');
  if (!setPath || !outPath || !Number.isFinite(maxCents) || maxCents <= 0) {
    console.error('usage: --set <golden.jsonl> --out <report.json> [--max-cents 10]');
    process.exit(2);
  }
  const mails: GoldenMail[] = readFileSync(setPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  if (process.env.MAYBESITTER_LIVE_TRIAGE_EVAL !== '1') {
    console.log(`dry run: would score ${mails.length} mails with the Gemini header scorer, stopping at ${maxCents}¢.`);
    return;
  }

  let spentNanoUsd = 0;
  let calls = 0;
  const maxNanoUsd = maxCents * 10_000_000;
  const gemini = shareLlmProvider('triage-eval', {
    purpose: 'email_triage',
    // The configured provider through the consent gate, like every caller.
    // The owner's own mail, run by the owner's order: there is no account or
    // consent record to read, and no daily caps. The spend stop below is the cap.
    provider: consentGatedProvider('triage-eval', { consent: async () => 'granted' }),
    consent: async () => 'granted',
    reserve: async () => 'ok',
    commit: async (_uid, usage) => {
      calls += 1;
      spentNanoUsd += costNanoUsd('gemini-2.5-flash', usage);
    },
    log: () => {},
  });

  const scores = new Map<string, number | null>();
  let next = 0;
  let stopped = false;
  async function worker(): Promise<void> {
    while (next < mails.length && !stopped) {
      // Every call costs about the same, so stop one average call early.
      const average = calls === 0 ? 0 : spentNanoUsd / calls;
      if (spentNanoUsd + 2 * average > maxNanoUsd) { stopped = true; return; }
      const mail = mails[next++]!;
      // The scan never scores a reply or forward (rule 2): it is always read.
      if (isConversationReply(mail.subject)) { scores.set(mail.id, null); continue; }
      const scored = await scoreEmailRelevance('triage-eval', { from: mail.from, subject: mail.subject, body: mail.body }, {
        env: {},
        gemini,
      });
      scores.set(mail.id, scored?.probability ?? null);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const scored = mails.filter(mail => scores.has(mail.id));
  const byThreshold = THRESHOLDS.map(threshold => {
    // A null score is a full read in production (fail open), never a skip;
    // so is a reply or forward, which the scan never scores.
    const skipped = scored.filter(mail => { const p = scores.get(mail.id); return p !== null && p !== undefined && p < threshold; });
    return {
      threshold,
      skipped: skipped.length,
      skippedShare: scored.length === 0 ? 0 : Number((skipped.length / scored.length).toFixed(3)),
      missedCommitments: skipped.filter(mail => mail.label === 1).map(mail => mail.id),
      missedBorderline: skipped.filter(mail => mail.label === 'm').map(mail => mail.id),
    };
  });
  const report = {
    ranAt: new Date().toISOString(),
    scorer: 'gemini_header',
    mails: mails.length,
    scored: scored.length,
    unscored: scored.filter(mail => scores.get(mail.id) === null).length,
    alwaysReadReplies: mails.filter(mail => isConversationReply(mail.subject)).length,
    stoppedAtSpendCap: stopped,
    labels: {
      commitments: mails.filter(mail => mail.label === 1).length,
      borderline: mails.filter(mail => mail.label === 'm').length,
      none: mails.filter(mail => mail.label === 0).length,
    },
    calls,
    spentCents: nanoUsdToCents(spentNanoUsd),
    byThreshold,
    items: scored.map(mail => ({ id: mail.id, label: mail.label, score: scores.get(mail.id) })),
  };
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ...report, items: undefined }, null, 2));
}

main().catch(error => {
  console.error(`triage eval failed: ${error instanceof Error ? error.name : 'unknown'}`);
  process.exit(1);
});
