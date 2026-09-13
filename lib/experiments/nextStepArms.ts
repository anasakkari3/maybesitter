import type { Commitment, DomainState } from '../../src/domain/stateMachine';
import type {
  NextStepEvidenceContract,
  NextStepLocale,
  NextStepRecommendationContract,
} from '../../src/contracts/v1/nextStepContracts';
import { evidenceLabels as labelsFor } from '../services/nextStepEvidence';
import { NEXT_STEP_ARMS, NEXT_STEP_BASELINE_ARM, type NextStepArm } from '../../src/contracts/v1/experimentContracts';
import {
  candidatesFromDomainState,
  scoreBaselineCandidate,
  selectBaselineNextStep,
  type BaselineCandidate,
  type BaselineScore,
} from '../services/nextStepBaseline';
import { proposeNextStep } from '../services/nextStepReviewService';
import {
  buildBehaviorProfile,
  kindAffinity,
  localHour,
  preferredHours,
  profileIsUsable,
  type BehaviorProfile,
} from './behaviorProfile';
import { compareByCodePoint } from '../planning/shared/compare';

export interface ArmCandidate extends BaselineCandidate {
  kind: Commitment['kind'];
}

export interface ArmAdjustment {
  commitmentId: string;
  bonus: number;
  codes: NextStepEvidenceContract[];
}

export interface ArmSelection {
  arm: NextStepArm;
  recommendation: NextStepRecommendationContract;
  scores: BaselineScore[];
  selectedCommitmentId: string | null;
  adjustments: ArmAdjustment[];
  /** Set when an arm could not run its own logic and deliberately fell back. */
  fallbackReason: string | null;
}

export interface ArmContext {
  now: Date;
  locale: NextStepLocale;
  proposalId: string;
  timezone: string;
  /**
   * The hours this person actually keeps (UC-2.7a #167, UC-2.9 #170).
   *
   * Without it the contextual arm penalised anything suggested between 22:00
   * and 07:00 and told the user it was "outside your usual hours" — a sentence
   * about them, asserted from a constant. For somebody who works nights it was
   * simply false, and it was false in the one place the product claims to be
   * explaining itself.
   *
   * Absent means the person never answered the routine questions, and the
   * 22:00-07:00 default is used as what it is: a guess for someone who has told
   * us nothing, not a claim about them.
   */
  routine?: {
    quietHours?: { start: string; end: string } | null;
    focusWindows?: readonly { start: string; end: string }[];
  };
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const LATE_DAY_HOUR = 17;
const QUIET_HOURS_START = 22;
const QUIET_HOURS_END = 7;

/** The fallback window, for an account that never answered (see `ArmContext`). */
function isQuietHour(hour: number): boolean {
  return hour >= QUIET_HOURS_START || hour < QUIET_HOURS_END;
}

/**
 * The wall-clock minute of day in a zone.
 *
 * Separate from `localHour`, which rounds to the hour: a quiet window of
 * 22:30-07:30 cannot be evaluated from the hour alone, and truncating would
 * make the rule fire half an hour early every night.
 */
function localMinutes(now: Date, timezone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    // `en-GB` renders midnight as 24 in some engines.
    return (hour % 24) * 60 + minute;
  } catch {
    return null;
  }
}

/** "HH:MM" as minutes past midnight, or null when it is not a wall clock. */
function toMinutes(value: string): number | null {
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * Whether `minutes` falls inside a wall-clock window.
 *
 * A window whose end is not after its start spans midnight, which is the normal
 * shape for quiet hours. Reading 22:30-07:30 as an empty range instead would
 * invert the rule exactly: quiet all day, awake all night.
 */
function withinWindow(window: { start: string; end: string }, minutes: number): boolean {
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  if (start === null || end === null) return false;
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

function isQuietFor(context: ArmContext, minutes: number | null, hour: number | null): boolean {
  const quiet = context.routine?.quietHours;
  if (quiet && minutes !== null) return withinWindow(quiet, minutes);
  return hour !== null && isQuietHour(hour);
}

function inFocusWindow(context: ArmContext, minutes: number | null): boolean {
  if (minutes === null) return false;
  return (context.routine?.focusWindows ?? []).some((window) => withinWindow(window, minutes));
}

function dueWithin(candidate: BaselineCandidate, now: Date, windowMs: number): boolean {
  const raw = candidate.dueAt || candidate.remindAt;
  const parsed = raw ? Date.parse(raw) : Number.NaN;
  if (Number.isNaN(parsed)) return false;
  const delta = parsed - now.getTime();
  return delta >= 0 && delta <= windowMs;
}

function isOverdue(candidate: BaselineCandidate, now: Date): boolean {
  const raw = candidate.dueAt || candidate.remindAt;
  const parsed = raw ? Date.parse(raw) : Number.NaN;
  return !Number.isNaN(parsed) && parsed < now.getTime();
}

function shortEffort(candidate: BaselineCandidate): boolean {
  const effort = candidate.explicitEffortMinutes;
  return effort !== null && Number.isFinite(effort) && effort > 0 && effort <= 15;
}

/**
 * Context-aware deterministic rules. Same evidence and eligibility as the generic arm;
 * only the ordering among already-eligible candidates changes.
 */
function contextualAdjustment(
  candidate: ArmCandidate,
  context: ArmContext,
  hour: number | null,
  minutes: number | null = hour === null ? null : hour * 60,
): ArmAdjustment {
  const codes: NextStepEvidenceContract[] = [];
  let bonus = 0;

  if (isQuietFor(context, minutes, hour) && !isOverdue(candidate, context.now)) {
    bonus -= 2;
    codes.push({ code: 'outside_usual_hours' });
  }
  // A time the person set aside to concentrate. Only a bonus, never a penalty
  // for being outside one: most of a day is outside every focus window, and
  // penalising all of it would be a penalty on nothing in particular.
  if (inFocusWindow(context, minutes)) {
    bonus += 1;
    codes.push({ code: 'fits_focus_time' });
  }
  if (hour !== null && hour >= LATE_DAY_HOUR && shortEffort(candidate)) {
    bonus += 2;
    codes.push({ code: 'short_for_end_of_day' });
  }
  if (dueWithin(candidate, context.now, DAY_MS)) {
    bonus += 1;
    codes.push({ code: 'fits_before_due' });
  }
  return { commitmentId: candidate.commitmentId, bonus, codes };
}

/**
 * Lightweight personalization from the user's own closed-commitment counts. It layers on
 * top of the contextual rules and never uses cross-user data or a trained model.
 */
function personalizedAdjustment(
  candidate: ArmCandidate,
  context: ArmContext,
  hour: number | null,
  profile: BehaviorProfile,
  minutes: number | null = hour === null ? null : hour * 60,
): ArmAdjustment {
  const base = contextualAdjustment(candidate, context, hour, minutes);
  const codes = [...base.codes];
  let bonus = base.bonus;

  const affinity = kindAffinity(profile, candidate.kind);
  if (affinity >= 0.2) {
    bonus += 2;
    codes.push({ code: 'usually_finishes' });
  } else if (affinity <= -0.2) {
    bonus -= 1;
    codes.push({ code: 'often_set_aside' });
  }
  if (hour !== null && preferredHours(profile).includes(hour)) {
    bonus += 1;
    codes.push({ code: 'usual_productive_time' });
  }
  return { commitmentId: candidate.commitmentId, bonus, codes };
}

function baselineOrder(left: BaselineScore, right: BaselineScore): number {
  return right.latenessBand - left.latenessBand
    || right.urgencyBand - left.urgencyBand
    || right.importanceBand - left.importanceBand
    || right.effortTieBreak - left.effortTieBreak
    // Code-unit ordering, never `localeCompare` — see the note on the same fix
    // in lib/services/nextStepReviewService.ts. This is the final key of the
    // baseline order, so on a fully-tied score it alone decides the selection.
    || compareByCodePoint(left.commitmentId, right.commitmentId);
}

function explanation(labels: readonly string[]): string {
  return labels.length === 1 ? `Based on ${labels[0]}.` : `Based on ${labels.slice(0, 2).join(' and ')}.`;
}

export function selectNextStepForArm(
  arm: NextStepArm,
  candidates: readonly ArmCandidate[],
  context: ArmContext,
  profile?: BehaviorProfile,
): ArmSelection {
  const baseline = selectBaselineNextStep(candidates, context.now, context.locale, context.proposalId);
  if (arm === NEXT_STEP_BASELINE_ARM) {
    return { arm, ...baseline, adjustments: [], fallbackReason: null };
  }

  const usable = arm === 'personalized' && profile !== undefined && profileIsUsable(profile);
  const fallbackReason = arm === 'personalized' && !usable
    ? (profile === undefined ? 'no_profile' : 'insufficient_history')
    : null;

  const hour = localHour(context.now, context.timezone);
  const minutes = localMinutes(context.now, context.timezone);
  const adjustments = candidates.map((candidate) => (
    usable && profile
      ? personalizedAdjustment(candidate, context, hour, profile, minutes)
      : contextualAdjustment(candidate, context, hour, minutes)
  ));
  const bonusById = new Map(adjustments.map((adjustment) => [adjustment.commitmentId, adjustment]));
  const byId = new Map(candidates.map((candidate) => [candidate.commitmentId, candidate]));

  // Arms may only reorder candidates the generic arm already found eligible and evidenced.
  const eligible = baseline.scores.filter((score) => score.evidenceSufficient);
  const selectedScore = [...eligible].sort((left, right) => (
    (bonusById.get(right.commitmentId)?.bonus || 0) - (bonusById.get(left.commitmentId)?.bonus || 0)
      || baselineOrder(left, right)
  ))[0];
  const selected = selectedScore ? byId.get(selectedScore.commitmentId) : null;

  if (!selected || !selectedScore) {
    return { arm, ...baseline, adjustments, fallbackReason };
  }

  const armCodes = bonusById.get(selectedScore.commitmentId)?.codes || [];
  const evidenceCodes = [...selectedScore.evidenceCodes, ...armCodes];
  const recommendation = proposeNextStep(
    [{
      commitmentId: selected.commitmentId,
      title: selected.title,
      // The English summary the harness reads, built from the same codes the
      // phone will render in the user's own language.
      reason: explanation(labelsFor(evidenceCodes)),
      evidenceCodes,
      rank: 0,
    }],
    context.locale,
    context.proposalId,
  );
  return { arm, recommendation, scores: baseline.scores, selectedCommitmentId: selected.commitmentId, adjustments, fallbackReason };
}

export function armCandidatesFromDomainState(state: DomainState): ArmCandidate[] {
  return candidatesFromDomainState(state).map((candidate) => ({
    ...candidate,
    kind: state.commitments[candidate.commitmentId].kind,
  }));
}

export function selectNextStepForArmFromState(
  arm: NextStepArm,
  state: DomainState,
  context: ArmContext,
): ArmSelection {
  return selectNextStepForArm(
    arm,
    armCandidatesFromDomainState(state),
    context,
    arm === 'personalized' ? buildBehaviorProfile(state, context.timezone) : undefined,
  );
}

export { NEXT_STEP_ARMS, scoreBaselineCandidate };
