/**
 * The capture list eval (fix lane B3, QA audit de7fcb84).
 *
 * Runs each labelled capture in `evaluation-data/capture-list-suite.jsonl`
 * through the real `POST /capture` pipeline (`proposeMobileCapture`) or the
 * real share pipeline (`proposeFromShare`, plain text), and scores what came
 * back against the labels: how many commitments, which ones (by a keyword of
 * the title), the stated day and hour of each, whether an item that needs an
 * hour has a question to ask it with, whether a «و» / "and" joiner stayed at
 * the head of a title, and whether a prompt-injection line was kept out.
 *
 *   --engine rules   no model at all (MAYBESITTER_LLM_PROVIDER unset or none):
 *                    the rules path, what a capped or failed model falls to.
 *   --engine model   Gemini through `captureLlmProvider` — the consent gate,
 *                    the usage guard and the feature gate, as in production —
 *                    for one synthetic identity. Needs MAYBESITTER_LLM_PROVIDER
 *                    =gemini and Vertex credentials. Storage is in memory
 *                    (never Firestore), so nobody's consent, quota or ledger
 *                    is read or written.
 *
 * The suite is synthetic: no user's words. The report carries ids, labels and
 * counts only — never a title or any model text. The model run is paced to the
 * product's own per-minute cap (8 calls in one UTC minute) and stops before a
 * case that could take the spend past `--cap-usd`. Spend is priced at the
 * Vertex list price of gemini-2.5-flash ($0.30 / M input, $2.50 / M output);
 * a call that failed after it was sent is charged at a full batch call.
 *
 *   node --loader ./scripts/ts-resolver.mjs scripts/run-capture-list-eval.ts \
 *     --engine rules|model [--only id,id] [--limit N] [--cap-usd 0.40] \
 *     [--report evaluation-reports/capture-list-eval-<engine>.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
// Every environment value below is read when a call is made, not when a
// module loads, so these imports may come first.
import { configuredProviderName } from '../src/extraction/llm';
import { proposeMobileCapture } from '../lib/services/mobile/mobileCaptureService';
import { proposeFromShare } from '../lib/services/share/shareIntakeService';
import { splitCaptureClauses } from '../src/extraction/clauseSplitter';
import { localTimeSpecFor } from '../src/extraction/timeLexicon';
import { getStorage, userDoc } from '../lib/storage/index';
import { newUserDocument } from '../lib/storage/userDocument';
import { createPilotTrustState } from '../lib/pilot/closedPilotControls';

const INPUT_USD_PER_M = 0.3;
const OUTPUT_USD_PER_M = 2.5;
/** A call that was sent and failed is charged as a full batch call: 3,600 in, 2,048 out. */
const FAILED_CALL_USD = (3_600 * INPUT_USD_PER_M + 2_048 * OUTPUT_USD_PER_M) / 1e6;
const MINUTE_CAP = 8;
const REFERENCE_TIME = '2026-11-12T06:00:00.000Z'; // Thursday 12 Nov 2026, 08:00 in Jerusalem.
const TIMEZONE = 'Asia/Jerusalem';
const UID = 'capture-list-eval';

interface ExpectedItem { kw: string[]; date?: string; time?: string; noLeadingJoiner?: boolean; needsQuestion?: boolean }
interface Case {
  id: string; lang: string; category: string; finding: string; path: 'capture' | 'share'; text: string;
  expect: { items: ExpectedItem[]; forbidden?: string[]; minIgnored?: number };
}
interface Item { title?: string; resolvedTime?: string | null; resolvedDate?: string; needsClarification?: boolean; clarification?: unknown }

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const engine = arg('--engine');
if (engine !== 'rules' && engine !== 'model') throw new Error('--engine rules|model');
// Memory storage only: the eval never touches Firestore.
process.env.MAYBESITTER_STORAGE_BACKEND = 'memory';
if (engine === 'rules') process.env.MAYBESITTER_LLM_PROVIDER = 'none';
// The per-minute cap is the product's; the per-day caps are lifted for this
// one synthetic identity only, so a full run is not cut short at call 60.
process.env.MAYBESITTER_LLM_MINUTE_CALL_CAP = String(MINUTE_CAP);
process.env.MAYBESITTER_LLM_DAILY_CALL_CAP = '2000';
process.env.MAYBESITTER_LLM_DAILY_TOKEN_CAP = '20000000';

if (engine === 'model' && configuredProviderName() !== 'gemini') {
  throw new Error('--engine model needs MAYBESITTER_LLM_PROVIDER=gemini and configured Vertex credentials.');
}

// The model calls, read off the product's own content-free log line.
interface CallLine { at: number; minute: string; promptTokens: number; outputTokens: number; outcome: string }
const calls: CallLine[] = [];
const realInfo = console.info.bind(console);
console.info = (...args: unknown[]) => {
  const first = args[0];
  if (typeof first === 'string' && first.includes('"event":"llm_call"')) {
    try {
      const line = JSON.parse(first) as { promptTokens: number; outputTokens: number; outcome: string };
      const now = new Date();
      calls.push({ at: now.getTime(), minute: now.toISOString().slice(0, 16), promptTokens: line.promptTokens, outputTokens: line.outputTokens, outcome: line.outcome });
    } catch {
      // not ours
    }
  }
};
// Everything else the pipeline logs stays out of the report's console.
console.warn = () => {};
console.log = () => {};
void realInfo;

const callUsd = (call: CallLine) => call.outcome === 'cost_cap' ? 0
  : call.promptTokens + call.outputTokens > 0
    ? (call.promptTokens * INPUT_USD_PER_M + call.outputTokens * OUTPUT_USD_PER_M) / 1e6
    : call.outcome === 'unavailable' ? FAILED_CALL_USD : 0;
const spent = () => calls.reduce((sum, call) => sum + callUsd(call), 0);

/** At most this many calls for one capture: its batches, plus one re-ask or repair. */
function callBound(text: string): number {
  if (engine !== 'model') return 0;
  const clauses = Math.max(1, Math.min(8, splitCaptureClauses(text).length));
  return Math.min(5, Math.ceil(clauses / 3) + 1);
}

async function paceFor(bound: number): Promise<void> {
  for (;;) {
    const minute = new Date().toISOString().slice(0, 16);
    const used = calls.filter((call) => call.minute === minute && call.outcome !== 'cost_cap').length;
    if (used + bound <= MINUTE_CAP) return;
    const next = (Math.floor(Date.now() / 60_000) + 1) * 60_000 + 1_500;
    await new Promise((resolve) => setTimeout(resolve, next - Date.now()));
  }
}

const local = (iso: string | null | undefined) => iso ? localTimeSpecFor(new Date(iso), TIMEZONE) : null;
const LEADING_JOINER = new RegExp('^(?:\u0648|and\\s|\u05D5(?=[\u05D0-\u05EA]{2,}\\s))', 'iu');

function score(entry: Case, proposal: Record<string, unknown>) {
  const items = (Array.isArray(proposal.items) ? proposal.items : []) as Item[];
  const share = proposal.share as { ignoredSegments?: number } | undefined;
  const used = new Set<number>();
  let matched = 0; let timeOk = 0; let timeTotal = 0; let dateOk = 0; let dateTotal = 0;
  let joiners = 0; let questionMissing = 0;
  for (const expected of entry.expect.items) {
    const at = items.findIndex((item, index) => !used.has(index)
      && expected.kw.some((kw) => (item.title ?? '').toLowerCase().includes(kw.toLowerCase())));
    if (expected.time) timeTotal += 1;
    if (expected.date) dateTotal += 1;
    if (at < 0) continue;
    used.add(at);
    matched += 1;
    const item = items[at]!;
    const when = local(item.resolvedTime);
    if (expected.time && when?.time === expected.time) timeOk += 1;
    if (expected.date && (when?.date ?? item.resolvedDate) === expected.date) dateOk += 1;
    if (expected.noLeadingJoiner && LEADING_JOINER.test((item.title ?? '').trim())) joiners += 1;
    if (expected.needsQuestion && !(item.needsClarification && item.clarification)) questionMissing += 1;
  }
  const noQuestion = items.filter((item) => item.needsClarification && !item.clarification).length;
  const forbiddenHits = items.filter((item) => (entry.expect.forbidden ?? [])
    .some((word) => (item.title ?? '').toLowerCase().includes(word.toLowerCase()))).length;
  const ignored = share?.ignoredSegments ?? 0;
  const ignoredOk = entry.expect.minIgnored === undefined || ignored >= entry.expect.minIgnored;
  const expectedCount = entry.expect.items.length;
  const pass = items.length === expectedCount && matched === expectedCount && timeOk === timeTotal && dateOk === dateTotal
    && joiners === 0 && questionMissing === 0 && noQuestion === 0 && forbiddenHits === 0 && ignoredOk;
  const provenance = proposal.provenance as { executedEngine?: string; fallbackUsed?: boolean; fallbackReason?: string } | undefined;
  return {
    id: entry.id, category: entry.category, finding: entry.finding, lang: entry.lang, path: entry.path,
    status: String(proposal.status ?? ''), expectedCount, gotCount: items.length, matched,
    // The day each item landed on (dates only, never a title).
    gotDates: items.map((item) => local(item.resolvedTime)?.date ?? item.resolvedDate ?? null),
    timeOk, timeTotal, dateOk, dateTotal, leadingJoiners: joiners, needsClarificationWithoutQuestion: noQuestion,
    expectedQuestionMissing: questionMissing, forbiddenHits, ignoredSegments: ignored, ignoredOk,
    executedEngine: provenance?.executedEngine ?? null, fallbackUsed: provenance?.fallbackUsed ?? null,
    // The reason code only (`llm_unavailable:<reason>`), never a message.
    fallbackReason: typeof provenance?.fallbackReason === 'string' ? provenance.fallbackReason.split(':').slice(0, 2).join(':') : null,
    pass,
  };
}

type Scored = ReturnType<typeof score> | { id: string; category: string; finding: string; lang: string; path: string; error: string; pass: false };

async function run(entry: Case): Promise<Scored> {
  try {
    const proposal = entry.path === 'share'
      ? await proposeFromShare(
        { text: entry.text, files: [], timezone: TIMEZONE, referenceTime: REFERENCE_TIME },
        { uid: UID, now: new Date(REFERENCE_TIME), reserve: async () => 'ok' as const },
      )
      : await proposeMobileCapture({ text: entry.text, referenceTime: REFERENCE_TIME, timezone: TIMEZONE }, { participantId: UID });
    return score(entry, proposal as unknown as Record<string, unknown>);
  } catch (error) {
    return { id: entry.id, category: entry.category, finding: entry.finding, lang: entry.lang, path: entry.path, error: (error as Error).name, pass: false };
  }
}

function summarize(rows: Scored[], key: 'finding' | 'category') {
  const groups = new Map<string, Scored[]>();
  for (const row of rows) groups.set(row[key], [...(groups.get(row[key]) ?? []), row]);
  return Object.fromEntries(Array.from(groups.entries()).map(([name, group]) => {
    const ok = group.filter((row): row is ReturnType<typeof score> => !('error' in row));
    const sum = (field: 'matched' | 'expectedCount' | 'timeOk' | 'timeTotal' | 'dateOk' | 'dateTotal' | 'needsClarificationWithoutQuestion') =>
      ok.reduce((total, row) => total + row[field], 0);
    return [name, {
      cases: group.length,
      passed: group.filter((row) => row.pass).length,
      exactCount: ok.filter((row) => row.gotCount === row.expectedCount).length,
      itemRecall: `${sum('matched')}/${sum('expectedCount')}`,
      timeRecall: `${sum('timeOk')}/${sum('timeTotal')}`,
      dateAccuracy: `${sum('dateOk')}/${sum('dateTotal')}`,
      needsClarificationWithoutQuestion: sum('needsClarificationWithoutQuestion'),
      errors: group.length - ok.length,
    }];
  }));
}

async function main(): Promise<void> {
  // The synthetic account's `users/{uid}` document, as authentication writes
  // it on a first request (tests/support/liveAccount.ts): in memory only.
  await getStorage().runTransaction(async (tx) => {
    tx.set(userDoc(UID), { ...newUserDocument('2020-01-01T00:00:00.000Z'), trust: createPilotTrustState(UID, '2020-01-01T00:00:00.000Z') });
  });
  const only = arg('--only')?.split(',');
  const limit = Number(arg('--limit') ?? Infinity);
  const capUsd = Number(arg('--cap-usd') ?? 0.4);
  const reportPath = arg('--report') ?? `evaluation-reports/capture-list-eval-${engine}.json`;
  const cases = readFileSync('evaluation-data/capture-list-suite.jsonl', 'utf8')
    .split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as Case)
    .filter((entry) => !only || only.includes(entry.id)).slice(0, limit);

  const rows: Scored[] = [];
  let stoppedBefore: string | null = null;
  for (const entry of cases) {
    const bound = callBound(entry.text);
    // Never start a case that could take the spend past the cap.
    if (spent() + bound * FAILED_CALL_USD > capUsd) {
      stoppedBefore = entry.id;
      break;
    }
    await paceFor(bound);
    rows.push(await run(entry));
    process.stderr.write(`${rows.length}/${cases.length} ${entry.id} ${rows.at(-1)!.pass ? 'pass' : 'FAIL'} spent=$${spent().toFixed(4)}\n`);
  }

  const made = calls.filter((call) => call.outcome !== 'cost_cap');
  const report = {
    createdAt: new Date().toISOString(),
    engine,
    referenceTime: REFERENCE_TIME,
    timezone: TIMEZONE,
    cases: rows.length,
    stoppedBefore,
    passed: rows.filter((row) => row.pass).length,
    calls: made.length,
    callsCapped: calls.length - made.length,
    callsFailed: made.filter((call) => call.outcome === 'unavailable').length,
    promptTokens: made.reduce((sum, call) => sum + call.promptTokens, 0),
    outputTokens: made.reduce((sum, call) => sum + call.outputTokens, 0),
    spentUsd: Number(spent().toFixed(4)),
    byFinding: summarize(rows, 'finding'),
    byCategory: summarize(rows, 'category'),
    rows,
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ...report, rows: undefined }, null, 2)}\n`);
}

void main();
