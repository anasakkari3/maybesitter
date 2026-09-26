/**
 * Fixtures for the #526 goal execution graph tests.
 *
 * The goal is a real `RuntimeMemoryRecord` written through the real memory
 * store, not a hand-built object: the thing under test is "a goal that is
 * already stored changes nothing", and a fixture that never reached storage
 * could not be said to be stored.
 */
import { createStorageRuntimeMemoryStore } from '../../lib/runtimeMemory/runtimeMemoryStore.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import type { StorageAdapter } from '../../lib/storage/index.ts';
import type {
  MemoryLanguage,
  RuntimeMemoryRecord,
} from '../../src/contracts/v1/memoryContracts.ts';
import type {
  DecompositionModelDraft,
  DecompositionModelProvider,
} from '../../lib/decomposition/engine/modelProvider.ts';
import type { DecompositionStepProposal } from '../../src/contracts/v1/decompositionContracts.ts';
import { readRuntimeControls } from '../../src/contracts/v1/runtimeControls.ts';

export const NOW = '2026-09-22T09:00:00.000Z';
export const LATER = '2026-09-23T09:00:00.000Z';
export const OWNER = 'goalGraphOwner';
export const STRANGER = 'goalGraphStranger';

/**
 * A sentence the deterministic rules detector actually splits, so the default
 * fixture exercises the real engine rather than a stub. Verified against
 * `detectSteps`: two steps, the second temporally after the first.
 */
export const SPLITTABLE_GOAL =
  'Launch the side project: build the landing page, then set up payments, then announce it';

export interface SeededGoal {
  readonly storage: StorageAdapter;
  readonly goal: RuntimeMemoryRecord;
}

export async function seedGoal(
  content = SPLITTABLE_GOAL,
  options: { scopeId?: string; language?: MemoryLanguage; storage?: StorageAdapter } = {},
): Promise<SeededGoal> {
  const storage = options.storage ?? createMemoryStorage();
  const store = createStorageRuntimeMemoryStore(undefined, storage);
  const goal = await store.put({
    scopeId: options.scopeId ?? OWNER,
    kind: 'goal',
    content,
    language: options.language ?? 'en',
    source: 'user_stated',
    confidence: 1,
    observedAt: NOW,
    provenance: { origin: 'manual', confirmedByUserAt: NOW },
  }, NOW);
  return { storage, goal };
}

/** A span over `sourceText`, built from the text so it always round-trips. */
export function spanOf(sourceText: string, fragment: string) {
  const start = sourceText.indexOf(fragment);
  if (start < 0) throw new Error(`fixture bug: "${fragment}" is not in the source text`);
  return { start, end: start + fragment.length, text: fragment };
}

export function step(
  sourceText: string,
  stepId: string,
  fragment: string,
  overrides: Partial<DecompositionStepProposal> = {},
): DecompositionStepProposal {
  return {
    stepId,
    title: fragment,
    sourceSpans: [spanOf(sourceText, fragment)],
    inferred: false,
    dependsOn: [],
    statedTiming: null,
    statedOwner: null,
    ...overrides,
  };
}

/**
 * Decomposition is feature-flagged off by default, so a test that injects a
 * provider and does not pass these controls exercises the rules detector and
 * silently proves nothing about its own fixture.
 */
export const MODEL_ENABLED = readRuntimeControls({ MAYBESITTER_FEATURE_DECOMPOSITION: 'true' });

/** A provider that returns exactly what a test hands it. Never a real model. */
export function stubProvider(draft: DecompositionModelDraft): DecompositionModelProvider {
  return { propose: async () => draft };
}

/** The goal from the first phone run (UAT 2026-09-26, shots 72–73), verbatim. */
export const UAT_GOAL = 'أطلق تطبيقي على المتجر قبل نهاية السنة';

/**
 * What gemini-2.5-flash (Vertex, europe-west1) actually answered for
 * `UAT_GOAL` with prompt `goal-steps-v1` (before the Levantine examples of
 * round 1 — neutral formal-leaning Arabic), recorded by
 * `scripts/verify-goal-steps-live.ts` on 2026-09-26. Generation 1, then the
 * regeneration (which is shown generation 1's titles as "already suggested").
 * Verbatim model text, so a test built on it is a test of the real shape.
 *
 * Since round 3 «حدد …» is a formal marker, so G1 is the recorded *formal*
 * answer: it makes the register retry fire. The chain tests run on
 * `RECORDED_GOAL_STEPS_V4_G1`/`V4_G2` instead.
 */
export const RECORDED_GOAL_STEPS_G1 = '{"steps": [{"title": "حدد ميزات التطبيق الأساسية", "kind": "commitment", "when": "today"}, {"title": "صمم واجهة المستخدم الأولية", "kind": "commitment", "when": "this_week"}, {"title": "اكتب الكود الأساسي للتطبيق", "kind": "commitment", "when": "this_month"}, {"title": "اختبر وظائف التطبيق الرئيسية", "kind": "commitment", "when": "this_month"}, {"title": "جهز وصف التطبيق والصور", "kind": "commitment", "when": "this_month"}]}';
export const RECORDED_GOAL_STEPS_G2 = '{"steps": [{"title": "راجع متطلبات المتجر الفنية", "kind": "commitment", "when": "this_week"}, {"title": "سجل حساب مطور", "kind": "commitment", "when": "this_week"}, {"title": "جهز ملفات التطبيق للإرسال", "kind": "commitment", "when": "this_week"}, {"title": "أرسل التطبيق للمراجعة", "kind": "commitment", "when": "this_month"}, {"title": "تابع حالة المراجعة", "kind": "habit", "when": "this_month"}]}';

/**
 * The same model's answer for `UAT_GOAL` with prompt `goal-steps-v2` (CL3
 * round 1: Levantine examples), recorded verbatim on 2026-09-26. One call; no
 * formal marker, so no retry.
 */
export const RECORDED_GOAL_STEPS_V2 = '{"steps": [{"title": "شوف شو بدّك من التطبيق بالزبط", "kind": "commitment", "when": "today"}, {"title": "اعمل قائمة بالميزات الأساسية", "kind": "commitment", "when": "this_week"}, {"title": "جرّب تصمم واجهة بسيطة", "kind": "commitment", "when": "this_week"}, {"title": "اسأل حدا خبير عن رأيه", "kind": "commitment", "when": "this_month"}, {"title": "بلّش اكتب الكود الأساسي", "kind": "commitment", "when": "this_month"}]}';

/**
 * The same model's answer with prompt `goal-steps-v3` (CL3 round 2), recorded
 * verbatim on 2026-09-26: neutral written Arabic («حدد ميزات التطبيق
 * الأساسية», «ابحث عن منصات النشر المتاحة») that no marker caught at the time.
 * Round 3 catches it, so this is the answer the register retry must fire on.
 */
export const RECORDED_GOAL_STEPS_V3 = '{"steps": [{"title": "حدد ميزات التطبيق الأساسية", "kind": "commitment", "when": "today"}, {"title": "اعمل تصميم مبدئي لواجهة المستخدم", "kind": "commitment", "when": "this_week"}, {"title": "اختار اسم مناسب للتطبيق", "kind": "commitment", "when": "this_week"}, {"title": "ابحث عن منصات النشر المتاحة", "kind": "commitment", "when": "this_week"}, {"title": "شوف تطبيقات مشابهة بالسوق", "kind": "habit", "when": "this_month"}]}';

/**
 * The same model's answers with prompt `goal-steps-v4` (CL3 round 3: the
 * written to-do verbs named with their spoken replacements), recorded verbatim
 * on 2026-09-26 (`CL3-live-run-round3.txt`). Generation 1, then the
 * regeneration. One call each, no formal marker, so no retry.
 */
export const RECORDED_GOAL_STEPS_V4_G1 = '{"steps": [{"title": "شوف شو بدّك تحطّ بالتطبيق", "kind": "commitment", "when": "today"}, {"title": "اعمل قائمة بالميزات الأساسية", "kind": "commitment", "when": "this_week"}, {"title": "دوّر على مصمم واجهة مستخدم", "kind": "commitment", "when": "this_week"}, {"title": "بلّش اكتب الكود الأساسي", "kind": "commitment", "when": "this_month"}, {"title": "جرّب التطبيق على موبايلك", "kind": "commitment", "when": "this_month"}]}';
export const RECORDED_GOAL_STEPS_V4_G2 = '{"steps": [{"title": "اعمل خطة تسويق صغيرة", "kind": "commitment", "when": "this_week"}, {"title": "صوّر فيديو صغير للتطبيق", "kind": "commitment", "when": "this_week"}, {"title": "اكتب وصف حلو للتطبيق", "kind": "commitment", "when": "this_week"}, {"title": "جهّز صور حلوة للمتجر", "kind": "commitment", "when": "this_week"}, {"title": "اعمل حساب مطوّر", "kind": "commitment", "when": "this_month"}]}';
