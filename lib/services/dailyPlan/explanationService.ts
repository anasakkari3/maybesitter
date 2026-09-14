/**
 * Asking a model to narrate a plan, and refusing most of what it says back
 * (UC-3.10a, #194).
 *
 * ── Consent decides whether the call happens at all ──────────────
 *
 * The provider is `consentGatedProvider(uid, …)`, which reads the `aiProcessing`
 * consent *before every call* and throws `AiConsentRequiredError` instead of
 * reaching Gemini. There is deliberately no ungated provider anywhere in this
 * module: `tests/llm/providerBoundary.test.ts` enforces that for the whole
 * repository, and `tests/dailyPlan/planExplanation.test.ts` asserts the
 * stronger, behavioural half — with consent off the injected provider records
 * *zero* calls, not merely a templated answer.
 *
 * ── Why this does not reuse `captureLlmProvider` ─────────────────
 *
 * That function is the capture path's composition and hard-codes
 * `GEMINI_EXTRACTION_SCHEMA` as the response shape. A plan explanation is one
 * string, not an extraction, so it needs a different schema — and widening the
 * capture provider's seam belongs to a change that touches the capture path,
 * not to this one. What is reused instead is every *primitive* that composition
 * is built from: the same kill switch, the same cost guard, the same usage
 * commit and the same log line, in the same order.
 *
 * ── Every failure is the template ───────────────────────────────
 *
 * Consent refused, kill switch, cost cap, timeout, transport error, malformed
 * JSON, or a sentence the validator refuses: all of them produce the
 * deterministic template. The model can only ever *improve* the sentence; it
 * can never be the reason a user has no explanation.
 */
import type { Plan } from '../../../src/contracts/v1/planningContracts';
import { LLMUnavailableError, type LlmProvider } from '../../../src/extraction/llm';
import { getAiConsent } from '../../consents/aiConsentService';
import { consentGatedProvider } from '../../llm/consentGatedProvider';
import { logLlmCall, uidHash } from '../../llm/llmLog';
import { aiDisabled, commitUsage, quotaScopeFor, reserveCall } from '../../llm/usageGuard';
import type { StorageAdapter } from '../../storage';
import type { StoredExplanation } from './planStore';
import {
  explanationRejections,
  templateExplanation,
  type ExplanationFacts,
  type ExplanationRejection,
} from './explanationValidator';
import { toEpochMs, wallClockAt } from '../../planning/shared/time';

/** The issue's deadline. A morning push is not worth waiting longer for. */
export const EXPLANATION_TIMEOUT_MS = 8_000;

const PURPOSE = 'plan_explanation' as const;

/**
 * One string, and nothing else the model could smuggle out.
 *
 * A schema with a single scalar property is also what keeps the answer short
 * enough that the 400-character check is about wording rather than about a
 * model that ran away.
 */
export const PLAN_EXPLANATION_SCHEMA = Object.freeze({
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
});

const SYSTEM_PROMPT = [
  'You write one short, calm note about a day plan that has already been decided.',
  'At most three sentences, in the language named below.',
  'State only what the data says: which items were placed, at which times, and how many did not fit.',
  'Never invent a time, a title, or a count. Never judge the person. Never promise to do anything.',
  'Never claim to have saved, scheduled, created or changed anything.',
].join('\n');

const LOCALE_NAMES = { ar: 'Levantine Arabic', he: 'Hebrew', en: 'English' } as const;

function hhmm(instant: string, timezone: string): string {
  const parts = wallClockAt(toEpochMs(instant), timezone);
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

/**
 * What the model is shown.
 *
 * Item ids with their titles, placed intervals as local `HH:mm`, unscheduled
 * ids with their reason codes — and nothing else. No commitment description, no
 * person, no capture text, no uid: the account's identity is a hash on the log
 * line, and the model never sees it.
 */
export function explanationPrompt(
  plan: Plan,
  titles: ReadonlyMap<string, string>,
  timezone: string,
  locale: keyof typeof LOCALE_NAMES,
): string {
  const placed = [...plan.scheduled]
    .sort((left, right) => toEpochMs(left.interval.startsAt) - toEpochMs(right.interval.startsAt))
    .map((item) => `- ${item.itemId} "${titles.get(item.itemId) ?? ''}" ${hhmm(item.interval.startsAt, timezone)}-${hhmm(item.interval.endsAt, timezone)}`);
  const left = plan.unscheduled.map((item) => `- ${item.itemId} ${item.reason.code}`);
  return [
    `Language: ${LOCALE_NAMES[locale]}`,
    `Placed (${plan.scheduled.length}):`,
    placed.length > 0 ? placed.join('\n') : '- none',
    `Did not fit (${plan.unscheduled.length}):`,
    left.length > 0 ? left.join('\n') : '- none',
  ].join('\n');
}

export interface ExplanationDeps {
  /** Injected by tests. Production takes the configured provider through the gate. */
  provider?: LlmProvider;
  consent?: typeof getAiConsent;
  storage?: StorageAdapter;
  reserve?: typeof reserveCall;
  commit?: typeof commitUsage;
  log?: typeof logLlmCall;
  timeoutMs?: number;
  /** Injected so a test can exercise the timeout without waiting eight seconds. */
  now?: () => number;
}

export interface ExplanationOutcome {
  readonly explanation: StoredExplanation;
  /** Why the model's answer was not used, when it was not. For the log only. */
  readonly fallbackReason: string | null;
  readonly rejections: readonly ExplanationRejection[];
}

function templateOutcome(facts: ExplanationFacts, reason: string | null, rejections: readonly ExplanationRejection[] = []): ExplanationOutcome {
  return {
    explanation: { text: templateExplanation(facts), locale: facts.locale, source: 'template', validated: true },
    fallbackReason: reason,
    rejections,
  };
}

/** Rejects after `ms`, so a slow provider cannot hold the morning job open. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new LLMUnavailableError('timeout')), ms);
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function textFrom(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof (parsed as { text?: unknown }).text === 'string') {
      return (parsed as { text: string }).text.trim();
    }
  } catch {
    return null;
  }
  return null;
}

export async function explainPlan(
  uid: string,
  plan: Plan,
  titles: ReadonlyMap<string, string>,
  facts: ExplanationFacts,
  timezone: string,
  deps: ExplanationDeps = {},
): Promise<ExplanationOutcome> {
  // The kill switch first (#181): it must not cost a reservation to be off.
  if (aiDisabled()) return templateOutcome(facts, 'ai_disabled');

  const provider = consentGatedProvider(uid, {
    ...(deps.provider ? { provider: deps.provider } : {}),
    ...(deps.consent ? { consent: deps.consent } : {}),
    ...(deps.storage ? { storage: deps.storage } : {}),
  });
  if (provider.name === 'none') return templateOutcome(facts, 'provider_none');

  const log = deps.log ?? logLlmCall;
  const clock = deps.now ?? Date.now;
  const startedAt = clock();

  try {
    // Consent before cost. The gate inside `generateJson` would refuse this
    // call anyway — and it is the one that cannot be bypassed — but it refuses
    // *after* the reservation, and charging somebody's daily model budget for a
    // call their consent forbids is the wrong way round. Same order as
    // `captureLlmProvider`, for the same reason.
    if ((await (deps.consent ?? getAiConsent)(uid, deps.storage ? { storage: deps.storage } : {})) !== 'granted') {
      return templateOutcome(facts, 'consent_required');
    }

    const reservation = await (deps.reserve ?? reserveCall)(uid, PURPOSE, deps.storage ? { storage: deps.storage } : {});
    if (reservation !== 'ok') {
      const scope = quotaScopeFor(reservation);
      return templateOutcome(facts, scope ? `cost_cap:${scope}` : 'usage_guard_unavailable');
    }

    const response = await withTimeout(
      provider.generateJson({
        system: SYSTEM_PROMPT,
        user: explanationPrompt(plan, titles, timezone, facts.locale),
        responseSchema: PLAN_EXPLANATION_SCHEMA,
        purpose: PURPOSE,
        uid,
      }),
      deps.timeoutMs ?? EXPLANATION_TIMEOUT_MS,
    );
    await (deps.commit ?? commitUsage)(uid, {
      promptTokens: response.promptTokens,
      outputTokens: response.outputTokens,
    });
    log({
      event: 'llm_call',
      purpose: PURPOSE,
      provider: provider.name,
      model: response.model,
      location: process.env.MAYBESITTER_VERTEX_LOCATION ?? '',
      uidHash: uidHash(uid),
      latencyMs: response.latencyMs,
      promptTokens: response.promptTokens,
      outputTokens: response.outputTokens,
      outcome: 'ok',
    });

    const text = textFrom(response.text);
    const rejections = explanationRejections(text, facts);
    if (text === null) return templateOutcome(facts, 'malformed_answer');
    if (rejections.length > 0) return templateOutcome(facts, `rejected:${rejections.join(',')}`, rejections);
    return { explanation: { text, locale: facts.locale, source: 'model', validated: true }, fallbackReason: null, rejections: [] };
  } catch (error) {
    // Includes `AiConsentRequiredError`, which is an `LLMUnavailableError` with
    // reason `consent_required` — the account said no, and the template is what
    // it gets, with no second code path.
    const reason = error instanceof LLMUnavailableError ? error.reason : 'provider_error';
    log({
      event: 'llm_call',
      purpose: PURPOSE,
      provider: provider.name,
      model: process.env.MAYBESITTER_LLM_MODEL ?? '',
      location: process.env.MAYBESITTER_VERTEX_LOCATION ?? '',
      uidHash: uidHash(uid),
      latencyMs: clock() - startedAt,
      promptTokens: 0,
      outputTokens: 0,
      outcome: 'unavailable',
      fallbackReason: reason,
    });
    return templateOutcome(facts, reason);
  }
}
