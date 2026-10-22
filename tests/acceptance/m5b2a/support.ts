/**
 * M5b-2a Gate B, shared harness (PLAN-M5b-2a, APPROVED at Codex review r8,
 * sha256 3a647347…; its Wire section is binding on shape). Gate author:
 * Claude, written before Task B's build. Every test must fail on the base for
 * the reason its criterion names, except the parity guards, which pin today's
 * behaviour and pass on the base by design ("parity" in the test title).
 *
 * The M5b-1 harness (real routes in-process, fake auth, memory storage, the
 * clock pinned to REFERENCE), plus the proactive loop, which every
 * /intelligence route needs. Copy belongs to the builders: only statuses,
 * error codes, ids, shapes, instants and what is persisted are asserted.
 */
import { createHash } from 'node:crypto';
import { putObservations, type StoredObservation } from '../../../lib/intelligence/observationStore.ts';
import { suggestionPath, type IntelligenceSuggestion } from '../../../lib/intelligence/proposalEngine.ts';
import { setPersonalizationConsent, PERSONALIZATION_CONSENT_VERSION } from '../../../lib/consents/personalizationConsentService.ts';
import {
  begin as beginM5b,
  end as endM5b,
  currentStorage,
  type M5bSwitches,
} from '../m5b/support.ts';
import { m5bBasisMode } from '../../../lib/release/m5bCapabilities.ts';

export * from '../m5b/support.ts';

let savedLoop: { feature: string | undefined; kill: string | undefined } | null = null;

export async function begin(switches: M5bSwitches = {}, account: { timezone?: string; locale?: string } = {}): Promise<string> {
  const uid = await beginM5b(switches, account);
  savedLoop = { feature: process.env.MAYBESITTER_FEATURE_PROACTIVE_LOOP, kill: process.env.MAYBESITTER_KILL_SWITCH_PROACTIVE_LOOP };
  process.env.MAYBESITTER_FEATURE_PROACTIVE_LOOP = 'true';
  process.env.MAYBESITTER_KILL_SWITCH_PROACTIVE_LOOP = 'false';
  return uid;
}

export function end(): void {
  if (savedLoop) {
    if (savedLoop.feature === undefined) delete process.env.MAYBESITTER_FEATURE_PROACTIVE_LOOP;
    else process.env.MAYBESITTER_FEATURE_PROACTIVE_LOOP = savedLoop.feature;
    if (savedLoop.kill === undefined) delete process.env.MAYBESITTER_KILL_SWITCH_PROACTIVE_LOOP;
    else process.env.MAYBESITTER_KILL_SWITCH_PROACTIVE_LOOP = savedLoop.kill;
    savedLoop = null;
  }
  endM5b();
}

export async function grantPersonalization(uid: string): Promise<void> {
  await setPersonalizationConsent(uid, { state: 'granted', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage: currentStorage() as any });
}

/** A tapped outcome as outcome learning stores it: source `behavior`, confirmed at write. */
export async function outcomeObservation(
  uid: string,
  evidence: string,
  sourceRef: string,
  observedAt: string = new Date().toISOString(),
): Promise<StoredObservation> {
  const [stored] = await putObservations(uid, 'behavior', sourceRef, observedAt, [{ kind: 'outcome', evidence, confidence: 1 } as any], currentStorage() as any);
  return stored!;
}

/** Any other observation (pending unless its source is self-confirmed). */
export async function observation(
  uid: string,
  source: 'manual' | 'gmail' | 'commitment' | 'memory',
  kind: string,
  evidence: string,
  sourceRef: string,
): Promise<StoredObservation> {
  const [stored] = await putObservations(uid, source, sourceRef, new Date().toISOString(), [{ kind, evidence, confidence: 0.8 } as any], currentStorage() as any);
  return stored!;
}

let suggestionSeq = 0;
/** A stored pending suggestion citing `observationIds`. */
export async function storeSuggestion(
  uid: string,
  kind: IntelligenceSuggestion['kind'],
  observationIds: string[],
  overrides: Partial<IntelligenceSuggestion> = {},
): Promise<IntelligenceSuggestion> {
  suggestionSeq += 1;
  const basisMode = m5bBasisMode();
  const suggestion: IntelligenceSuggestion = {
    id: createHash('sha256').update(`m5b2a-suggestion-${suggestionSeq}`).digest('hex'),
    kind,
    title: kind === 'question' ? 'Do you want help with mornings?' : `Suggestion ${suggestionSeq} for the week`,
    reason: 'Because of what you did',
    observationIds,
    confidence: 0.7,
    durationMinutes: kind === 'action' ? 30 : null,
    status: 'pending',
    position: suggestionSeq,
    decidedAt: null,
    linkedEntityId: null,
    generatedAt: new Date().toISOString(),
    ...(basisMode === 'on_basis' || basisMode === 'on_nobasis' ? { mode: basisMode } : {}),
    ...overrides,
  };
  await currentStorage().set(suggestionPath(uid, suggestion.id), suggestion);
  return suggestion;
}

export async function storedSuggestion(uid: string, id: string): Promise<IntelligenceSuggestion | null> {
  return currentStorage().get<IntelligenceSuggestion>(suggestionPath(uid, id));
}
