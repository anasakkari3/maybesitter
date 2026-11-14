/**
 * The event-or-task eval (lane E1, owner decision 2026-11-13; approved at
 * 10–20¢).
 *
 * Runs each labelled capture in `evaluation-data/item-kind-suite.jsonl`
 * through the production extraction prompt and schema on Gemini, once, and
 * picks the confidence floor below which the model's answer is not stored
 * (`ITEM_KIND_MIN_CONFIDENCE`). At each candidate floor an item is decided by
 * the model when it is at least that sure, otherwise by the fallback the
 * product already has (an end the words gave, else `namesEvent` on the title).
 *
 * The two mistakes are not equal. A task read as an event leaves Today an
 * hour after its time and is lost; an event read as a task stays on Today
 * after it ends, which is what happened before lane E1. So a task read as an
 * event weighs `TASK_AS_EVENT_WEIGHT`, and the floor with the lowest weighted
 * error wins (the higher floor on a tie). Floor 1.01 — the model never
 * decides — is the baseline the report compares against.
 *
 * The suite is synthetic: no user's words. The calls go through the consent
 * gate as a synthetic identity, never a user's consent, quota or ledger, and
 * stop at `--cap-usd`. Needs MAYBESITTER_LLM_PROVIDER=gemini.
 *
 *   node --loader ./scripts/ts-resolver.mjs scripts/run-item-kind-eval.ts \
 *     [--limit N] [--cap-usd 0.20] [--report evaluation-reports/item-kind-eval.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { buildPrompt } from '../src/extraction/ollamaExtractor';
import { GEMINI_EXTRACTION_SCHEMA } from '../src/extraction/ollamaExtractionSchema';
import { validateExtractionResult } from '../src/extraction/schemaValidator';
import { namesEvent } from '../src/extraction/lexicon/eventTitles';
import { configuredProviderName } from '../src/extraction/llm';
import { consentGatedProvider } from '../lib/llm/consentGatedProvider';
import { splitPrompt } from '../lib/llm/captureProvider';

/** Vertex list price for gemini-2.5-flash, USD per million tokens (thinking is off). */
const INPUT_USD_PER_M = 0.3;
const OUTPUT_USD_PER_M = 2.5;
const TASK_AS_EVENT_WEIGHT = 3;
const FLOORS = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1.01];

interface Case { id: string; lang: string; text: string; label: 'event' | 'task'; note: string }
interface Read { id: string; label: Case['label']; itemKind: 'event' | 'task' | null; confidence: number; fallback: Case['label']; error?: string }

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const limit = Number(arg('--limit') ?? Infinity);
  const capUsd = Number(arg('--cap-usd') ?? 0.2);
  const reportPath = arg('--report') ?? 'evaluation-reports/item-kind-eval.json';
  const cases: Case[] = readFileSync('evaluation-data/item-kind-suite.jsonl', 'utf8')
    .split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as Case).slice(0, limit);

  if (configuredProviderName() !== 'gemini') {
    throw new Error('The eval needs MAYBESITTER_LLM_PROVIDER=gemini and configured Vertex credentials.');
  }
  // Through the consent gate like every caller (tests/llm/providerBoundary),
  // with consent granted only to this synthetic identity: no user's consent
  // is read or manufactured.
  const uid = 'item-kind-eval';
  const provider = consentGatedProvider(uid, { consent: async (asked) => (asked === uid ? 'granted' as const : 'declined' as const) });
  const now = new Date('2026-11-14T08:00:00.000Z');
  const context = { now, timezone: 'Asia/Jerusalem' };
  let spentUsd = 0;
  let promptTokens = 0;
  let outputTokens = 0;
  let model = '';
  const reads: Read[] = [];

  for (const item of cases) {
    if (spentUsd >= capUsd) {
      process.stdout.write(`cap reached at $${spentUsd.toFixed(4)}; stopping before ${item.id}\n`);
      break;
    }
    const { system, user } = splitPrompt(buildPrompt(item.text, context));
    try {
      const response = await provider.generateJson({
        system, user, responseSchema: GEMINI_EXTRACTION_SCHEMA, purpose: 'capture_extraction', uid,
      });
      promptTokens += response.promptTokens;
      outputTokens += response.outputTokens;
      model = response.model;
      spentUsd += (response.promptTokens * INPUT_USD_PER_M + response.outputTokens * OUTPUT_USD_PER_M) / 1e6;
      const result = validateExtractionResult(JSON.parse(response.text), item.text, context);
      const fallback = result.rangeMinutes ? 'event' : namesEvent(result.title ?? '') ? 'event' : 'task';
      reads.push({ id: item.id, label: item.label, itemKind: result.itemKind ?? null, confidence: result.itemKindConfidence ?? 0, fallback });
    } catch (error) {
      const fallback = namesEvent(item.text) ? 'event' : 'task';
      reads.push({ id: item.id, label: item.label, itemKind: null, confidence: 0, fallback, error: (error as Error).name });
    }
  }

  const floors = FLOORS.map((floor) => {
    let taskAsEvent = 0;
    let eventAsTask = 0;
    let byModel = 0;
    for (const read of reads) {
      const useModel = read.itemKind !== null && read.confidence >= floor;
      if (useModel) byModel += 1;
      const decided = useModel ? read.itemKind : read.fallback;
      if (read.label === 'task' && decided === 'event') taskAsEvent += 1;
      if (read.label === 'event' && decided === 'task') eventAsTask += 1;
    }
    return { floor, byModel, taskAsEvent, eventAsTask, weighted: taskAsEvent * TASK_AS_EVENT_WEIGHT + eventAsTask };
  });
  // 1.01 is the product before lane E1 (the model never decides): reported as
  // the baseline, never chosen, since the owner decided the model classifies.
  const candidates = floors.filter((f) => f.floor <= 1);
  const best = candidates.reduce((a, b) => (b.weighted < a.weighted || (b.weighted === a.weighted && b.floor > a.floor) ? b : a));
  const modelOnly = reads.filter((r) => r.itemKind !== null);
  const report = {
    createdAt: new Date().toISOString(),
    model,
    cases: reads.length,
    errors: reads.filter((r) => r.error).length,
    spentUsd: Number(spentUsd.toFixed(4)),
    promptTokens,
    outputTokens,
    taskAsEventWeight: TASK_AS_EVENT_WEIGHT,
    modelAccuracy: modelOnly.length ? Number((modelOnly.filter((r) => r.itemKind === r.label).length / modelOnly.length).toFixed(3)) : null,
    fallbackAccuracy: Number((reads.filter((r) => r.fallback === r.label).length / reads.length).toFixed(3)),
    floors,
    chosenFloor: best.floor,
    reads,
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ...report, reads: undefined })}\n`);
}

void main();
