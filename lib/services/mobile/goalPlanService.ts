import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  GOAL_PLAN_CONFIRM_MAX_WRITES,
  type GoalPlan,
  type GoalPlanConfirmOutcome,
  type GoalPlanEdit,
  type GoalPlanKind,
  type GoalPlanPhase,
  type GoalPlanRhythm,
  type GoalPlanSlot,
  type GoalPlanSource,
  type GoalPlanSourceSpan,
  type GoalPlanStep,
  type GoalPlanTimes,
  type GoalPlanTimesStep,
  type GoalPlanWeeklyTiming,
  type StoredGoalPlanStatus,
} from '../../../src/contracts/v1/goalPlanContracts';
import { buildHabitDefinition, parseHabitDefinitionInput, type HabitDefinition, type HabitOccurrence } from '../../../src/contracts/v1/habitContracts';
import { GOAL_GRAPH_LINK_SCHEMA_VERSION, type GoalNodeLink } from '../../../src/contracts/v1/goalGraphContracts';
import { applyCommand, createEmptyDomainState, type Command, type DomainEvent, type DomainState } from '../../../src/domain/stateMachine';
import { toVertexSchema } from '../../../src/extraction/llm';
import { instantFromLocal } from '../../../src/extraction/timeLexicon';
import { mapExtractionToCommand } from '../../../src/extraction/mapExtractionToCommand';
import type { ExtractionResult } from '../../../src/extraction/extractionTypes';
import { namesADate, goalStepLanguageOf, templateGoalSteps } from '../../goalGraph/goalStepPlan';
import { goalNodeLinkIdFor } from '../../goalGraph/linkStore';
import { shareLlmProvider } from '../../llm/shareProvider';
import { wrapUntrustedShared } from '../share/shareTypes';
import { planningInputDigest, schedulePlan } from '../../planning/scheduler';
import type { PlanningConfig, PlanningConstraints, PlanningItem, TimeInterval } from '../../../src/contracts/v1/planningContracts';
import { composeDailyPlanRequest, addCivilDays } from '../dailyPlan/dailyPlanService';
import { localDateOf } from '../dailyPlan/planSettings';
import { readCurrentPlan } from '../dailyPlan/planRefresh';
import { DEFAULT_MOBILE_TIMEZONE } from './time';
import { readOwnedMemory, createManualMemoryIdempotent, MemoryNotFoundError } from './memoryService';
import { loadDomainState, writeDomainDiff } from './participantState';
import {
  COMMITMENTS,
  GOAL_GRAPH_LINKS,
  GOAL_LINEAGES,
  GOAL_PLAN_CLAIMS,
  GOAL_PLAN_OUTCOMES,
  GOAL_PLANS,
  GOAL_PLAN_TIMES,
  GOAL_STATEMENT_ACCEPTS,
  GOAL_STATEMENT_PREVIEWS,
  HABITS,
  HABIT_OCCURRENCES,
  MEMORY,
  docIdForKey,
  getStorage,
  requireDocId,
  userCol,
  userDoc,
  userSubDoc,
  type StorageAdapter,
  type StorageReader,
  type StorageTransaction,
} from '../../storage';
import type { UserDocument } from '../../storage/userDocument';

const CLAIM_LEASE_MS = 120_000;
const PREVIEW_TTL_MS = 30 * 60_000;
const MAX_EDITS = 60;
const MAX_REMOVED = 20;
const MAX_STEPS = 12;
const INITIAL_MODEL_MAX_STEPS = 10;
const SLOT_MINUTES = 15;

export class GoalPlanApiError extends Error {
  constructor(readonly status: number, readonly reason: string, readonly extra: Record<string, unknown> = {}) {
    super(reason);
    this.name = 'GoalPlanApiError';
  }
}

interface InternalStep extends GoalPlanStep {
  sourceSpans: GoalPlanSourceSpan[];
  inferred: boolean;
}

interface RemovedInternal {
  step: InternalStep;
  priorOrder: number;
}

interface StoredGoalPlan {
  schemaVersion: 'goal-plan-v1';
  planId: string;
  lineageId: string;
  goalId: string;
  revision: number;
  status: StoredGoalPlanStatus;
  source: GoalPlanSource;
  horizon: 'days' | 'weeks';
  language: GoalPlan['language'];
  summary: { goalText: string };
  steps: InternalStep[];
  removed: RemovedInternal[];
  editCount: number;
  anchor?: { localDate: string; timezone: string };
  pendingLaterSteps: Array<{ weekIndex: number; stepIds: string[]; weekStartsAt: string }>;
  pendingWeekStartsAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface GoalLineage {
  lineageId: string;
  state: 'active' | 'deleting';
  currentGoalId: string;
  activeDraftPlanId: string | null;
  latestConfirmedPlanId: string | null;
  updatedAt: string;
}

interface GenerationClaim {
  claimId: string;
  lineageId: string;
  goalId: string;
  idempotencyKey: string;
  replacesPlanId?: string;
  state: 'claimed' | 'done' | 'lost';
  reservedUntil: string;
  planId?: string;
  reason?: string;
}

interface StoredTimes extends GoalPlanTimes {
  lineageId: string;
  goalId: string;
  inputsDigest: string;
  invalidated: boolean;
  weekIndex?: number;
  createdAt: string;
  updatedAt: string;
}

interface StoredOutcome extends Omit<GoalPlanConfirmOutcome, 'receipt'> {
  outcomeId: string;
  lineageId: string;
  goalId: string;
  requestDigest: string;
  planId: string;
  projection: 'pending' | 'complete';
  affectedDates: string[];
  createdAt: string;
}

interface StatementPreview {
  summaryId: string;
  revision: number;
  understood: { goalText: string };
  locale: string;
  expiresAt: string | Date;
}

interface StatementAcceptReceipt {
  fingerprint: string;
  goalId: string;
  createdAt: string;
}

interface DayContext {
  date: string;
  constraints: PlanningConstraints;
  config: PlanningConfig;
}

function path(uid: string, collection: string, id: string): string {
  return userSubDoc(uid, collection, requireDocId(id));
}

function linePath(uid: string, goalId: string): string {
  return path(uid, GOAL_LINEAGES, docIdForKey(`goal-lineage:${goalId}`));
}

function planPath(uid: string, planId: string): string { return path(uid, GOAL_PLANS, planId); }
function timesPath(uid: string, timesId: string): string { return path(uid, GOAL_PLAN_TIMES, timesId); }
function outcomePath(uid: string, key: string): string { return path(uid, GOAL_PLAN_OUTCOMES, docIdForKey(`goal-plan-outcome:${key}`)); }
function claimPath(uid: string, lineageId: string): string { return path(uid, GOAL_PLAN_CLAIMS, docIdForKey(`goal-plan-claim:${lineageId}`)); }

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function apiError(status: number, reason: string, extra: Record<string, unknown> = {}): never {
  throw new GoalPlanApiError(status, reason, extra);
}

function publicPlan(stored: StoredGoalPlan): GoalPlan {
  if (stored.status === 'superseded') throw new Error('a superseded goal plan cannot be returned on the wire');
  return {
    planId: stored.planId,
    goalId: stored.goalId,
    revision: stored.revision,
    status: stored.status,
    source: stored.source,
    horizon: stored.horizon,
    language: stored.language,
    summary: stored.summary,
    steps: stored.steps.map(({ sourceSpans: _sourceSpans, inferred: _inferred, ...step }) => step),
    removedSteps: stored.removed.map(({ step }) => ({ stepId: step.stepId, title: step.title })),
  };
}

function phaseRank(phase: GoalPlanPhase): number {
  return (phase.unit === 'day' ? 0 : 10_000) + phase.index;
}

function normalizeSteps(steps: InternalStep[], previous: InternalStep[]): InternalStep[] {
  const predecessor = new Map(previous.map((step, index) => [step.stepId, previous[index - 1]?.stepId ?? null]));
  return [...steps]
    .sort((a, b) => phaseRank(a.phase) - phaseRank(b.phase) || a.order - b.order)
    .map((step, index, sorted) => ({
      ...step,
      order: index + 1,
      buildsOn: index === 0 || predecessor.get(step.stepId) !== (sorted[index - 1]?.stepId ?? null) ? null : step.buildsOn,
    }));
}

function validatePhase(value: unknown, horizon: 'days' | 'weeks'): GoalPlanPhase | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const unit = horizon === 'days' ? 'day' : 'week';
  return raw.unit === unit && Number.isInteger(raw.index) && (raw.index as number) >= 1
    ? { unit, index: raw.index as number } : null;
}

function validateRhythm(value: unknown): GoalPlanRhythm | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (!Number.isInteger(raw.timesPerWeek) || (raw.timesPerWeek as number) < 1 || (raw.timesPerWeek as number) > 7) return undefined;
  if (raw.timeOfDay !== undefined && !['morning', 'afternoon', 'evening'].includes(String(raw.timeOfDay))) return undefined;
  return { timesPerWeek: raw.timesPerWeek as number, ...(raw.timeOfDay ? { timeOfDay: raw.timeOfDay as GoalPlanRhythm['timeOfDay'] } : {}) };
}

function namesUnstatedPerson(title: string, goalText: string): boolean {
  const captures = [/(?:مع|لـ|اسأل|احكي مع)\s+([\u0621-\u064A]{2,})/g, /\b(?:with|ask|call)\s+([A-Z][a-z]{1,30})\b/g, /(?:עם|שאל(?:י)? את)\s+([\u05D0-\u05EA]{2,})/g];
  for (const pattern of captures) {
    for (const match of Array.from(title.matchAll(pattern))) if (!goalText.includes(match[1]!)) return true;
  }
  return false;
}

function validateModelPlan(raw: unknown, goalText: string): { horizon: 'days' | 'weeks'; steps: InternalStep[] } | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if ((value.horizon !== 'days' && value.horizon !== 'weeks') || !Array.isArray(value.steps)) return null;
  const horizon = value.horizon;
  const accepted: InternalStep[] = [];
  for (const candidate of value.steps.slice(0, INITIAL_MODEL_MAX_STEPS)) {
    if (!candidate || typeof candidate !== 'object') continue;
    const item = candidate as Record<string, unknown>;
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const phase = validatePhase(item.phase, horizon);
    const kind = item.kind;
    const durationMinutes = item.durationMinutes;
    if (!title || Array.from(title).length > 120 || namesADate(title) || namesUnstatedPerson(title, goalText)) continue;
    if ((kind !== 'commitment' && kind !== 'habit') || !phase || !Number.isInteger(durationMinutes)
      || (durationMinutes as number) < 5 || (durationMinutes as number) > 480) continue;
    const rhythm = kind === 'habit' ? validateRhythm(item.rhythm) : undefined;
    if (kind === 'habit' && !rhythm) continue;
    const buildsOn = item.buildsOn === null || typeof item.buildsOn === 'string' ? item.buildsOn as string | null : null;
    const expectedOutcome = item.expectedOutcome === null || typeof item.expectedOutcome === 'string'
      ? item.expectedOutcome as string | null : null;
    const spans = Array.isArray(item.sourceSpans) ? item.sourceSpans.flatMap((span): GoalPlanSourceSpan[] => {
      if (!span || typeof span !== 'object') return [];
      const s = span as Record<string, unknown>;
      return Number.isInteger(s.start) && Number.isInteger(s.end) && typeof s.text === 'string'
        && (s.start as number) >= 0 && (s.end as number) >= (s.start as number)
        && goalText.slice(s.start as number, s.end as number) === s.text
        ? [{ start: s.start as number, end: s.end as number, text: s.text }] : [];
    }) : [];
    accepted.push({
      stepId: randomUUID(), order: accepted.length + 1, phase, title, kind,
      durationMinutes: durationMinutes as number, ...(rhythm ? { rhythm } : {}), buildsOn,
      expectedOutcome, origin: 'model', sourceSpans: spans, inferred: item.inferred === true,
    });
  }
  if (accepted.length < 3) return null;
  return { horizon, steps: normalizeSteps(accepted, accepted) };
}

const MODEL_SCHEMA = {
  type: 'object', required: ['horizon', 'steps'], properties: {
    horizon: { type: 'string', enum: ['days', 'weeks'] },
    steps: { type: 'array', items: { type: 'object', required: ['title', 'kind', 'phase', 'durationMinutes', 'buildsOn', 'expectedOutcome', 'sourceSpans', 'inferred'], properties: {
      title: { type: 'string' }, kind: { type: 'string', enum: ['commitment', 'habit'] },
      phase: { type: 'object', required: ['unit', 'index'], properties: { unit: { type: 'string', enum: ['day', 'week'] }, index: { type: 'integer' } } },
      durationMinutes: { type: 'integer' }, rhythm: { type: 'object', properties: { timesPerWeek: { type: 'integer' }, timeOfDay: { type: 'string', enum: ['morning', 'afternoon', 'evening'] } } },
      buildsOn: { type: ['string', 'null'] }, expectedOutcome: { type: ['string', 'null'] },
      sourceSpans: { type: 'array', items: { type: 'object', required: ['start', 'end', 'text'], properties: { start: { type: 'integer' }, end: { type: 'integer' }, text: { type: 'string' } } } },
      inferred: { type: 'boolean' },
    } } },
  },
} as const;

async function modelPlan(uid: string, goalText: string): Promise<{ horizon: 'days' | 'weeks'; steps: InternalStep[] }> {
  try {
    const response = await shareLlmProvider(uid, { purpose: 'goal_decomposition' })({
      system: 'Turn the goal into 3 to 10 ordered concrete steps. Use relative day/week phases only. Never invent a calendar date or person. Return the requested JSON shape.',
      parts: [wrapUntrustedShared(goalText)], responseSchema: toVertexSchema(MODEL_SCHEMA), maxOutputTokens: 2_048, retry: false,
    });
    const validated = validateModelPlan(JSON.parse(response.text), goalText);
    if (!validated) apiError(422, 'no_steps');
    return validated!;
  } catch (error) {
    if (error instanceof GoalPlanApiError) throw error;
    const reason = (error as { reason?: unknown })?.reason;
    if (typeof reason === 'string' && reason.startsWith('cost_cap:')) apiError(429, 'daily_cap_reached');
    apiError(503, 'model_unavailable', { recovery: 'template' });
  }
}

function templatePlan(goalText: string, language: string): { horizon: 'weeks'; steps: InternalStep[] } {
  const steps = templateGoalSteps(goalText, goalStepLanguageOf(goalText, language)).slice(0, 3).map((step, index): InternalStep => ({
    stepId: randomUUID(), order: index + 1, phase: { unit: 'week', index: index + 1 }, title: step.title,
    kind: step.suggestedAs, durationMinutes: step.suggestedAs === 'habit' ? 30 : 20,
    ...(step.suggestedAs === 'habit' ? { rhythm: { timesPerWeek: 3 } } : {}),
    buildsOn: null, expectedOutcome: null, origin: 'template', sourceSpans: [], inferred: true,
  }));
  return { horizon: 'weeks', steps };
}

async function lineageFor(reader: StorageReader, uid: string, goalId: string): Promise<GoalLineage | null> {
  return reader.get<GoalLineage>(linePath(uid, goalId));
}

async function requireCurrentGoal(reader: StorageReader, uid: string, goalId: string): Promise<GoalLineage> {
  const lineage = await lineageFor(reader, uid, goalId);
  if (lineage?.state === 'deleting') apiError(410, 'gone');
  if (lineage && lineage.currentGoalId !== goalId) apiError(409, 'goal_superseded', { currentGoalId: lineage.currentGoalId });
  return lineage ?? { lineageId: goalId, state: 'active', currentGoalId: goalId, activeDraftPlanId: null, latestConfirmedPlanId: null, updatedAt: new Date().toISOString() };
}

async function ownedGoal(uid: string, goalId: string, storage: StorageAdapter) {
  try {
    const goal = await readOwnedMemory(uid, goalId, { storage });
    if (goal.kind !== 'goal' || goal.status !== 'active') apiError(410, 'gone');
    return goal;
  } catch (error) {
    if (error instanceof GoalPlanApiError) throw error;
    if (error instanceof MemoryNotFoundError) apiError(404, 'goal_not_found');
    throw error;
  }
}

async function waitForClaim(uid: string, lineageId: string, claimId: string, storage: StorageAdapter): Promise<StoredGoalPlan | null> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const claim = await storage.get<GenerationClaim>(claimPath(uid, lineageId));
    if (claim?.state === 'done' && claim.planId) return storage.get<StoredGoalPlan>(planPath(uid, claim.planId));
    await new Promise((resolve) => setImmediate(resolve));
  }
  return null;
}

export async function generateGoalPlan(uid: string, goalId: string, input: { idempotencyKey: string; source?: 'template' }, storage = getStorage()): Promise<GoalPlan> {
  const goal = await ownedGoal(uid, goalId, storage);
  const now = new Date();
  const nowIso = now.toISOString();
  const claim = await storage.runTransaction(async (tx) => {
    const lineage = await requireCurrentGoal(tx, uid, goalId);
    const existing = await tx.get<GenerationClaim>(claimPath(uid, lineage.lineageId));
    if (lineage.activeDraftPlanId) {
      const current = await tx.get<StoredGoalPlan>(planPath(uid, lineage.activeDraftPlanId));
      if (current) return { kind: 'existing' as const, plan: current };
    }
    if (existing?.state === 'done' && existing.planId) {
      const current = await tx.get<StoredGoalPlan>(planPath(uid, existing.planId));
      if (current) return { kind: 'existing' as const, plan: current };
    }
    if (existing?.state === 'claimed' && Date.parse(existing.reservedUntil) > now.getTime()) {
      return { kind: 'waiting' as const, claimId: existing.claimId, lineageId: lineage.lineageId };
    }
    const claimId = randomUUID();
    tx.set<GenerationClaim>(claimPath(uid, lineage.lineageId), {
      claimId, lineageId: lineage.lineageId, goalId, idempotencyKey: input.idempotencyKey,
      state: 'claimed', reservedUntil: new Date(now.getTime() + CLAIM_LEASE_MS).toISOString(),
    });
    tx.set<GoalLineage>(linePath(uid, goalId), { ...lineage, updatedAt: nowIso });
    return { kind: 'claimed' as const, claimId, lineage };
  });
  if (claim.kind === 'existing') apiError(409, 'stale', { plan: publicPlan(claim.plan) });
  if (claim.kind === 'waiting') {
    const settled = await waitForClaim(uid, claim.lineageId, claim.claimId, storage);
    if (settled) return publicPlan(settled);
    apiError(409, 'stale');
  }
  let generated: { horizon: 'days' | 'weeks'; steps: InternalStep[] };
  let source: GoalPlanSource;
  try {
    if (input.source === 'template') { generated = templatePlan(goal.content, goal.language); source = 'template'; }
    else { generated = await modelPlan(uid, goal.content); source = 'model'; }
  } catch (error) {
    await storage.runTransaction(async (tx) => {
      const active = await tx.get<GenerationClaim>(claimPath(uid, claim.lineage.lineageId));
      if (active?.claimId === claim.claimId && active.state === 'claimed') {
        tx.set<GenerationClaim>(claimPath(uid, claim.lineage.lineageId), { ...active, state: 'lost', reservedUntil: nowIso });
      }
    });
    throw error;
  }
  const planId = randomUUID();
  const stored: StoredGoalPlan = {
    schemaVersion: 'goal-plan-v1', planId, lineageId: claim.lineage.lineageId, goalId, revision: 1,
    status: 'draft', source, horizon: generated.horizon, language: goal.language,
    summary: { goalText: goal.content }, steps: generated.steps, removed: [], editCount: 0,
    pendingLaterSteps: [], createdAt: nowIso, updatedAt: nowIso,
  };
  const result = await storage.runTransaction(async (tx) => {
    const [currentClaim, lineage] = await Promise.all([
      tx.get<GenerationClaim>(claimPath(uid, claim.lineage.lineageId)),
      requireCurrentGoal(tx, uid, goalId),
    ]);
    if (!currentClaim || currentClaim.claimId !== claim.claimId || currentClaim.state !== 'claimed') return null;
    if (lineage.activeDraftPlanId) return tx.get<StoredGoalPlan>(planPath(uid, lineage.activeDraftPlanId));
    tx.set(planPath(uid, planId), stored);
    tx.set<GoalLineage>(linePath(uid, goalId), { ...lineage, activeDraftPlanId: planId, updatedAt: nowIso });
    tx.set<GenerationClaim>(claimPath(uid, lineage.lineageId), { ...currentClaim, state: 'done', planId });
    return stored;
  });
  if (!result) apiError(409, 'stale');
  return publicPlan(result!);
}

async function currentPlanForMutation(tx: StorageTransaction, uid: string, goalId: string, planId: string, allowConfirmed = false): Promise<{ lineage: GoalLineage; plan: StoredGoalPlan }> {
  const lineage = await requireCurrentGoal(tx, uid, goalId);
  const plan = await tx.get<StoredGoalPlan>(planPath(uid, planId));
  if (!plan) apiError(404, 'goal_not_found');
  if (plan.goalId !== lineage.currentGoalId) apiError(409, 'goal_superseded', { currentGoalId: lineage.currentGoalId });
  const active = lineage.activeDraftPlanId === planId || (allowConfirmed && lineage.latestConfirmedPlanId === planId);
  if (!active || plan.status === 'superseded') apiError(409, 'stale', { ...(lineage.activeDraftPlanId ? { plan: await tx.get(planPath(uid, lineage.activeDraftPlanId)) } : {}) });
  return { lineage, plan };
}

export async function readGoalPlan(uid: string, goalId: string, storage = getStorage()) {
  await ownedGoal(uid, goalId, storage);
  if (!await reconcilePendingGoalPlanProjections(uid, undefined, storage, goalId)) {
    apiError(503, 'projection_pending', { retryable: true });
  }
  const lineage = await requireCurrentGoal(storage, uid, goalId);
  const draft = lineage.activeDraftPlanId ? await storage.get<StoredGoalPlan>(planPath(uid, lineage.activeDraftPlanId)) : null;
  const confirmedPlan = lineage.latestConfirmedPlanId ? await storage.get<StoredGoalPlan>(planPath(uid, lineage.latestConfirmedPlanId)) : null;
  const links = (await storage.list<GoalNodeLink>(userCol(uid, GOAL_GRAPH_LINKS))).map((row) => row.data)
    .filter((link) => link.goalMemoryId === goalId && link.state === 'linked');
  const state = await loadDomainState(storage, uid);
  const habits = new Map((await storage.list<HabitDefinition>(userCol(uid, HABITS))).map((row) => [row.data.habitId, row.data]));
  const linkedWork = links.flatMap((link) => {
    const title = link.entityKind === 'commitment' ? state.commitments[link.entityId ?? '']?.title : habits.get(link.entityId ?? '')?.title;
    return link.entityId && title ? [{ entity: link.entityKind, id: link.entityId, title }] : [];
  });
  let confirmed = null;
  if (confirmedPlan) {
    const outcomes = (await storage.list<StoredOutcome>(userCol(uid, GOAL_PLAN_OUTCOMES))).map((row) => row.data)
      .filter((outcome) => outcome.planId === confirmedPlan.planId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    confirmed = {
      planId: confirmedPlan.planId,
      saved: outcomes.flatMap((outcome) => outcome.saved),
      pendingLater: confirmedPlan.pendingLaterSteps.map(({ weekIndex, stepIds }) => ({ weekIndex, stepIds })),
    };
  }
  return { draft: draft ? publicPlan(draft) : null, confirmed, linkedWork };
}

function validateEditableStep(step: InternalStep, horizon: 'days' | 'weeks'): boolean {
  return Array.from(step.title.trim()).length >= 1 && Array.from(step.title).length <= 120
    && Number.isInteger(step.durationMinutes) && step.durationMinutes >= 5 && step.durationMinutes <= 480
    && validatePhase(step.phase, horizon) !== null
    && (step.kind === 'commitment' || (step.kind === 'habit' && validateRhythm(step.rhythm) !== undefined));
}

export async function editGoalPlan(uid: string, goalId: string, planId: string, revision: number, op: GoalPlanEdit, storage = getStorage()): Promise<GoalPlan> {
  return storage.runTransaction(async (tx) => {
    const { plan } = await currentPlanForMutation(tx, uid, goalId, planId);
    if (plan.revision !== revision) apiError(409, 'stale', { plan: publicPlan(plan) });
    if (plan.editCount >= MAX_EDITS) apiError(422, 'too_many_edits', { plan: publicPlan(plan) });
    if (plan.status !== 'draft') apiError(409, 'stale', { plan: publicPlan(plan) });
    let steps = plan.steps.map((step) => ({ ...step }));
    let removed = plan.removed.map((entry) => ({ ...entry, step: { ...entry.step } }));
    const index = 'stepId' in op ? steps.findIndex((step) => step.stepId === op.stepId) : -1;
    if (op.op === 'reorder') {
      if (index < 0 || !Number.isInteger(op.toOrder) || op.toOrder < 1 || op.toOrder > steps.length) apiError(422, 'invalid_edit', { plan: publicPlan(plan) });
      const [moved] = steps.splice(index, 1); steps.splice(op.toOrder - 1, 0, moved!); steps = steps.map((step, i) => ({ ...step, order: i + 1 }));
    } else if (op.op === 'remove') {
      if (index < 0 || steps.length === 1) apiError(422, 'invalid_edit', { plan: publicPlan(plan) });
      const [gone] = steps.splice(index, 1); removed = [...removed, { step: gone!, priorOrder: index + 1 }].slice(-MAX_REMOVED);
    } else if (op.op === 'restore') {
      const removedIndex = removed.findIndex((entry) => entry.step.stepId === op.stepId);
      if (removedIndex < 0 || steps.length >= MAX_STEPS) apiError(422, 'invalid_edit', { plan: publicPlan(plan) });
      const [entry] = removed.splice(removedIndex, 1); steps.splice(Math.min(entry!.priorOrder - 1, steps.length), 0, entry!.step);
    } else if (op.op === 'add') {
      if (steps.length >= MAX_STEPS) apiError(422, 'invalid_edit', { plan: publicPlan(plan) });
      const phase = validatePhase(op.step.phase, plan.horizon); const rhythm = op.step.kind === 'habit' ? validateRhythm(op.step.rhythm) : undefined;
      if (!phase || (op.step.kind === 'habit' && !rhythm)) apiError(422, 'invalid_edit', { plan: publicPlan(plan) });
      const added: InternalStep = { stepId: randomUUID(), order: 1, phase, title: op.step.title.trim(), kind: op.step.kind,
        durationMinutes: op.step.durationMinutes, ...(rhythm ? { rhythm } : {}), buildsOn: null, expectedOutcome: null,
        origin: 'person', sourceSpans: [], inferred: false };
      let insertion: number;
      if (op.afterStepId === null) {
        const phaseIndexes = steps.flatMap((step, stepIndex) => isDeepStrictEqual(step.phase, phase) ? [stepIndex] : []);
        insertion = phaseIndexes.length > 0
          ? phaseIndexes[phaseIndexes.length - 1]! + 1
          : steps.findIndex((step) => phaseRank(step.phase) > phaseRank(phase));
        if (insertion < 0) insertion = steps.length;
      } else {
        const after = steps.findIndex((step) => step.stepId === op.afterStepId);
        if (after < 0 || !isDeepStrictEqual(steps[after]!.phase, phase)) apiError(422, 'invalid_edit', { plan: publicPlan(plan) });
        insertion = after + 1;
      }
      steps.splice(insertion, 0, added);
      steps = steps.map((step, stepIndex) => ({ ...step, order: stepIndex + 1 }));
    } else if (op.op === 'update') {
      if (index < 0) apiError(422, 'invalid_edit', { plan: publicPlan(plan) });
      const current = steps[index]!;
      const nextKind = op.fields.kind ?? current.kind;
      const phase = op.fields.phase === undefined ? current.phase : validatePhase(op.fields.phase, plan.horizon);
      const rhythm = nextKind === 'habit' ? validateRhythm(op.fields.rhythm ?? current.rhythm) : undefined;
      if (!phase || (nextKind === 'habit' && !rhythm)) apiError(422, 'invalid_edit', { plan: publicPlan(plan) });
      steps[index] = { ...current, ...op.fields, kind: nextKind, phase, ...(nextKind === 'habit' ? { rhythm } : { rhythm: undefined }) } as InternalStep;
    }
    steps = normalizeSteps(steps, plan.steps);
    if (steps.length < 1 || steps.length > MAX_STEPS || steps.some((step) => !validateEditableStep(step, plan.horizon))) {
      apiError(422, 'invalid_edit', { plan: publicPlan(plan) });
    }
    const next: StoredGoalPlan = { ...plan, steps, removed, revision: plan.revision + 1, editCount: plan.editCount + 1, updatedAt: new Date().toISOString() };
    tx.set(planPath(uid, planId), next);
    return publicPlan(next);
  });
}

function timezoneOf(user: Record<string, unknown> | null): string {
  return typeof user?.timezone === 'string' && user.timezone ? user.timezone : DEFAULT_MOBILE_TIMEZONE;
}

function datesFor(step: InternalStep, anchor: string): string[] {
  if (step.phase.unit === 'day') return [addCivilDays(anchor, step.phase.index - 1)];
  return Array.from({ length: 7 }, (_, index) => addCivilDays(anchor, (step.phase.index - 1) * 7 + index));
}

function isLater(step: InternalStep): boolean {
  return step.phase.unit === 'day' ? step.phase.index > 14 : step.phase.index > 2;
}

function readerAdapter(reader: StorageReader): StorageAdapter {
  const unavailable = async (): Promise<never> => { throw new Error('transaction reader is read-only'); };
  return {
    get: reader.get.bind(reader), list: reader.list.bind(reader), listGroup: reader.listGroup.bind(reader),
    set: unavailable, delete: unavailable, deleteTree: unavailable,
    runTransaction: async (fn) => fn(reader as StorageTransaction),
  };
}

async function dayContexts(reader: StorageReader, uid: string, anchor: { localDate: string; timezone: string }, dates: string[], now: string): Promise<DayContext[]> {
  const storage = readerAdapter(reader);
  const user = await reader.get<Record<string, unknown>>(userDoc(uid));
  const unique = Array.from(new Set(dates)).sort();
  const contexts: DayContext[] = [];
  for (const date of unique) {
    const request = await composeDailyPlanRequest({ uid, date, timezone: anchor.timezone, now, userDocument: user, previousBlocks: null }, { storage });
    contexts.push({ date, constraints: request.constraints, config: request.config });
  }
  return contexts;
}

function atLocal(date: string, hhmm: string, timezone: string): string | null {
  return instantFromLocal(date, hhmm, timezone)?.toISOString() ?? null;
}

function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function exactSlot(context: DayContext, step: InternalStep, start: string, timezone: string, occupied: TimeInterval[]): GoalPlanSlot | null {
  const startsAt = atLocal(context.date, start, timezone);
  if (!startsAt) return null;
  const endsAt = new Date(Date.parse(startsAt) + step.durationMinutes * 60_000).toISOString();
  const item: PlanningItem = { itemId: `goal-plan:${step.stepId}`, title: step.title, effort: { kind: 'known', minutes: step.durationMinutes },
    earliestStartAt: startsAt, deadlineAt: endsAt, priority: 1_000_000, dependsOn: [], bufferBeforeMinutes: 0, bufferAfterMinutes: 0 };
  const plan = schedulePlan({ ...context.constraints, fixedEvents: [...context.constraints.fixedEvents, ...occupied.map((interval, index) => ({ eventId: `goal-plan-held-${index}`, interval, sourceCommitmentId: null, blocking: true }))], items: [...context.constraints.items, item] }, context.config);
  const placed = plan.scheduled.find((entry) => entry.itemId === item.itemId);
  return placed && placed.interval.startsAt === startsAt && placed.interval.endsAt === endsAt ? { startsAt, endsAt } : null;
}

function candidateMinutes(step: InternalStep, now: string, date: string, timezone: string): number[] {
  const range = step.rhythm?.timeOfDay === 'morning' ? [6 * 60, 12 * 60] : step.rhythm?.timeOfDay === 'afternoon' ? [12 * 60, 17 * 60]
    : step.rhythm?.timeOfDay === 'evening' ? [17 * 60, 22 * 60] : [6 * 60, 22 * 60];
  const result: number[] = [];
  for (let minute = range[0]; minute + step.durationMinutes <= range[1]; minute += SLOT_MINUTES) {
    const instant = atLocal(date, hhmm(minute), timezone);
    if (instant && Date.parse(instant) > Date.parse(now) + 60 * 60_000) result.push(minute);
  }
  return result;
}

function commitmentCandidates(step: InternalStep, contexts: DayContext[], anchor: { timezone: string }, now: string, occupied: TimeInterval[]): GoalPlanSlot[] {
  const found: GoalPlanSlot[] = [];
  for (const context of contexts) {
    for (const minute of candidateMinutes(step, now, context.date, anchor.timezone)) {
      const slot = exactSlot(context, step, hhmm(minute), anchor.timezone, occupied);
      if (slot) found.push(slot);
      if (found.length === 4) return found;
    }
  }
  return found;
}

function weeklyCandidates(step: InternalStep, contexts: DayContext[], anchor: { timezone: string }, now: string, occupied: TimeInterval[]): GoalPlanWeeklyTiming[] {
  const needed = step.rhythm?.timesPerWeek ?? 1;
  const found: GoalPlanWeeklyTiming[] = [];
  const seedDate = contexts[0]?.date;
  if (!seedDate) return found;
  for (const minute of candidateMinutes(step, now, seedDate, anchor.timezone)) {
    const supporting = contexts.filter((context) => exactSlot(context, step, hhmm(minute), anchor.timezone, occupied) !== null);
    if (supporting.length < needed) continue;
    found.push({ weekdays: supporting.slice(0, needed).map((context) => new Date(`${context.date}T12:00:00Z`).getUTCDay()), start: hhmm(minute), end: hhmm(minute + step.durationMinutes) });
    if (found.length === 4) break;
  }
  return found;
}

async function inputsDigest(reader: StorageReader, uid: string, anchor: { localDate: string; timezone: string }, dates: string[], now: string): Promise<string> {
  const contexts = await dayContexts(reader, uid, anchor, dates, now);
  return hash(contexts.map((context) => ({ date: context.date, digest: planningInputDigest(context.constraints, context.config) })));
}

async function buildTimes(reader: StorageReader, uid: string, plan: StoredGoalPlan, anchor: { localDate: string; timezone: string }, selected: InternalStep[], now: string, weekIndex?: number): Promise<StoredTimes> {
  const allDates = selected.flatMap((step) => datesFor(step, anchor.localDate));
  const contexts = await dayContexts(reader, uid, anchor, allDates, now);
  const occupied: TimeInterval[] = [];
  const entries: GoalPlanTimesStep[] = [];
  for (const step of selected) {
    if (!weekIndex && isLater(step)) { entries.push({ stepId: step.stepId, kind: step.kind, later: { weekIndex: step.phase.index } }); continue; }
    const own = contexts.filter((context) => datesFor(step, anchor.localDate).includes(context.date));
    if (step.kind === 'commitment') {
      const candidates = commitmentCandidates(step, own, anchor, now, occupied);
      const slot = candidates[0] ?? null;
      if (slot) occupied.push(slot);
      entries.push({ stepId: step.stepId, kind: 'commitment', slot, alternatives: candidates.slice(1, 4), ...(slot ? {} : { reason: 'no_free_time_in_phase' }), choice: 'proposed' });
    } else {
      const candidates = weeklyCandidates(step, own, anchor, now, occupied);
      const weekly = candidates[0] ?? null;
      if (weekly) {
        for (const context of own.filter((day) => weekly.weekdays.includes(new Date(`${day.date}T12:00:00Z`).getUTCDay()))) {
          const startsAt = atLocal(context.date, weekly.start, anchor.timezone)!;
          occupied.push({ startsAt, endsAt: new Date(Date.parse(startsAt) + step.durationMinutes * 60_000).toISOString() });
        }
      }
      entries.push({ stepId: step.stepId, kind: 'habit', weekly, alternatives: candidates.slice(1, 4), ...(weekly ? {} : { reason: 'no_free_time_in_phase' }), choice: 'proposed' });
    }
  }
  const relevantDates = allDates.filter((date) => Date.parse(atLocal(date, '00:00', anchor.timezone)!) < Date.parse(atLocal(addCivilDays(anchor.localDate, 14), '00:00', anchor.timezone)!) || weekIndex !== undefined);
  const nowIso = new Date().toISOString();
  return { timesId: randomUUID(), timesRevision: 1, planId: plan.planId, planRevision: plan.revision, anchor, steps: entries,
    lineageId: plan.lineageId, goalId: plan.goalId, inputsDigest: await inputsDigest(reader, uid, anchor, relevantDates, now),
    invalidated: false, ...(weekIndex ? { weekIndex } : {}), createdAt: nowIso, updatedAt: nowIso };
}

export async function approveGoalPlan(uid: string, goalId: string, planId: string, revision: number, storage = getStorage()): Promise<{ plan: GoalPlan; times: GoalPlanTimes }> {
  const now = new Date().toISOString();
  const prepared = await storage.runTransaction(async (tx) => {
    const { plan } = await currentPlanForMutation(tx, uid, goalId, planId);
    if (plan.revision !== revision) apiError(409, 'stale', { plan: publicPlan(plan) });
    if (plan.status !== 'draft') apiError(409, 'stale', { plan: publicPlan(plan) });
    const user = await tx.get<Record<string, unknown>>(userDoc(uid));
    return { plan, anchor: { localDate: localDateOf(now, timezoneOf(user)), timezone: timezoneOf(user) } };
  });
  const times = await buildTimes(storage, uid, prepared.plan, prepared.anchor, prepared.plan.steps, now);
  return storage.runTransaction(async (tx) => {
    const { plan } = await currentPlanForMutation(tx, uid, goalId, planId);
    if (plan.revision !== revision) apiError(409, 'stale', { plan: publicPlan(plan) });
    const approved: StoredGoalPlan = { ...plan, status: 'approved', anchor: prepared.anchor, updatedAt: now };
    tx.set(planPath(uid, planId), approved); tx.set(timesPath(uid, times.timesId), times);
    return { plan: publicPlan(approved), times: publicTimes(times) };
  });
}

function publicTimes(times: StoredTimes): GoalPlanTimes {
  const { lineageId: _lineage, goalId: _goal, inputsDigest: _digest, invalidated: _invalidated, weekIndex: _week, createdAt: _created, updatedAt: _updated, ...wire } = times;
  return wire;
}

function chosenIntervals(times: StoredTimes, plan: StoredGoalPlan, excludedStepId?: string): TimeInterval[] {
  const byId = new Map(plan.steps.map((step) => [step.stepId, step]));
  const intervals: TimeInterval[] = [];
  for (const entry of times.steps) {
    if (entry.stepId === excludedStepId) continue;
    if ('slot' in entry && entry.slot) intervals.push(entry.slot);
    if ('weekly' in entry && entry.weekly) {
      const step = byId.get(entry.stepId); if (!step) continue;
      for (const date of datesFor(step, times.anchor.localDate)) {
        if (!entry.weekly.weekdays.includes(new Date(`${date}T12:00:00Z`).getUTCDay())) continue;
        const startsAt = atLocal(date, entry.weekly.start, times.anchor.timezone); if (!startsAt) continue;
        intervals.push({ startsAt, endsAt: new Date(Date.parse(startsAt) + step.durationMinutes * 60_000).toISOString() });
      }
    }
  }
  return intervals;
}

function minuteOfDay(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]); const minute = Number(match[2]);
  return hour >= 0 && hour < 24 && minute >= 0 && minute < 60 ? hour * 60 + minute : null;
}

export async function chooseGoalPlanTime(uid: string, goalId: string, planId: string, stepId: string, timesRevision: number, choice: Record<string, unknown>, storage = getStorage()): Promise<GoalPlanTimes> {
  const [plan, current] = await Promise.all([
    storage.get<StoredGoalPlan>(planPath(uid, planId)),
    storage.list<StoredTimes>(userCol(uid, GOAL_PLAN_TIMES)),
  ]);
  const times = current.map((row) => row.data).filter((row) => row.planId === planId && !row.invalidated).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!plan || !times) apiError(404, 'goal_not_found');
  await requireCurrentGoal(storage, uid, goalId);
  if (times.timesRevision !== timesRevision) apiError(409, 'stale', { times: publicTimes(times) });
  const index = times.steps.findIndex((entry) => entry.stepId === stepId); const step = plan.steps.find((entry) => entry.stepId === stepId);
  if (index < 0 || !step) apiError(422, 'not_free', { times: publicTimes(times) });
  const now = new Date().toISOString();
  let replacement: GoalPlanTimesStep;
  if (choice.none === true) {
    replacement = step.kind === 'commitment' ? { stepId, kind: 'commitment', slot: null, alternatives: [], choice: 'none' }
      : { stepId, kind: 'habit', weekly: null, alternatives: [], choice: 'none' };
  } else if (step.kind === 'commitment' && choice.slot && typeof choice.slot === 'object') {
    const slot = choice.slot as GoalPlanSlot;
    if (Date.parse(slot.startsAt) <= Date.parse(now)) apiError(422, 'slot_in_past', { times: publicTimes(times) });
    const date = localDateOf(slot.startsAt, times.anchor.timezone);
    const contexts = await dayContexts(storage, uid, times.anchor, [date], now);
    const other = chosenIntervals(times, plan, stepId);
    const exact = contexts[0] && exactSlot(contexts[0], step, `${new Date(slot.startsAt).toLocaleTimeString('en-GB', { timeZone: times.anchor.timezone, hour: '2-digit', minute: '2-digit', hour12: false })}`, times.anchor.timezone, other);
    if (!exact || !isDeepStrictEqual(exact, slot)) apiError(422, 'not_free', { times: publicTimes(times) });
    replacement = { stepId, kind: 'commitment', slot, alternatives: [], choice: 'proposed' };
  } else if (step.kind === 'habit' && choice.weekly && typeof choice.weekly === 'object') {
    const weekly = choice.weekly as GoalPlanWeeklyTiming;
    const needed = step.rhythm?.timesPerWeek ?? 1;
    const uniqueWeekdays = Array.isArray(weekly.weekdays) ? new Set(weekly.weekdays) : new Set<number>();
    const startMinute = typeof weekly.start === 'string' ? minuteOfDay(weekly.start) : null;
    const endMinute = typeof weekly.end === 'string' ? minuteOfDay(weekly.end) : null;
    if (!Array.isArray(weekly.weekdays) || weekly.weekdays.length !== needed || uniqueWeekdays.size !== needed
      || !weekly.weekdays.every((weekday) => Number.isInteger(weekday) && weekday >= 0 && weekday <= 6)
      || startMinute === null || endMinute === null || endMinute !== startMinute + step.durationMinutes) {
      apiError(422, 'not_free', { times: publicTimes(times) });
    }
    const contexts = await dayContexts(storage, uid, times.anchor, datesFor(step, times.anchor.localDate), now);
    const selectedContexts = contexts.filter((context) => weekly.weekdays.includes(new Date(`${context.date}T12:00:00Z`).getUTCDay()));
    if (new Set(selectedContexts.map((context) => new Date(`${context.date}T12:00:00Z`).getUTCDay())).size !== needed) {
      apiError(422, 'not_free', { times: publicTimes(times) });
    }
    const firstStartsAt = selectedContexts[0] ? atLocal(selectedContexts[0].date, weekly.start, times.anchor.timezone) : null;
    if (firstStartsAt && Date.parse(firstStartsAt) <= Date.parse(now)) apiError(422, 'slot_in_past', { times: publicTimes(times) });
    const other = chosenIntervals(times, plan, stepId);
    const ok = selectedContexts.every((context) => exactSlot(context, step, weekly.start, times.anchor.timezone, other) !== null);
    if (!ok) apiError(422, 'not_free', { times: publicTimes(times) });
    replacement = { stepId, kind: 'habit', weekly, alternatives: [], choice: 'proposed' };
  } else apiError(422, 'not_free', { times: publicTimes(times) });
  return storage.runTransaction(async (tx) => {
    await currentPlanForMutation(tx, uid, goalId, planId, true);
    const latest = await tx.get<StoredTimes>(timesPath(uid, times.timesId));
    if (!latest || latest.timesRevision !== timesRevision) apiError(409, 'stale', { times: publicTimes(latest ?? times) });
    const next: StoredTimes = { ...latest, timesRevision: latest.timesRevision + 1, steps: latest.steps.map((entry) => entry.stepId === stepId ? replacement : entry), updatedAt: now };
    tx.set(timesPath(uid, next.timesId), next); return publicTimes(next);
  });
}

function commitmentCommands(step: InternalStep, entry: GoalPlanTimesStep, id: string, now: string, timezone: string): Command[] {
  const result: ExtractionResult = { type: 'task', action: step.title, title: step.title, person: null, dueAt: null, remindAt: null,
    localTimeSpec: null, timeEvidence: 'none', priority: { level: 'normal', source: 'user_explicit', pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable', category: null, categoryConfidence: 0, confidence: { overall: 1, type: 1, action: 1, time: 1, priority: 1 }, missingFields: [], ambiguityFlags: [],
    explicitReminderRequest: false, explicitPressureRequest: false, rawText: step.title, parserVersion: 'goal-plan-confirm-v1' };
  const mapped = mapExtractionToCommand(result, now);
  const draft = mapped.find((command): command is Extract<Command, { type: 'CreateDraft' }> => command.type === 'CreateDraft');
  if (!draft) throw new Error('goal-plan commitment did not map to a draft');
  const slot = 'slot' in entry ? entry.slot : null;
  const timeSpec = slot ? { kind: 'due_by' as const, dueAt: slot.startsAt, endAt: slot.endsAt, remindAt: slot.startsAt, allDay: false, timezone, windowRule: 'shift' as const }
    : { kind: 'unscheduled' as const, dueAt: null, endAt: null, remindAt: null, allDay: false, timezone };
  return [{ ...draft, commitment: { ...draft.commitment, id, timeSpec } }, { type: 'ConfirmCommitment', commitmentId: id, now }];
}

function habitFor(uid: string, goalId: string, step: InternalStep, entry: GoalPlanTimesStep, id: string, now: string): HabitDefinition {
  const weekly = 'weekly' in entry ? entry.weekly : null;
  return buildHabitDefinition(id, parseHabitDefinitionInput({ scopeId: uid, title: step.title,
    cadence: weekly ? { kind: 'weekdays', weekdays: weekly.weekdays }
      : { kind: 'weekly_count', count: step.rhythm?.timesPerWeek ?? 1 }, durationMinutes: step.durationMinutes,
    preferredWindows: weekly ? [{ start: weekly.start, end: weekly.end }] : [], flexibility: weekly ? 'protected_flexible' : 'flexible',
    recoveryPolicy: 'recover_within_period', source: 'goal_confirmed',
    confirmation: { confirmedByUserAt: now, sourceRef: goalId, acceptedSuggestedValues: true } }), now);
}

function habitOccurrences(habit: HabitDefinition, entry: GoalPlanTimesStep, anchor: { localDate: string; timezone: string }): Array<HabitOccurrence & { placement?: { startsAt: string; endsAt: string; origin: 'accepted' } }> {
  const weekly = 'weekly' in entry ? entry.weekly : null;
  const rows: Array<HabitOccurrence & { placement?: { startsAt: string; endsAt: string; origin: 'accepted' } }> = [];
  for (let index = 0; index < 14; index += 1) {
    const localDate = addCivilDays(anchor.localDate, index);
    const weekday = new Date(`${localDate}T12:00:00Z`).getUTCDay();
    if (habit.cadence.kind !== 'weekdays' || !habit.cadence.weekdays.includes(weekday)) continue;
    const occurrenceId = `${habit.habitId}.${localDate}.0`;
    const placement = weekly ? (() => { const startsAt = atLocal(localDate, weekly.start, anchor.timezone)!; return { startsAt, endsAt: new Date(Date.parse(startsAt) + habit.durationMinutes * 60_000).toISOString(), origin: 'accepted' as const }; })() : undefined;
    rows.push({ occurrenceId, habitId: habit.habitId, localDate, ordinal: 0, state: weekly ? 'scheduled' : 'pending', durationMinutes: habit.durationMinutes, recoveredFromOccurrenceId: null, ...(placement ? { placement } : {}) });
  }
  return rows;
}

async function completeProjection(uid: string, outcome: StoredOutcome, storage: StorageAdapter): Promise<boolean> {
  if (outcome.projection === 'complete') return true;
  for (const date of outcome.affectedDates) {
    let reconciled = false;
    for (let attempt = 0; attempt < 2 && !reconciled; attempt += 1) {
      try {
        const current = await readCurrentPlan(uid, date, { storage });
        void current;
        reconciled = true;
      } catch { /* retry once; the durable pending marker handles a persistent failure */ }
    }
    if (!reconciled) return false;
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await storage.runTransaction(async (tx) => {
        const current = await tx.get<StoredOutcome>(outcomePath(uid, outcome.outcomeId));
        if (current) tx.set(outcomePath(uid, outcome.outcomeId), { ...current, projection: 'complete' });
      });
      return true;
    } catch { /* retry once; otherwise leave the outcome pending */ }
  }
  return false;
}

/** Finishes M3a projections before a Today or goal-plan read exposes success. */
export async function reconcilePendingGoalPlanProjections(
  uid: string,
  date: string | undefined,
  storage = getStorage(),
  goalId?: string,
): Promise<boolean> {
  const pending = (await storage.list<StoredOutcome>(userCol(uid, GOAL_PLAN_OUTCOMES))).map((row) => row.data)
    .filter((outcome) => outcome.projection === 'pending'
      && (!date || outcome.affectedDates.includes(date))
      && (!goalId || outcome.goalId === goalId));
  for (const outcome of pending) if (!await completeProjection(uid, outcome, storage)) return false;
  return true;
}

export async function confirmGoalPlan(uid: string, goalId: string, planId: string, input: { planRevision: number; timesId: string; timesRevision: number; idempotencyKey: string }, storage = getStorage()): Promise<GoalPlanConfirmOutcome> {
  const requestDigest = hash({ planRevision: input.planRevision, timesId: input.timesId, timesRevision: input.timesRevision });
  const ids = new Map<string, string>();
  const result = await storage.runTransaction(async (tx) => {
    const replay = await tx.get<StoredOutcome>(outcomePath(uid, input.idempotencyKey));
    if (replay) {
      if (replay.requestDigest !== requestDigest) apiError(409, 'key_reused');
      return { kind: 'outcome' as const, outcome: replay, replayed: true };
    }
    const { lineage, plan } = await currentPlanForMutation(tx, uid, goalId, planId, true);
    const times = await tx.get<StoredTimes>(timesPath(uid, input.timesId));
    if (!times || times.invalidated || times.planId !== planId || times.planRevision !== input.planRevision || times.timesRevision !== input.timesRevision || plan.revision !== input.planRevision) {
      apiError(409, 'stale', { plan: publicPlan(plan) });
    }
    const relevantSteps = times.weekIndex ? plan.steps.filter((step) => step.phase.unit === 'week' && step.phase.index === times.weekIndex) : plan.steps;
    const dates = relevantSteps.filter((step) => !isLater(step) || times.weekIndex !== undefined).flatMap((step) => datesFor(step, times.anchor.localDate));
    const currentDigest = await inputsDigest(tx, uid, times.anchor, dates, new Date().toISOString());
    if (currentDigest !== times.inputsDigest) return { kind: 'changed' as const, plan, times };
    for (const entry of times.steps) {
      if ('slot' in entry && entry.slot && Date.parse(entry.slot.startsAt) <= Date.now()) return { kind: 'past' as const, times };
    }
    const [user, before] = await Promise.all([tx.get<UserDocument>(userDoc(uid)), loadDomainState(tx, uid)]);
    let candidate: DomainState = before;
    const events: DomainEvent[] = [];
    const saved: GoalPlanConfirmOutcome['saved'] = [];
    const stayed: GoalPlanConfirmOutcome['stayed'] = [];
    const affectedDates = new Set<string>();
    let plannedWrites = 5;
    for (const removed of plan.removed) stayed.push({ stepId: removed.step.stepId, title: removed.step.title, why: { kind: 'removed' } });
    for (const step of relevantSteps) {
      const entry = times.steps.find((candidateEntry) => candidateEntry.stepId === step.stepId);
      if (!entry) continue;
      if ('later' in entry) { stayed.push({ stepId: step.stepId, title: step.title, why: { kind: 'later_week', weekIndex: entry.later.weekIndex } }); continue; }
      const noRoom = ('slot' in entry && entry.slot === null && entry.choice !== 'none' && entry.reason)
        || ('weekly' in entry && entry.weekly === null && entry.choice !== 'none' && entry.reason);
      if (noRoom) { stayed.push({ stepId: step.stepId, title: step.title, why: { kind: 'no_room', reason: entry.reason! } }); continue; }
      const entityId = ids.get(step.stepId) ?? randomUUID(); ids.set(step.stepId, entityId);
      if (step.kind === 'commitment') {
        for (const command of commitmentCommands(step, entry, entityId, new Date().toISOString(), times.anchor.timezone)) {
          const transition = applyCommand(candidate, command); candidate = transition.newState; events.push(...transition.events);
        }
        const when = 'slot' in entry && entry.slot ? { kind: 'slot' as const, ...entry.slot } : { kind: 'none' as const };
        saved.push({ stepId: step.stepId, entity: 'commitment', id: entityId, title: step.title, when });
        if (when.kind === 'slot') affectedDates.add(localDateOf(when.startsAt, times.anchor.timezone));
        plannedWrites += 1;
      } else {
        const habit = habitFor(uid, goalId, step, entry, entityId, new Date().toISOString());
        const occurrences = habitOccurrences(habit, entry, times.anchor);
        tx.set(path(uid, HABITS, habit.habitId), habit);
        for (const occurrence of occurrences) { tx.set(path(uid, HABIT_OCCURRENCES, occurrence.occurrenceId), occurrence); affectedDates.add(occurrence.localDate); }
        const weekly = 'weekly' in entry ? entry.weekly : null;
        saved.push({ stepId: step.stepId, entity: 'habit', id: entityId, title: step.title,
          when: weekly ? { kind: 'weekly', weekdays: weekly.weekdays, start: weekly.start, end: weekly.end } : { kind: 'none' } });
        plannedWrites += 1 + occurrences.length;
      }
      const linkId = goalNodeLinkIdFor(goalId, `plan.${step.stepId}`);
      const link: GoalNodeLink = { schemaVersion: GOAL_GRAPH_LINK_SCHEMA_VERSION, linkId, scopeId: uid, goalMemoryId: goalId,
        nodeKey: `plan.${step.stepId}`, confirmedFromGeneration: plan.revision, entityKind: step.kind, entityId, state: 'linked',
        confirmedByUserAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      tx.set(path(uid, GOAL_GRAPH_LINKS, linkId), link); plannedWrites += 1;
    }
    if (plannedWrites > GOAL_PLAN_CONFIRM_MAX_WRITES || plannedWrites > 500) throw new Error(`goal-plan confirm write bound exceeded: ${plannedWrites}`);
    writeDomainDiff(tx, uid, before, candidate, events, user, new Date().toISOString());
    const pending = plan.pendingLaterSteps.filter((pendingWeek) => pendingWeek.weekIndex !== times.weekIndex);
    if (!times.weekIndex) {
      const grouped = new Map<number, string[]>();
      for (const entry of times.steps) if ('later' in entry) grouped.set(entry.later.weekIndex, [...(grouped.get(entry.later.weekIndex) ?? []), entry.stepId]);
      for (const [weekIndex, stepIds] of Array.from(grouped.entries())) pending.push({ weekIndex, stepIds, weekStartsAt: atLocal(addCivilDays(times.anchor.localDate, (weekIndex - 1) * 7), '00:00', times.anchor.timezone)! });
    }
    pending.sort((a, b) => a.weekStartsAt.localeCompare(b.weekStartsAt));
    const nextPlan: StoredGoalPlan = { ...plan, status: 'confirmed', removed: [], pendingLaterSteps: pending,
      ...(pending[0] ? { pendingWeekStartsAt: pending[0].weekStartsAt } : { pendingWeekStartsAt: undefined }), updatedAt: new Date().toISOString() };
    const outcomeId = input.idempotencyKey;
    const outcome: StoredOutcome = { outcomeId, lineageId: plan.lineageId, goalId, requestDigest, planId, saved, stayed,
      projection: 'pending', affectedDates: Array.from(affectedDates).sort(), createdAt: new Date().toISOString() };
    tx.set(planPath(uid, planId), nextPlan); tx.set(outcomePath(uid, input.idempotencyKey), outcome);
    tx.set<GoalLineage>(linePath(uid, goalId), { ...lineage, activeDraftPlanId: null, latestConfirmedPlanId: planId, updatedAt: new Date().toISOString() });
    return { kind: 'outcome' as const, outcome, replayed: false };
  });
  if (result.kind === 'changed') {
    const fresh = await buildTimes(storage, uid, result.plan, result.times.anchor, result.plan.steps, new Date().toISOString(), result.times.weekIndex);
    await storage.set(timesPath(uid, fresh.timesId), fresh);
    apiError(409, 'schedule_changed', { times: publicTimes(fresh) });
  }
  if (result.kind === 'past') apiError(422, 'slot_in_past', { times: publicTimes(result.times) });
  if (!await completeProjection(uid, result.outcome, storage)) {
    apiError(503, 'projection_pending', { retryable: true });
  }
  return { saved: result.outcome.saved, stayed: result.outcome.stayed, receipt: { outcomeId: result.outcome.outcomeId, replayed: result.replayed } };
}

export async function regenerateGoalPlan(uid: string, goalId: string, input: { currentPlanId: string; revision: number; idempotencyKey: string }, storage = getStorage()): Promise<GoalPlan> {
  const now = new Date(); const nowIso = now.toISOString();
  const claim = await storage.runTransaction(async (tx) => {
    const lineage = await requireCurrentGoal(tx, uid, goalId);
    const existingClaim = await tx.get<GenerationClaim>(claimPath(uid, lineage.lineageId));
    if (existingClaim?.state === 'done' && existingClaim.idempotencyKey === input.idempotencyKey
      && existingClaim.replacesPlanId === input.currentPlanId && existingClaim.planId) {
      const replacement = await tx.get<StoredGoalPlan>(planPath(uid, existingClaim.planId));
      if (replacement) return { kind: 'existing' as const, plan: replacement };
    }
    if (existingClaim?.state === 'claimed' && Date.parse(existingClaim.reservedUntil) > now.getTime()) {
      return { kind: 'waiting' as const, claimId: existingClaim.claimId, lineageId: lineage.lineageId };
    }
    const plan = await tx.get<StoredGoalPlan>(planPath(uid, input.currentPlanId));
    if (!plan) apiError(409, 'stale');
    if (plan.goalId !== lineage.currentGoalId) apiError(409, 'goal_superseded', { currentGoalId: lineage.currentGoalId });
    if (plan.status === 'confirmed') apiError(409, 'plan_confirmed');
    if (lineage.activeDraftPlanId !== input.currentPlanId || plan.status === 'superseded' || plan.revision !== input.revision) {
      apiError(409, 'stale', { plan: publicPlan(plan) });
    }
    const claimId = randomUUID();
    tx.set<GenerationClaim>(claimPath(uid, lineage.lineageId), {
      claimId, lineageId: lineage.lineageId, goalId, idempotencyKey: input.idempotencyKey,
      replacesPlanId: input.currentPlanId, state: 'claimed', reservedUntil: new Date(now.getTime() + CLAIM_LEASE_MS).toISOString(),
    });
    return { kind: 'claimed' as const, claimId, lineage, plan };
  });
  if (claim.kind === 'existing') return publicPlan(claim.plan);
  if (claim.kind === 'waiting') {
    const settled = await waitForClaim(uid, claim.lineageId, claim.claimId, storage);
    if (settled) return publicPlan(settled);
    apiError(409, 'stale');
  }
  let generated: { horizon: 'days' | 'weeks'; steps: InternalStep[] };
  try {
    generated = await modelPlan(uid, claim.plan.summary.goalText);
  } catch (error) {
    await storage.runTransaction(async (tx) => {
      const active = await tx.get<GenerationClaim>(claimPath(uid, claim.lineage.lineageId));
      if (active?.claimId === claim.claimId && active.state === 'claimed') {
        tx.set<GenerationClaim>(claimPath(uid, claim.lineage.lineageId), { ...active, state: 'lost', reservedUntil: nowIso });
      }
    });
    throw error;
  }
  const newId = randomUUID();
  const result = await storage.runTransaction(async (tx) => {
    const currentClaim = await tx.get<GenerationClaim>(claimPath(uid, claim.lineage.lineageId));
    const lineage = await requireCurrentGoal(tx, uid, goalId);
    const plan = await tx.get<StoredGoalPlan>(planPath(uid, input.currentPlanId));
    const times = await tx.list<StoredTimes>(userCol(uid, GOAL_PLAN_TIMES));
    if (!currentClaim || currentClaim.claimId !== claim.claimId || currentClaim.state !== 'claimed') return null;
    if (!plan || lineage.activeDraftPlanId !== input.currentPlanId || plan.status === 'superseded'
      || plan.status === 'confirmed' || plan.revision !== input.revision) return null;
    const replacement: StoredGoalPlan = { ...plan, planId: newId, revision: 1, status: 'draft', source: 'model', steps: generated.steps,
      horizon: generated.horizon, removed: [], editCount: 0, pendingLaterSteps: [], anchor: undefined, pendingWeekStartsAt: undefined, createdAt: nowIso, updatedAt: nowIso };
    tx.set(planPath(uid, plan.planId), { ...plan, status: 'superseded', updatedAt: nowIso });
    tx.set(planPath(uid, newId), replacement);
    for (const row of times.filter((row) => row.data.planId === plan.planId)) tx.set(timesPath(uid, row.id), { ...row.data, invalidated: true, updatedAt: nowIso });
    tx.set<GoalLineage>(linePath(uid, goalId), { ...lineage, activeDraftPlanId: newId, updatedAt: nowIso });
    tx.set<GenerationClaim>(claimPath(uid, lineage.lineageId), { ...currentClaim, state: 'done', planId: newId });
    return replacement;
  });
  if (!result) apiError(409, 'stale');
  return publicPlan(result);
}

export async function createLaterWeekTimes(uid: string, goalId: string, planId: string, weekIndex: number, storage = getStorage()): Promise<GoalPlanTimes> {
  const plan = await storage.get<StoredGoalPlan>(planPath(uid, planId));
  const lineage = await requireCurrentGoal(storage, uid, goalId);
  if (!plan || plan.status !== 'confirmed' || lineage.latestConfirmedPlanId !== planId || plan.goalId !== goalId) apiError(409, 'stale');
  const pending = plan.pendingLaterSteps.find((entry) => entry.weekIndex === weekIndex);
  if (!pending || !plan.anchor) apiError(409, 'stale');
  const selected = plan.steps.filter((step) => pending.stepIds.includes(step.stepId));
  const times = await buildTimes(storage, uid, plan, plan.anchor, selected, new Date().toISOString(), weekIndex);
  await storage.set(timesPath(uid, times.timesId), times);
  return publicTimes(times);
}

export async function listUpcomingGoalPlans(uid: string, storage = getStorage()) {
  const now = Date.now(); const low = new Date(now - 14 * 86_400_000).toISOString(); const high = new Date(now + 7 * 86_400_000).toISOString();
  const plans = await storage.list<StoredGoalPlan>(userCol(uid, GOAL_PLANS), { where: [['pendingWeekStartsAt', '>=', low], ['pendingWeekStartsAt', '<=', high]], orderBy: { field: 'pendingWeekStartsAt', direction: 'asc' }, limit: 5 });
  const withGoals = await Promise.all(plans.map(async ({ data: plan }) => {
    const goal = await storage.get<Record<string, unknown>>(userSubDoc(uid, MEMORY, plan.goalId));
    const pending = plan.pendingLaterSteps[0];
    return goal && pending ? { goalId: plan.goalId, planId: plan.planId, goalTitle: String(goal.content ?? ''), weekIndex: pending.weekIndex, weekStartsAt: pending.weekStartsAt, stepCount: pending.stepIds.length } : null;
  }));
  return withGoals.filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => a.weekStartsAt.localeCompare(b.weekStartsAt) || a.goalTitle.localeCompare(b.goalTitle)).slice(0, 5);
}

function vagueGoalQuestion(locale: unknown): string {
  const language = typeof locale === 'string' ? locale.toLowerCase().split(/[-_]/, 1)[0] : 'ar';
  if (language === 'en') return 'What do you want to change?';
  if (language === 'he') return 'מה היית רוצה לשנות?';
  return 'شو بدك يتغيّر؟';
}

function looksLikeScheduledEvent(text: string): boolean {
  const hasEventCue = /(?:موعد|دكتور|طبيب|appointment|meeting|פגישה)/i.test(text);
  if (!hasEventCue) return false;
  const hasClock = /(?:الساعة|\bat\b|בשעה)\s*\d{1,2}(?::\d{2})?|(?:^|\s)\d{1,2}:\d{2}(?=\s|$)/i.test(text);
  const hasDayWord = /(?:بكرا|غدا|غداً|اليوم|\btomorrow\b|\btoday\b|מחר|היום)/i.test(text);
  const hasWeekday = /(?:الأحد|الاحد|الإثنين|الاثنين|الثلاثاء|الأربعاء|الاربعاء|الخميس|الجمعة|السبت|\bsunday\b|\bmonday\b|\btuesday\b|\bwednesday\b|\bthursday\b|\bfriday\b|\bsaturday\b|יום\s+(?:ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת))/i.test(text);
  return hasClock || hasDayWord || hasWeekday;
}

export async function previewGoalStatement(uid: string, statement: unknown, locale: unknown, storage = getStorage()) {
  const question = vagueGoalQuestion(locale);
  if (typeof statement !== 'string' || !statement.trim()) apiError(422, 'goal_too_vague', { question });
  const text = statement.trim();
  if (looksLikeScheduledEvent(text)) {
    apiError(422, 'not_a_goal', { classification: 'event', recovery: 'capture' });
  }
  if (Array.from(text).length < 5) apiError(422, 'goal_too_vague', { question });
  const now = new Date(); const summaryId = randomUUID(); const expiresAt = new Date(now.getTime() + PREVIEW_TTL_MS).toISOString();
  const preview = { summaryId, revision: 1, understood: { goalText: text }, locale: typeof locale === 'string' ? locale : 'ar', expiresAt };
  await storage.set<StatementPreview>(path(uid, GOAL_STATEMENT_PREVIEWS, summaryId), { ...preview, expiresAt: new Date(expiresAt) });
  return preview;
}

export async function acceptGoalStatement(uid: string, input: { summaryId: string; revision: number; understood: { goalText: string }; idempotencyKey: string }, storage = getStorage()) {
  const receiptId = docIdForKey(`goal-statement-accept:${input.idempotencyKey}`); const fingerprint = hash(input);
  const receipt = await storage.get<StatementAcceptReceipt>(path(uid, GOAL_STATEMENT_ACCEPTS, receiptId));
  if (receipt) { if (receipt.fingerprint !== fingerprint) apiError(409, 'key_reused'); return { goalId: receipt.goalId }; }
  const preview = await storage.get<StatementPreview>(path(uid, GOAL_STATEMENT_PREVIEWS, input.summaryId));
  const expiresAt = preview?.expiresAt instanceof Date ? preview.expiresAt.getTime() : Date.parse(preview?.expiresAt ?? '');
  if (!preview || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) apiError(410, 'gone');
  if (preview.revision !== input.revision || !input.understood || typeof input.understood.goalText !== 'string') apiError(409, 'stale');
  const created = await createManualMemoryIdempotent(
    uid,
    { kind: 'goal', content: input.understood.goalText, language: preview.locale },
    new Date().toISOString(),
    `goal-statement:${input.idempotencyKey}`,
    { storage },
  );
  await storage.runTransaction(async (tx) => {
    const existing = await tx.get<StatementAcceptReceipt>(path(uid, GOAL_STATEMENT_ACCEPTS, receiptId));
    if (existing && existing.fingerprint !== fingerprint) apiError(409, 'key_reused');
    if (!existing) tx.set(path(uid, GOAL_STATEMENT_ACCEPTS, receiptId), { fingerprint, goalId: created.id, createdAt: new Date().toISOString() });
    tx.delete(path(uid, GOAL_STATEMENT_PREVIEWS, input.summaryId));
  });
  return { goalId: created.id };
}

export async function supersedeGoalPlanLineage(uid: string, oldGoalId: string, newGoalId: string, storage = getStorage()): Promise<void> {
  const now = new Date().toISOString();
  await storage.runTransaction(async (tx) => {
    const lineage = await lineageFor(tx, uid, oldGoalId) ?? { lineageId: oldGoalId, state: 'active' as const, currentGoalId: oldGoalId, activeDraftPlanId: null, latestConfirmedPlanId: null, updatedAt: now };
    const [plans, times, links, claims] = await Promise.all([
      tx.list<StoredGoalPlan>(userCol(uid, GOAL_PLANS)), tx.list<StoredTimes>(userCol(uid, GOAL_PLAN_TIMES)), tx.list<GoalNodeLink>(userCol(uid, GOAL_GRAPH_LINKS)),
      tx.list<GenerationClaim>(userCol(uid, GOAL_PLAN_CLAIMS)),
    ]);
    for (const row of plans.filter((row) => row.data.lineageId === lineage.lineageId)) {
      const plan = row.data;
      tx.set(planPath(uid, row.id), { ...plan, goalId: newGoalId, status: plan.status === 'confirmed' ? 'superseded' : 'superseded', pendingLaterSteps: [], pendingWeekStartsAt: undefined, updatedAt: now });
    }
    for (const row of times.filter((row) => row.data.lineageId === lineage.lineageId)) tx.set(timesPath(uid, row.id), { ...row.data, goalId: newGoalId, invalidated: true, updatedAt: now });
    for (const row of links.filter((row) => row.data.goalMemoryId === oldGoalId)) tx.set(path(uid, GOAL_GRAPH_LINKS, row.id), { ...row.data, goalMemoryId: newGoalId, updatedAt: now });
    for (const row of claims.filter((row) => row.data.lineageId === lineage.lineageId)) tx.delete(path(uid, GOAL_PLAN_CLAIMS, row.id));
    const next: GoalLineage = { ...lineage, currentGoalId: newGoalId, activeDraftPlanId: null, latestConfirmedPlanId: null, updatedAt: now };
    tx.set(linePath(uid, oldGoalId), next); tx.set(linePath(uid, newGoalId), next);
  });
}

export async function markGoalLineageDeleting(uid: string, goalId: string, storage = getStorage()): Promise<void> {
  const now = new Date().toISOString();
  await storage.runTransaction(async (tx) => {
    const lineage = await lineageFor(tx, uid, goalId) ?? { lineageId: goalId, state: 'active' as const, currentGoalId: goalId, activeDraftPlanId: null, latestConfirmedPlanId: null, updatedAt: now };
    const aliases = await tx.list<GoalLineage>(userCol(uid, GOAL_LINEAGES));
    for (const row of aliases.filter((row) => row.data.lineageId === lineage.lineageId)) tx.set(path(uid, GOAL_LINEAGES, row.id), { ...row.data, state: 'deleting', updatedAt: now });
    tx.set(linePath(uid, goalId), { ...lineage, state: 'deleting', updatedAt: now });
  });
}

export async function deleteGoalPlanLineage(uid: string, goalIds: readonly string[], storage = getStorage()): Promise<void> {
  const aliases = await storage.list<GoalLineage>(userCol(uid, GOAL_LINEAGES));
  const lineageIds = new Set(aliases.filter((row) => goalIds.includes(row.data.currentGoalId) || goalIds.includes(row.data.lineageId)).map((row) => row.data.lineageId));
  for (const id of goalIds) lineageIds.add(id);
  await storage.runTransaction(async (tx) => {
    const collections = [GOAL_PLANS, GOAL_PLAN_TIMES, GOAL_PLAN_OUTCOMES, GOAL_PLAN_CLAIMS, GOAL_LINEAGES, GOAL_GRAPH_LINKS] as const;
    const listings = await Promise.all(collections.map((collection) => tx.list<Record<string, unknown>>(userCol(uid, collection))));
    collections.forEach((collection, index) => {
      for (const row of listings[index]!) {
        const data = row.data;
        const owned = (typeof data.lineageId === 'string' && lineageIds.has(data.lineageId))
          || (typeof data.goalId === 'string' && goalIds.includes(data.goalId))
          || (typeof data.goalMemoryId === 'string' && goalIds.includes(data.goalMemoryId));
        if (owned) tx.delete(path(uid, collection, row.id));
      }
    });
    const deletedAt = new Date().toISOString();
    for (const goalId of goalIds) {
      tx.set<GoalLineage>(linePath(uid, goalId), {
        lineageId: docIdForKey(`deleted-goal-lineage:${goalId}`),
        state: 'deleting',
        currentGoalId: '',
        activeDraftPlanId: null,
        latestConfirmedPlanId: null,
        updatedAt: deletedAt,
      });
    }
  });
}

export function isPlanImperative(text: string): boolean {
  const folded = text.normalize('NFKD').replace(/[\u064B-\u065F\u0591-\u05C7]/g, '').trim().toLowerCase();
  return /^(?:ابني|اعمل|اقترح|بدي)(?:(?:لي)|(?:\s+(?:لي|الي)))?\s+خطة(?:\s|$)/.test(folded)
    || /^(?:make|build|give me)\s+(?:me\s+)?a?\s*plan\b/.test(folded)
    || /^(?:תבנה(?:\s+לי)?|תכין\s+לי)\s+תוכנית(?:\s|$)/.test(folded);
}
