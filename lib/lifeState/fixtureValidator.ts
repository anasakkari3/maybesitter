/**
 * SYNTHETIC — ENGINEERING QA ONLY — NOT HUMAN EVIDENCE
 *
 * Shape and consistency validator for the Life-State / runtime-memory fixture
 * corpus (Sprint 02, issue #11).
 *
 * The corpus is an executable specification, so its own correctness has to be
 * machine-checked: an expectation that contradicts its own input is worse than
 * no expectation at all. This validator therefore does two jobs.
 *
 *  1. Shape. Every declared value is checked against the committed contracts in
 *     src/contracts/v1 — vocabularies, ISO timestamps, ranges, required keys.
 *  2. Internal consistency. Where an expectation is *derivable* from the
 *     fixture's own input it is recomputed and compared: status tallies, open
 *     and overdue sets, busy windows, load band, window start, staleness,
 *     retrieval visibility, supersession links, prune counts.
 *
 * It deliberately does not import the LifeState projection or the runtime
 * memory store. Those are implemented in parallel under issues #9 and #10, and
 * a fixture corpus that can only be validated by the code it is meant to hold
 * to account is not a specification.
 *
 * Issue collection reuses lib/evaluation/registry/validationPrimitives rather
 * than introducing a second validation vocabulary.
 */
import type { AckState, Commitment, CommitmentStatus, DomainState } from '../../src/domain/stateMachine';
import {
  LOAD_BAND_THRESHOLDS,
  OPEN_COMMITMENT_STATUSES,
  DEFAULT_RECENT_OUTCOMES_WINDOW_DAYS,
  type AvailabilityView,
  type BusyWindow,
  type CommitmentsView,
  type FieldProvenance,
  type LoadBand,
  type LoadView,
  type RecentOutcomesView,
  type UnknownReason,
} from '../../src/contracts/v1/lifeStateContracts';
import {
  DEFAULT_MEMORY_TTL_MS,
  type ExportPolicy,
  type MemoryLanguage,
  type MemoryStatus,
  type MemorySource,
  type RuntimeMemoryKind,
} from '../../src/contracts/v1/memoryContracts';
import type { ValidationResult } from '../evaluation/registry/contracts';
import {
  IssueCollector,
  formatIssue,
  isIsoTimestamp,
  isNonEmptyString,
  isPlainObject,
} from '../evaluation/registry/validationPrimitives';
import {
  CONTEXT_CONDITIONS,
  FIXTURE_LANGUAGES,
  type ContextCondition,
} from '../../tests/fixtures/lifeStateMemoryFixtures';

/* ── Vocabularies ────────────────────────────────────────────────── */

/*
 * Each vocabulary is an exhaustive Record over the contract's union type, so
 * adding a member to a contract breaks compilation here instead of silently
 * leaving the new member unvalidated.
 */
function keysOf<T extends string>(record: Record<T, true>): readonly string[] {
  return Object.keys(record);
}

const UNKNOWN_REASONS = keysOf<UnknownReason>({
  NO_DATA: true,
  INSUFFICIENT_DATA: true,
  NOT_IMPLEMENTED: true,
});

const PROVENANCE_SOURCES = keysOf<FieldProvenance['source']>({
  domain_state: true,
  deterministic_rule: true,
  absent: true,
});

const LOAD_BANDS = keysOf<LoadBand>({ light: true, moderate: true, heavy: true, overloaded: true });

const COMMITMENT_STATUSES = keysOf<CommitmentStatus>({
  draft: true,
  needs_clarification: true,
  pending_confirmation: true,
  active: true,
  deferred: true,
  completed: true,
  dropped: true,
  missed: true,
  archived: true,
});

const ACK_STATES = keysOf<AckState>({
  not_seen: true,
  seen: true,
  aware: true,
  postponed: true,
  completed: true,
  ignored: true,
});

const MEMORY_KINDS = keysOf<RuntimeMemoryKind>({ fact: true, preference: true, hypothesis: true });
const MEMORY_SOURCES = keysOf<MemorySource>({
  user_stated: true,
  deterministic_rule: true,
  model_inferred: true,
});
const MEMORY_STATUSES = keysOf<MemoryStatus>({
  active: true,
  superseded: true,
  revoked: true,
  expired: true,
});
const EXPORT_POLICIES = keysOf<ExportPolicy>({
  personal_never_export: true,
  shareable_aggregate: true,
});

const COMMITMENTS_VIEW_KEYS = keysOf<keyof CommitmentsView>({
  countsByStatus: true,
  openCount: true,
  overdueCount: true,
  openCommitmentIds: true,
  overdueCommitmentIds: true,
});
const AVAILABILITY_VIEW_KEYS = keysOf<keyof AvailabilityView>({
  busyWindows: true,
  unscheduledCommitmentCount: true,
});
const LOAD_VIEW_KEYS = keysOf<keyof LoadView>({
  totalUrgencyScore: true,
  openCount: true,
  overdueCount: true,
  dueSoonCount: true,
  band: true,
});
const RECENT_OUTCOMES_VIEW_KEYS = keysOf<keyof RecentOutcomesView>({
  windowDays: true,
  windowStart: true,
  completedCount: true,
  postponedCount: true,
  ignoredCount: true,
  droppedCount: true,
  countsByAckState: true,
});
const BUSY_WINDOW_KEYS = keysOf<keyof BusyWindow>({
  commitmentId: true,
  startsAt: true,
  endsAt: true,
  timezone: true,
  kind: true,
});

const LIFE_STATE_FIELDS = ['commitments', 'availability', 'load', 'recentOutcomes'] as const;

/**
 * Characters that reorder or isolate bidirectional runs. Fixture text must be
 * stored in logical order, so any of these is a defect rather than content:
 * LRM, RLM, ALM, LRE, RLE, PDF, LRO, RLO, LRI, RLI, FSI, PDI.
 */
const BIDI_CONTROL_CHARACTERS = /[‎‏؜‪-‮⁦-⁩]/;
const ARABIC_SCRIPT = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const HEBREW_SCRIPT = /[֐-׿יִ-ﭏ]/;
const LATIN_SCRIPT = /[A-Za-z]/;

const DAY_MS = 24 * 60 * 60 * 1_000;

/* ── Small helpers ───────────────────────────────────────────────── */

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = new Set(a);
  if (left.size !== a.length) return false;
  return b.every((entry) => left.has(entry));
}

function describeSet(values: readonly string[]): string {
  return `[${[...values].sort().join(', ')}]`;
}

/** LOAD_BAND_THRESHOLDS is exported by the contract as bands on open count. */
export function deriveLoadBand(openCount: number): LoadBand {
  if (openCount <= LOAD_BAND_THRESHOLDS.light) return 'light';
  if (openCount <= LOAD_BAND_THRESHOLDS.moderate) return 'moderate';
  if (openCount <= LOAD_BAND_THRESHOLDS.heavy) return 'heavy';
  return 'overloaded';
}

function commitmentsOf(state: unknown): readonly Commitment[] {
  if (!isPlainObject(state)) return [];
  const commitments = state.commitments;
  if (!isPlainObject(commitments)) return [];
  return Object.values(commitments) as Commitment[];
}

function isOpen(commitment: Commitment): boolean {
  return OPEN_COMMITMENT_STATUSES.includes(commitment.status);
}

function checkText(
  issues: IssueCollector,
  path: string,
  text: string,
  language: MemoryLanguage,
): void {
  if (BIDI_CONTROL_CHARACTERS.test(text)) {
    issues.error(
      'BIDI_CONTROL_CHARACTER',
      path,
      'text contains a bidi control character; fixture text must be stored in logical order without overrides',
    );
  }
  if (text.normalize('NFC') !== text) {
    issues.error('NON_NFC_TEXT', path, 'text is not NFC-normalized, so a round trip may not be byte-identical');
  }

  const hasArabic = ARABIC_SCRIPT.test(text);
  const hasHebrew = HEBREW_SCRIPT.test(text);
  const hasLatin = LATIN_SCRIPT.test(text);

  if (language === 'ar' && (!hasArabic || hasHebrew)) {
    issues.error('LANGUAGE_SCRIPT_MISMATCH', path, 'ar text must contain Arabic script and no Hebrew script');
  }
  if (language === 'he' && (!hasHebrew || hasArabic)) {
    issues.error('LANGUAGE_SCRIPT_MISMATCH', path, 'he text must contain Hebrew script and no Arabic script');
  }
  if (language === 'en' && (hasArabic || hasHebrew)) {
    issues.error('LANGUAGE_SCRIPT_MISMATCH', path, 'en text must not contain Arabic or Hebrew script');
  }
  if (language === 'mixed' && (!(hasArabic || hasHebrew) || !hasLatin)) {
    issues.error(
      'LANGUAGE_SCRIPT_MISMATCH',
      path,
      'mixed text must contain both an RTL script and Latin script, which is the case bidi handling actually breaks on',
    );
  }
}

/* ── LifeState section ───────────────────────────────────────────── */

interface FieldContext {
  readonly issues: IssueCollector;
  readonly path: string;
  readonly now: string;
  readonly state: DomainState;
  readonly commitments: readonly Commitment[];
}

function checkProvenance(ctx: FieldContext, provenance: unknown, knownField: boolean): void {
  const path = `${ctx.path}.provenance`;
  if (!isPlainObject(provenance)) {
    ctx.issues.error('PROVENANCE_MISSING', path, 'provenance is required on every field');
    return;
  }
  const source = provenance.source;
  if (typeof source !== 'string' || !PROVENANCE_SOURCES.includes(source)) {
    ctx.issues.error('INVALID_PROVENANCE_SOURCE', path, `source ${String(source)} is outside the contract vocabulary`);
  }
  if (provenance.computedAt !== ctx.now) {
    ctx.issues.error(
      'PROVENANCE_COMPUTED_AT_MISMATCH',
      path,
      `computedAt ${String(provenance.computedAt)} must equal the fixture clock ${ctx.now}; a projection reading the system clock is not replayable`,
    );
  }
  const derivedFrom = provenance.derivedFrom;
  if (derivedFrom !== null && !isIsoTimestamp(derivedFrom)) {
    ctx.issues.error('INVALID_TIMESTAMP', `${path}.derivedFrom`, 'derivedFrom must be null or an ISO timestamp');
  }
  if (source === 'absent') {
    if (derivedFrom !== null) {
      ctx.issues.error('ABSENT_SOURCE_HAS_INPUT', path, "source 'absent' cannot name a contributing input");
    }
    if (knownField) {
      ctx.issues.error('KNOWN_FIELD_ABSENT_SOURCE', path, "a known field cannot carry source 'absent'");
    }
  }
}

function checkViewKeys(
  ctx: FieldContext,
  value: Record<string, unknown>,
  allKeys: readonly string[],
  unpinned: unknown,
): void {
  const documented = isPlainObject(unpinned) ? Object.keys(unpinned) : [];
  for (const key of Object.keys(value)) {
    if (!allKeys.includes(key)) {
      ctx.issues.error('UNKNOWN_VIEW_KEY', `${ctx.path}.value.${key}`, 'key is not part of the contract view');
    }
  }
  for (const key of allKeys) {
    if (key in value) continue;
    if (documented.includes(key)) continue;
    ctx.issues.error(
      'UNDOCUMENTED_UNPINNED_KEY',
      `${ctx.path}.value.${key}`,
      'view key is neither pinned nor listed in `unpinned` with a reason; a silently omitted expectation is a vague expectation',
    );
  }
  for (const key of documented) {
    if (key in value) {
      ctx.issues.error(
        'UNPINNED_KEY_ALSO_PINNED',
        `${ctx.path}.unpinned.${key}`,
        'key is listed as unpinned but also pinned in value',
      );
    }
    if (!allKeys.includes(key)) {
      ctx.issues.error('UNKNOWN_VIEW_KEY', `${ctx.path}.unpinned.${key}`, 'key is not part of the contract view');
    }
  }
}

function checkCommitmentsView(ctx: FieldContext, value: Record<string, unknown>): void {
  const path = `${ctx.path}.value`;
  const counts = value.countsByStatus;
  if (!isPlainObject(counts)) {
    ctx.issues.error('COMMITMENTS_COUNTS_INVALID', `${path}.countsByStatus`, 'countsByStatus must be an object');
  } else {
    for (const [status, count] of Object.entries(counts)) {
      if (!COMMITMENT_STATUSES.includes(status)) {
        ctx.issues.error('INVALID_COMMITMENT_STATUS', `${path}.countsByStatus.${status}`, 'status is outside the DomainState vocabulary');
      }
      if (!isNonNegativeInteger(count)) {
        ctx.issues.error('COMMITMENTS_COUNTS_INVALID', `${path}.countsByStatus.${status}`, 'count must be a non-negative integer');
      }
    }
    const actual: Record<string, number> = {};
    for (const commitment of ctx.commitments) {
      actual[commitment.status] = (actual[commitment.status] ?? 0) + 1;
    }
    if (JSON.stringify(actual, Object.keys(actual).sort()) !== JSON.stringify(counts, Object.keys(counts).sort())) {
      ctx.issues.error(
        'COMMITMENTS_COUNTS_MISMATCH',
        `${path}.countsByStatus`,
        `expected tally ${JSON.stringify(counts)} does not match the tally of the fixture's own DomainState ${JSON.stringify(actual)}`,
      );
    }
  }

  const expectedOpen = ctx.commitments.filter(isOpen).map((c) => c.id);
  const expectedOverdue = ctx.commitments
    .filter((c) => isOpen(c) && c.timeSpec.dueAt !== null && Date.parse(c.timeSpec.dueAt) < Date.parse(ctx.now))
    .map((c) => c.id);

  const openIds = value.openCommitmentIds;
  if (!isStringArray(openIds)) {
    ctx.issues.error('COMMITMENTS_IDS_INVALID', `${path}.openCommitmentIds`, 'must be an array of strings');
  } else if (!sameSet(openIds, expectedOpen)) {
    ctx.issues.error(
      'COMMITMENTS_OPEN_SET_MISMATCH',
      `${path}.openCommitmentIds`,
      `expected ${describeSet(openIds)} but the fixture's DomainState has open commitments ${describeSet(expectedOpen)}`,
    );
  }

  const overdueIds = value.overdueCommitmentIds;
  if (!isStringArray(overdueIds)) {
    ctx.issues.error('COMMITMENTS_IDS_INVALID', `${path}.overdueCommitmentIds`, 'must be an array of strings');
  } else if (!sameSet(overdueIds, expectedOverdue)) {
    ctx.issues.error(
      'COMMITMENTS_OVERDUE_SET_MISMATCH',
      `${path}.overdueCommitmentIds`,
      `expected ${describeSet(overdueIds)} but the fixture's DomainState has overdue commitments ${describeSet(expectedOverdue)}`,
    );
  }

  if (!isNonNegativeInteger(value.openCount) || value.openCount !== expectedOpen.length) {
    ctx.issues.error('COMMITMENTS_COUNT_MISMATCH', `${path}.openCount`, `must equal ${expectedOpen.length}`);
  }
  if (!isNonNegativeInteger(value.overdueCount) || value.overdueCount !== expectedOverdue.length) {
    ctx.issues.error('COMMITMENTS_COUNT_MISMATCH', `${path}.overdueCount`, `must equal ${expectedOverdue.length}`);
  }
}

function checkAvailabilityView(ctx: FieldContext, value: Record<string, unknown>): void {
  const path = `${ctx.path}.value`;
  const windows = value.busyWindows;
  const openCommitments = ctx.commitments.filter(isOpen);
  const expectedWindowIds = openCommitments.filter((c) => c.timeSpec.kind !== 'unscheduled').map((c) => c.id);

  if (!Array.isArray(windows)) {
    ctx.issues.error('AVAILABILITY_WINDOWS_INVALID', `${path}.busyWindows`, 'busyWindows must be an array');
  } else {
    const seen: string[] = [];
    windows.forEach((window, index) => {
      const windowPath = `${path}.busyWindows[${index}]`;
      if (!isPlainObject(window)) {
        ctx.issues.error('AVAILABILITY_WINDOWS_INVALID', windowPath, 'window must be an object');
        return;
      }
      for (const key of Object.keys(window)) {
        if (!BUSY_WINDOW_KEYS.includes(key)) {
          ctx.issues.error('UNKNOWN_VIEW_KEY', `${windowPath}.${key}`, 'key is not part of BusyWindow');
        }
      }
      const commitmentId = window.commitmentId;
      if (typeof commitmentId !== 'string') {
        ctx.issues.error('AVAILABILITY_WINDOWS_INVALID', `${windowPath}.commitmentId`, 'must be a string');
        return;
      }
      seen.push(commitmentId);
      const commitment = ctx.commitments.find((c) => c.id === commitmentId);
      if (!commitment) {
        ctx.issues.error('UNKNOWN_COMMITMENT_ID', `${windowPath}.commitmentId`, 'no such commitment in the fixture DomainState');
        return;
      }
      if (!isIsoTimestamp(window.startsAt)) {
        ctx.issues.error('INVALID_TIMESTAMP', `${windowPath}.startsAt`, 'startsAt must be an ISO timestamp');
      } else if (window.startsAt !== commitment.timeSpec.dueAt) {
        ctx.issues.error(
          'AVAILABILITY_WINDOW_MISMATCH',
          `${windowPath}.startsAt`,
          `must equal the commitment's timeSpec.dueAt ${String(commitment.timeSpec.dueAt)}`,
        );
      }
      if (window.endsAt !== null && !isIsoTimestamp(window.endsAt)) {
        ctx.issues.error('INVALID_TIMESTAMP', `${windowPath}.endsAt`, 'endsAt must be null or an ISO timestamp');
      }
      if (window.timezone !== commitment.timeSpec.timezone) {
        ctx.issues.error('AVAILABILITY_WINDOW_MISMATCH', `${windowPath}.timezone`, "must equal the commitment's timezone");
      }
      if (window.kind !== commitment.timeSpec.kind) {
        ctx.issues.error(
          'AVAILABILITY_WINDOW_MISMATCH',
          `${windowPath}.kind`,
          `must equal the commitment's timeSpec.kind ${commitment.timeSpec.kind}`,
        );
      }
    });

    if (!sameSet(seen, expectedWindowIds)) {
      ctx.issues.error(
        'AVAILABILITY_WINDOW_SET_MISMATCH',
        `${path}.busyWindows`,
        `expected windows for ${describeSet(seen)} but the fixture's open scheduled commitments are ${describeSet(expectedWindowIds)}`,
      );
    }

    for (let i = 1; i < windows.length; i += 1) {
      const previous = windows[i - 1];
      const current = windows[i];
      if (!isPlainObject(previous) || !isPlainObject(current)) continue;
      const previousKey = `${String(previous.startsAt)}|${String(previous.commitmentId)}`;
      const currentKey = `${String(current.startsAt)}|${String(current.commitmentId)}`;
      if (previousKey >= currentKey) {
        ctx.issues.error(
          'AVAILABILITY_WINDOW_ORDER',
          `${path}.busyWindows[${i}]`,
          'busyWindows must ascend by startsAt then commitmentId, which is the only deterministic order available',
        );
      }
    }
  }

  const expectedUnscheduled = openCommitments.filter((c) => c.timeSpec.kind === 'unscheduled').length;
  if (value.unscheduledCommitmentCount !== expectedUnscheduled) {
    ctx.issues.error(
      'AVAILABILITY_UNSCHEDULED_MISMATCH',
      `${path}.unscheduledCommitmentCount`,
      `must equal ${expectedUnscheduled}, the number of open commitments with no time`,
    );
  }
}

function checkLoadView(ctx: FieldContext, value: Record<string, unknown>): void {
  const path = `${ctx.path}.value`;
  const expectedOpen = ctx.commitments.filter(isOpen).length;
  const expectedOverdue = ctx.commitments.filter(
    (c) => isOpen(c) && c.timeSpec.dueAt !== null && Date.parse(c.timeSpec.dueAt) < Date.parse(ctx.now),
  ).length;

  if (value.openCount !== expectedOpen) {
    ctx.issues.error('LOAD_COUNT_MISMATCH', `${path}.openCount`, `must equal ${expectedOpen}`);
  }
  if (value.overdueCount !== expectedOverdue) {
    ctx.issues.error('LOAD_COUNT_MISMATCH', `${path}.overdueCount`, `must equal ${expectedOverdue}`);
  }

  const band = value.band;
  if (typeof band !== 'string' || !LOAD_BANDS.includes(band)) {
    ctx.issues.error('INVALID_LOAD_BAND', `${path}.band`, `band ${String(band)} is outside the contract vocabulary`);
    return;
  }
  const derived = deriveLoadBand(expectedOpen);
  if (band !== derived) {
    ctx.issues.error(
      'LOAD_BAND_MISMATCH',
      `${path}.band`,
      `band ${band} does not follow LOAD_BAND_THRESHOLDS for ${expectedOpen} open commitments (expected ${derived})`,
    );
  }
}

function checkRecentOutcomesView(
  ctx: FieldContext,
  value: Record<string, unknown>,
  windowDaysInput: number | undefined,
): void {
  const path = `${ctx.path}.value`;
  const expectedWindowDays = windowDaysInput ?? DEFAULT_RECENT_OUTCOMES_WINDOW_DAYS;
  if (value.windowDays !== expectedWindowDays) {
    ctx.issues.error('RECENT_OUTCOMES_WINDOW_MISMATCH', `${path}.windowDays`, `must equal ${expectedWindowDays}`);
  }
  const expectedStart = new Date(Date.parse(ctx.now) - expectedWindowDays * DAY_MS).toISOString();
  if (value.windowStart !== expectedStart) {
    ctx.issues.error('RECENT_OUTCOMES_WINDOW_MISMATCH', `${path}.windowStart`, `must equal ${expectedStart}`);
  }

  for (const key of ['completedCount', 'postponedCount', 'ignoredCount', 'droppedCount']) {
    if (!isNonNegativeInteger(value[key])) {
      ctx.issues.error('RECENT_OUTCOMES_COUNT_INVALID', `${path}.${key}`, 'must be a non-negative integer');
    }
  }

  const byAck = value.countsByAckState;
  if (!isPlainObject(byAck)) {
    ctx.issues.error('RECENT_OUTCOMES_ACK_INVALID', `${path}.countsByAckState`, 'must be an object');
    return;
  }
  for (const [ack, count] of Object.entries(byAck)) {
    if (!ACK_STATES.includes(ack)) {
      ctx.issues.error('INVALID_ACK_STATE', `${path}.countsByAckState.${ack}`, 'ack state is outside the DomainState vocabulary');
    }
    if (!isNonNegativeInteger(count)) {
      ctx.issues.error('RECENT_OUTCOMES_ACK_INVALID', `${path}.countsByAckState.${ack}`, 'count must be a non-negative integer');
    }
  }
  // dropped has no AckState counterpart; it is derived from the commitment status.
  for (const [scalar, ack] of [
    ['completedCount', 'completed'],
    ['postponedCount', 'postponed'],
    ['ignoredCount', 'ignored'],
  ] as const) {
    if (value[scalar] !== (byAck[ack] ?? 0)) {
      ctx.issues.error(
        'RECENT_OUTCOMES_ACK_INCONSISTENT',
        `${path}.${scalar}`,
        `must equal countsByAckState.${ack} (${String(byAck[ack] ?? 0)})`,
      );
    }
  }

  const windowStartMs = Date.parse(expectedStart);
  const nowMs = Date.parse(ctx.now);
  const inWindow = (at: string | null): boolean =>
    at !== null && Date.parse(at) >= windowStartMs && Date.parse(at) <= nowMs;
  const expectedCompleted = ctx.commitments.filter(
    (c) => c.currentAckState === 'completed' && inWindow(c.completedAt),
  ).length;
  if (value.completedCount !== expectedCompleted) {
    ctx.issues.error(
      'RECENT_OUTCOMES_COMPLETED_MISMATCH',
      `${path}.completedCount`,
      `must equal ${expectedCompleted}, the commitments completed inside the window in the fixture's own DomainState`,
    );
  }
  const expectedDropped = ctx.commitments.filter((c) => inWindow(c.droppedAt)).length;
  if (value.droppedCount !== expectedDropped) {
    ctx.issues.error(
      'RECENT_OUTCOMES_DROPPED_MISMATCH',
      `${path}.droppedCount`,
      `must equal ${expectedDropped}, the commitments dropped inside the window in the fixture's own DomainState`,
    );
  }
}

function checkLifeStateSection(
  issues: IssueCollector,
  fixtureId: string,
  fixture: Record<string, unknown>,
  condition: string,
): DomainState | null {
  const path = `${fixtureId}.lifeState`;
  const section = fixture.lifeState;
  if (!isPlainObject(section)) {
    issues.error('MISSING_LIFE_STATE', path, 'lifeState section is required');
    return null;
  }
  const input = section.input;
  if (!isPlainObject(input)) {
    issues.error('LIFE_STATE_INPUT_INVALID', `${path}.input`, 'input is required');
    return null;
  }
  const state = input.state;
  if (!isPlainObject(state) || !isPlainObject(state.commitments) || !isPlainObject(state.reminders) || !isPlainObject(state.escalationStates)) {
    issues.error('LIFE_STATE_INPUT_INVALID', `${path}.input.state`, 'state must be a DomainState with commitments, reminders and escalationStates');
    return null;
  }
  if (input.now !== fixture.now) {
    issues.error('LIFE_STATE_NOW_MISMATCH', `${path}.input.now`, "input.now must equal the fixture's now");
  }
  if (input.scopeId !== fixture.scopeId) {
    issues.error('LIFE_STATE_SCOPE_MISMATCH', `${path}.input.scopeId`, "input.scopeId must equal the fixture's scopeId");
  }
  const windowDays = input.windowDays;
  if (windowDays !== undefined && (!isNonNegativeInteger(windowDays) || windowDays === 0)) {
    issues.error('LIFE_STATE_INPUT_INVALID', `${path}.input.windowDays`, 'windowDays must be a positive integer when present');
  }

  const expected = section.expected;
  if (!isPlainObject(expected)) {
    issues.error('LIFE_STATE_EXPECTATION_MISSING', `${path}.expected`, 'expected is required');
    return state as unknown as DomainState;
  }

  const commitments = commitmentsOf(state);
  const now = typeof fixture.now === 'string' ? fixture.now : '';
  const stateIsEmpty = commitments.length === 0;

  for (const fieldName of LIFE_STATE_FIELDS) {
    const fieldPath = `${path}.expected.${fieldName}`;
    const field = expected[fieldName];
    if (!isPlainObject(field)) {
      issues.error('EXPECTED_FIELD_MISSING', fieldPath, 'every LifeState field must declare an expectation');
      continue;
    }
    const ctx: FieldContext = {
      issues,
      path: fieldPath,
      now,
      state: state as unknown as DomainState,
      commitments,
    };

    if (field.known === false) {
      const reason = field.reason;
      if (typeof reason !== 'string' || !UNKNOWN_REASONS.includes(reason)) {
        issues.error('INVALID_UNKNOWN_REASON', fieldPath, `reason ${String(reason)} is outside the contract vocabulary`);
      } else if (reason === 'NO_DATA') {
        const provenance = field.provenance;
        if (isPlainObject(provenance) && provenance.source !== 'absent') {
          issues.error('NO_DATA_SOURCE_MISMATCH', fieldPath, "reason NO_DATA requires provenance.source 'absent'");
        }
        if (!stateIsEmpty) {
          issues.error(
            'NO_DATA_OVER_POPULATED_STATE',
            fieldPath,
            'NO_DATA means there is nothing in DomainState to derive from, but this fixture supplies commitments; a field that observes no activity is known-zero, not unknown',
          );
        }
      } else if (!stateIsEmpty && reason === 'INSUFFICIENT_DATA') {
        // Contract-legal over a populated state, but rare enough to flag: the
        // Field<T> invariant exists so that "observed nothing" reads as a known
        // zero rather than as an absence of knowledge.
        issues.warn(
          'INSUFFICIENT_DATA_OVER_POPULATED_STATE',
          fieldPath,
          'field claims insufficient data although the DomainState is populated; confirm this is a threshold decision and not a known zero',
        );
      }
      if ('value' in field) {
        issues.error('UNKNOWN_FIELD_HAS_VALUE', fieldPath, 'an unknown field must not carry a value');
      }
      checkProvenance(ctx, field.provenance, false);
      continue;
    }

    if (field.known !== true) {
      issues.error('EXPECTED_FIELD_SHAPE', fieldPath, 'known must be true or false');
      continue;
    }

    if (stateIsEmpty) {
      issues.error(
        'EMPTY_STATE_EXPECTS_UNKNOWN',
        fieldPath,
        'the DomainState is empty, so this field must be unknown with reason NO_DATA rather than known — that distinction is the point of Field<T>',
      );
    }

    const value = field.value;
    if (!isPlainObject(value)) {
      issues.error('EXPECTED_FIELD_SHAPE', `${fieldPath}.value`, 'a known field must carry an object value');
      checkProvenance(ctx, field.provenance, true);
      continue;
    }
    checkProvenance(ctx, field.provenance, true);

    switch (fieldName) {
      case 'commitments':
        checkViewKeys(ctx, value, COMMITMENTS_VIEW_KEYS, field.unpinned);
        checkCommitmentsView(ctx, value);
        break;
      case 'availability':
        checkViewKeys(ctx, value, AVAILABILITY_VIEW_KEYS, field.unpinned);
        checkAvailabilityView(ctx, value);
        break;
      case 'load':
        checkViewKeys(ctx, value, LOAD_VIEW_KEYS, field.unpinned);
        checkLoadView(ctx, value);
        break;
      case 'recentOutcomes':
        checkViewKeys(ctx, value, RECENT_OUTCOMES_VIEW_KEYS, field.unpinned);
        checkRecentOutcomesView(ctx, value, typeof windowDays === 'number' ? windowDays : undefined);
        break;
    }
  }

  return state as unknown as DomainState;
}

/* ── Memory section ──────────────────────────────────────────────── */

interface NormalizedRecord {
  readonly handle: string;
  readonly putAtMs: number;
  readonly observedAtMs: number;
  readonly scopeId: string;
  readonly exportPolicy: string;
  readonly statusBeforePrune: string;
  readonly staleAtNow: boolean;
  readonly retrievableAtNow: boolean;
  readonly listedInScope: boolean;
  readonly sensitive: boolean;
}

function checkMemorySection(
  issues: IssueCollector,
  fixtureId: string,
  fixture: Record<string, unknown>,
  language: string,
  condition: string,
): void {
  const path = `${fixtureId}.memory`;
  const section = fixture.memory;
  if (!isPlainObject(section)) {
    issues.error('MISSING_MEMORY', path, 'memory section is required');
    return;
  }
  const records = section.records;
  if (!Array.isArray(records)) {
    issues.error('MEMORY_RECORDS_INVALID', `${path}.records`, 'records must be an array');
    return;
  }

  const nowMs = typeof fixture.now === 'string' ? Date.parse(fixture.now) : Number.NaN;
  const scopeId = fixture.scopeId;
  const handles: string[] = [];
  const normalized: NormalizedRecord[] = [];
  const supersedesLinks: Array<{ from: string; to: string }> = [];

  records.forEach((record, index) => {
    const recordPath = `${path}.records[${index}]`;
    if (!isPlainObject(record)) {
      issues.error('MEMORY_RECORD_NOT_OBJECT', recordPath, 'record must be an object');
      return;
    }
    const handle = record.handle;
    if (!isNonEmptyString(handle)) {
      issues.error('MEMORY_HANDLE_INVALID', `${recordPath}.handle`, 'handle must be a non-empty string');
      return;
    }
    if (handles.includes(handle)) {
      issues.error('DUPLICATE_RECORD_HANDLE', `${recordPath}.handle`, `handle ${handle} is used twice`);
    }
    handles.push(handle);

    const input = record.input;
    if (!isPlainObject(input)) {
      issues.error('MEMORY_INPUT_INVALID', `${recordPath}.input`, 'input must be a CreateMemoryInput object');
      return;
    }
    const expected = record.expected;
    if (!isPlainObject(expected)) {
      issues.error('MEMORY_EXPECTATION_MISSING', `${recordPath}.expected`, 'every record must declare its expected outcome');
      return;
    }

    if (!isNonEmptyString(input.scopeId)) {
      issues.error('MEMORY_INPUT_INVALID', `${recordPath}.input.scopeId`, 'scopeId must be a non-empty string');
    }
    if (typeof input.kind !== 'string' || !MEMORY_KINDS.includes(input.kind)) {
      issues.error('INVALID_MEMORY_KIND', `${recordPath}.input.kind`, `kind ${String(input.kind)} is outside the runtime memory vocabulary`);
    }
    if (typeof input.source !== 'string' || !MEMORY_SOURCES.includes(input.source)) {
      issues.error('INVALID_MEMORY_SOURCE', `${recordPath}.input.source`, `source ${String(input.source)} is outside the contract vocabulary`);
    }
    if (typeof input.language !== 'string' || !FIXTURE_LANGUAGES.includes(input.language as MemoryLanguage)) {
      issues.error('INVALID_LANGUAGE', `${recordPath}.input.language`, `language ${String(input.language)} is outside the contract vocabulary`);
    } else if (input.language !== language) {
      issues.error('MEMORY_LANGUAGE_MISMATCH', `${recordPath}.input.language`, "record language must match the fixture's language");
    }

    if (!isNonEmptyString(input.content)) {
      issues.error('EMPTY_CONTENT', `${recordPath}.input.content`, 'content must be a non-empty string');
    } else if (typeof input.language === 'string' && FIXTURE_LANGUAGES.includes(input.language as MemoryLanguage)) {
      checkText(issues, `${recordPath}.input.content`, input.content, input.language as MemoryLanguage);
    }

    const confidence = input.confidence;
    if (typeof confidence !== 'number' || Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
      issues.error('CONFIDENCE_OUT_OF_RANGE', `${recordPath}.input.confidence`, 'confidence must be within 0..1 inclusive');
    }
    if (input.evidenceIds !== undefined && !isStringArray(input.evidenceIds)) {
      issues.error('MEMORY_INPUT_INVALID', `${recordPath}.input.evidenceIds`, 'evidenceIds must be an array of strings');
    }
    if (input.exportPolicy !== undefined && (typeof input.exportPolicy !== 'string' || !EXPORT_POLICIES.includes(input.exportPolicy))) {
      issues.error('INVALID_EXPORT_POLICY', `${recordPath}.input.exportPolicy`, 'exportPolicy is outside the contract vocabulary');
    }

    if (!isIsoTimestamp(record.putAt)) {
      issues.error('INVALID_TIMESTAMP', `${recordPath}.putAt`, 'putAt must be an ISO timestamp');
      return;
    }
    if (!isIsoTimestamp(input.observedAt)) {
      issues.error('INVALID_TIMESTAMP', `${recordPath}.input.observedAt`, 'observedAt must be an ISO timestamp');
      return;
    }
    const putAtMs = Date.parse(record.putAt as string);
    const observedAtMs = Date.parse(input.observedAt as string);
    if (observedAtMs > putAtMs) {
      issues.error('OBSERVED_AT_AFTER_PUT_AT', `${recordPath}.input.observedAt`, 'a fact cannot be observed after the record that captured it was written');
    }
    if (putAtMs > nowMs) {
      issues.error('PUT_AT_AFTER_CLOCK', `${recordPath}.putAt`, 'putAt cannot be after the fixture clock');
    }

    const statusBeforePrune = expected.statusBeforePrune;
    const statusAfterPrune = expected.statusAfterPrune;
    for (const [key, status] of [['statusBeforePrune', statusBeforePrune], ['statusAfterPrune', statusAfterPrune]] as const) {
      if (typeof status !== 'string' || !MEMORY_STATUSES.includes(status)) {
        issues.error('INVALID_MEMORY_STATUS', `${recordPath}.expected.${key}`, `status ${String(status)} is outside the contract vocabulary`);
      }
    }

    const exportPolicy = expected.exportPolicy;
    if (typeof exportPolicy !== 'string' || !EXPORT_POLICIES.includes(exportPolicy)) {
      issues.error('INVALID_EXPORT_POLICY', `${recordPath}.expected.exportPolicy`, 'expected exportPolicy is outside the contract vocabulary');
    }
    if (input.exportPolicy === undefined && exportPolicy !== 'personal_never_export') {
      issues.error(
        'EXPORT_POLICY_DEFAULT_MISMATCH',
        `${recordPath}.expected.exportPolicy`,
        'the contract defaults an omitted exportPolicy to personal_never_export',
      );
    }
    if (input.exportPolicy !== undefined && exportPolicy !== input.exportPolicy) {
      issues.error('EXPORT_POLICY_DEFAULT_MISMATCH', `${recordPath}.expected.exportPolicy`, 'expected policy must match the supplied policy');
    }

    const sensitive = record.sensitive === true;
    if (sensitive && exportPolicy !== 'personal_never_export') {
      issues.error(
        'SENSITIVE_EXPORT_POLICY',
        `${recordPath}.expected.exportPolicy`,
        'a record marked sensitive must expect personal_never_export; sensitive content has no shareable form',
      );
    }

    const staleAfter = expected.staleAfter;
    let staleAfterMs: number | null = null;
    if (!isIsoTimestamp(staleAfter)) {
      issues.error('INVALID_TIMESTAMP', `${recordPath}.expected.staleAfter`, 'staleAfter must be an ISO timestamp');
    } else {
      staleAfterMs = Date.parse(staleAfter as string);
      const ttlMs = typeof input.ttlMs === 'number' ? input.ttlMs : DEFAULT_MEMORY_TTL_MS;
      const derived = putAtMs + ttlMs;
      if (staleAfterMs !== derived) {
        issues.error(
          'STALE_AFTER_MISMATCH',
          `${recordPath}.expected.staleAfter`,
          `must equal putAt + ttl (${new Date(derived).toISOString()}); staleness runs from write time, never from observedAt`,
        );
      }
    }

    const staleAtNow = expected.staleAtNow === true;
    if (staleAfterMs !== null && staleAtNow !== staleAfterMs <= nowMs) {
      issues.error(
        'STALE_EXPECTATION_MISMATCH',
        `${recordPath}.expected.staleAtNow`,
        `staleAtNow must equal staleAfter <= the fixture clock (${staleAfterMs <= nowMs})`,
      );
    }

    const listedInScope = expected.listedInScope === true;
    if (listedInScope !== (input.scopeId === scopeId)) {
      issues.error(
        'LIST_ALL_SCOPE_MISMATCH',
        `${recordPath}.expected.listedInScope`,
        'listAll(scopeId) returns exactly the records written under that scope',
      );
    }

    const retrievable = expected.retrievableAtNow === true;
    if (retrievable && (statusBeforePrune !== 'active' || staleAtNow || !listedInScope)) {
      issues.error(
        'RETRIEVE_EXPECTATION_INCONSISTENT',
        `${recordPath}.expected.retrievableAtNow`,
        'retrieve() filters to active, non-stale records inside the queried scope, so this record cannot be retrievable',
      );
    }
    if (!retrievable && statusBeforePrune === 'active' && !staleAtNow && listedInScope) {
      issues.error(
        'RETRIEVE_EXPECTATION_INCONSISTENT',
        `${recordPath}.expected.retrievableAtNow`,
        'an active, non-stale, in-scope record must be retrievable',
      );
    }

    const expectedAfterPrune = staleAtNow && statusBeforePrune === 'active' ? 'expired' : statusBeforePrune;
    if (statusAfterPrune !== expectedAfterPrune) {
      issues.error(
        'PRUNE_STATUS_MISMATCH',
        `${recordPath}.expected.statusAfterPrune`,
        `prune() expires stale active records and leaves everything else alone, so this must be ${String(expectedAfterPrune)}`,
      );
    }

    if (record.supersedesHandle !== undefined) {
      if (!isNonEmptyString(record.supersedesHandle)) {
        issues.error('MEMORY_HANDLE_INVALID', `${recordPath}.supersedesHandle`, 'supersedesHandle must be a non-empty string');
      } else {
        supersedesLinks.push({ from: handle, to: record.supersedesHandle });
        if (expected.supersedesHandle !== record.supersedesHandle) {
          issues.error(
            'SUPERSESSION_LINK_ASYMMETRY',
            `${recordPath}.expected.supersedesHandle`,
            'the expected supersedesHandle must mirror the write',
          );
        }
      }
    } else if (expected.supersedesHandle !== undefined) {
      issues.error(
        'SUPERSESSION_LINK_ASYMMETRY',
        `${recordPath}.expected.supersedesHandle`,
        'the record expects a supersedes link it never writes',
      );
    }

    normalized.push({
      handle,
      putAtMs,
      observedAtMs,
      scopeId: String(input.scopeId),
      exportPolicy: String(exportPolicy),
      statusBeforePrune: String(statusBeforePrune),
      staleAtNow,
      retrievableAtNow: retrievable,
      listedInScope,
      sensitive,
    });
  });

  /* Supersession links resolve, and both ends agree. */
  for (const link of supersedesLinks) {
    const target = records.find((r) => isPlainObject(r) && r.handle === link.to);
    if (!isPlainObject(target)) {
      issues.error('UNKNOWN_SUPERSEDES_HANDLE', `${path}.records`, `${link.from} supersedes unknown handle ${link.to}`);
      continue;
    }
    const targetExpected = isPlainObject(target.expected) ? target.expected : null;
    if (!targetExpected) continue;
    if (targetExpected.supersededByHandle !== link.from) {
      issues.error(
        'SUPERSESSION_LINK_ASYMMETRY',
        `${path}.records`,
        `${link.to} must expect supersededByHandle ${link.from}`,
      );
    }
    if (targetExpected.statusBeforePrune !== 'superseded') {
      issues.error(
        'SUPERSEDED_STATUS_MISMATCH',
        `${path}.records`,
        `${link.to} was superseded, so its status must be 'superseded' — supersede() never destroys the prior record`,
      );
    }
    if (targetExpected.retrievableAtNow === true) {
      issues.error('RETRIEVE_EXPECTATION_INCONSISTENT', `${path}.records`, `${link.to} is superseded and cannot be retrievable`);
    }
  }
  for (const record of records) {
    if (!isPlainObject(record) || !isPlainObject(record.expected)) continue;
    const supersededBy = record.expected.supersededByHandle;
    if (supersededBy === undefined) continue;
    if (!supersedesLinks.some((link) => link.from === supersededBy && link.to === record.handle)) {
      issues.error(
        'UNKNOWN_SUPERSEDED_BY_HANDLE',
        `${path}.records`,
        `${String(record.handle)} expects to be superseded by ${String(supersededBy)}, which writes no such link`,
      );
    }
  }

  /* Section-level expectations, all recomputed from the records above. */
  const retrieveHandles = section.expectedRetrieveHandles;
  if (!isStringArray(retrieveHandles)) {
    issues.error('RETRIEVE_HANDLES_INVALID', `${path}.expectedRetrieveHandles`, 'must be an array of strings');
  } else {
    for (const handle of retrieveHandles) {
      if (!handles.includes(handle)) {
        issues.error('RETRIEVE_HANDLE_UNKNOWN', `${path}.expectedRetrieveHandles`, `unknown handle ${handle}`);
      }
    }
    const expectedRetrievable = normalized.filter((r) => r.retrievableAtNow).map((r) => r.handle);
    if (!sameSet(retrieveHandles, expectedRetrievable)) {
      issues.error(
        'RETRIEVE_SET_MISMATCH',
        `${path}.expectedRetrieveHandles`,
        `declared ${describeSet(retrieveHandles)} but the records marked retrievable are ${describeSet(expectedRetrievable)}`,
      );
    }
    for (let i = 1; i < retrieveHandles.length; i += 1) {
      const previous = normalized.find((r) => r.handle === retrieveHandles[i - 1]);
      const current = normalized.find((r) => r.handle === retrieveHandles[i]);
      if (!previous || !current) continue;
      if (previous.observedAtMs <= current.observedAtMs) {
        issues.error(
          'RETRIEVE_ORDER_INVALID',
          `${path}.expectedRetrieveHandles[${i}]`,
          'retrieve() sorts newest-observedAt first, and fixtures must avoid ties so the order is total',
        );
      }
    }
  }

  const listAllHandles = section.expectedListAllHandles;
  if (!isStringArray(listAllHandles)) {
    issues.error('LIST_ALL_HANDLES_INVALID', `${path}.expectedListAllHandles`, 'must be an array of strings');
  } else {
    const expectedListed = normalized.filter((r) => r.listedInScope).map((r) => r.handle);
    if (!sameSet(listAllHandles, expectedListed)) {
      issues.error(
        'LIST_ALL_SET_MISMATCH',
        `${path}.expectedListAllHandles`,
        `declared ${describeSet(listAllHandles)} but the in-scope records are ${describeSet(expectedListed)}`,
      );
    }
  }

  const expectedPruned = normalized.filter((r) => r.staleAtNow && r.statusBeforePrune === 'active').length;
  if (section.expectedPrunedCount !== expectedPruned) {
    issues.error(
      'PRUNE_COUNT_MISMATCH',
      `${path}.expectedPrunedCount`,
      `must equal ${expectedPruned}, the number of stale active records written by this fixture`,
    );
  }

  const anyPersonalInScope = normalized.some((r) => r.listedInScope && r.exportPolicy === 'personal_never_export');
  if (section.expectedAssertNoPersonalMemoryThrows !== anyPersonalInScope) {
    issues.error(
      'ASSERT_PERSONAL_EXPECTATION_MISMATCH',
      `${path}.expectedAssertNoPersonalMemoryThrows`,
      `must equal ${anyPersonalInScope}; assertNoPersonalMemory throws exactly when a personal record is present`,
    );
  }

  const shareableHandles = section.expectedShareableAggregateHandles;
  if (!isStringArray(shareableHandles)) {
    issues.error('SHAREABLE_HANDLES_INVALID', `${path}.expectedShareableAggregateHandles`, 'must be an array of strings');
  } else {
    const expectedShareable = normalized
      .filter((r) => r.listedInScope && r.exportPolicy === 'shareable_aggregate')
      .map((r) => r.handle);
    if (!sameSet(shareableHandles, expectedShareable)) {
      issues.error(
        'SHAREABLE_HANDLE_MISMATCH',
        `${path}.expectedShareableAggregateHandles`,
        `declared ${describeSet(shareableHandles)} but the shareable in-scope records are ${describeSet(expectedShareable)}`,
      );
    }
  }

  /* Condition-specific obligations. */
  if (condition === 'missing') {
    if (normalized.some((r) => r.listedInScope)) {
      issues.error('MISSING_CONDITION_HAS_IN_SCOPE_MEMORY', path, 'a missing-context fixture must hold no in-scope memory');
    }
    if (normalized.length === 0) {
      issues.warn(
        'MISSING_CONDITION_HAS_NO_PROBE',
        path,
        'without an out-of-scope probe record, an empty retrieval proves nothing about scope filtering',
      );
    }
  }
  if (condition === 'stale' && !normalized.some((r) => r.staleAtNow)) {
    issues.error('STALE_CONDITION_HAS_NO_STALE_RECORD', path, 'a stale-context fixture must hold at least one record past staleAfter');
  }
  if (condition === 'conflicting') {
    if (supersedesLinks.length === 0) {
      issues.error('CONFLICTING_CONDITION_HAS_NO_SUPERSESSION', path, 'a conflicting-context fixture must exercise a supersession chain');
    }
    if (normalized.filter((r) => r.retrievableAtNow).length < 2) {
      issues.error(
        'CONFLICTING_CONDITION_RESOLVES_ITSELF',
        path,
        'a conflicting-context fixture must leave at least two records retrievable, or nothing conflicts',
      );
    }
  }
  if (condition === 'sensitive') {
    if (!normalized.some((r) => r.sensitive)) {
      issues.error('SENSITIVE_CONDITION_HAS_NO_SENSITIVE_RECORD', path, 'a sensitive-context fixture must mark at least one record sensitive');
    }
    if (section.expectedAssertNoPersonalMemoryThrows !== true) {
      issues.error('SENSITIVE_CONDITION_EXPORTABLE', path, 'a sensitive-context fixture must expect assertNoPersonalMemory to throw');
    }
  }
}

/* ── Public API ──────────────────────────────────────────────────── */

export function validateFixture(candidate: unknown): ValidationResult {
  const issues = new IssueCollector();

  if (!isPlainObject(candidate)) {
    issues.error('FIXTURE_NOT_OBJECT', '<fixture>', 'a fixture must be an object');
    return issues.result();
  }

  const id = isNonEmptyString(candidate.id) ? candidate.id : '<unnamed>';
  if (!isNonEmptyString(candidate.id)) {
    issues.error('INVALID_ID', '<fixture>.id', 'id must be a non-empty string');
  }
  if (!isNonEmptyString(candidate.description)) {
    issues.error('MISSING_DESCRIPTION', `${id}.description`, 'description must be a non-empty string');
  }
  if (!isNonEmptyString(candidate.notes)) {
    issues.error('MISSING_NOTES', `${id}.notes`, 'notes must explain why the expected decision is what it is');
  }
  if (!isNonEmptyString(candidate.scopeId)) {
    issues.error('INVALID_SCOPE_ID', `${id}.scopeId`, 'scopeId must be a non-empty string');
  }
  if (!isIsoTimestamp(candidate.now)) {
    issues.error('INVALID_TIMESTAMP', `${id}.now`, 'now must be an ISO timestamp');
  }

  const language = candidate.language;
  if (typeof language !== 'string' || !FIXTURE_LANGUAGES.includes(language as MemoryLanguage)) {
    issues.error('INVALID_LANGUAGE', `${id}.language`, `language ${String(language)} is outside the contract vocabulary`);
  }
  const condition = candidate.condition;
  if (typeof condition !== 'string' || !CONTEXT_CONDITIONS.includes(condition as ContextCondition)) {
    issues.error('INVALID_CONDITION', `${id}.condition`, `condition ${String(condition)} is outside the four context conditions`);
  }

  const state = checkLifeStateSection(issues, id, candidate, String(condition));
  checkMemorySection(issues, id, candidate, String(language), String(condition));

  /* Absence assertions must bite: every named string has to exist in the input. */
  const absent = candidate.expectedAbsentFromProjection;
  if (!isStringArray(absent)) {
    issues.error('ABSENCE_ASSERTION_INVALID', `${id}.expectedAbsentFromProjection`, 'must be an array of strings');
  } else if (state) {
    const present = new Set<string>();
    for (const commitment of commitmentsOf(state)) {
      present.add(commitment.title);
      if (commitment.person) present.add(commitment.person);
      if (commitment.description) present.add(commitment.description);
    }
    for (const value of absent) {
      if (!present.has(value)) {
        issues.error(
          'VACUOUS_ABSENCE_ASSERTION',
          `${id}.expectedAbsentFromProjection`,
          `"${value}" is not in the fixture's DomainState, so asserting its absence from the projection proves nothing`,
        );
      }
    }
    if (present.size > 0 && absent.length !== present.size) {
      issues.error(
        'INCOMPLETE_ABSENCE_ASSERTION',
        `${id}.expectedAbsentFromProjection`,
        'every commitment title, person and description must be asserted absent; LifeState carries ids and counts, never content',
      );
    }
  }

  return issues.result();
}

export function validateFixtureCorpus(candidates: readonly unknown[]): ValidationResult {
  const issues = new IssueCollector();
  const seenIds = new Set<string>();
  const clocks = new Set<string>();
  const covered = new Set<string>();

  for (const candidate of candidates) {
    issues.merge(validateFixture(candidate).issues);
    if (!isPlainObject(candidate)) continue;
    if (isNonEmptyString(candidate.id)) {
      if (seenIds.has(candidate.id)) {
        issues.error('DUPLICATE_FIXTURE_ID', `${candidate.id}`, 'fixture ids must be unique across the corpus');
      }
      seenIds.add(candidate.id);
    }
    if (typeof candidate.now === 'string') clocks.add(candidate.now);
    if (typeof candidate.language === 'string' && typeof candidate.condition === 'string') {
      covered.add(`${candidate.language}/${candidate.condition}`);
    }
  }

  if (clocks.size > 1) {
    issues.error(
      'CLOCK_NOT_UNIFORM',
      '<corpus>',
      `the corpus must share one fixed clock, found ${describeSet(Array.from(clocks))}`,
    );
  }

  for (const language of FIXTURE_LANGUAGES) {
    for (const condition of CONTEXT_CONDITIONS) {
      if (!covered.has(`${language}/${condition}`)) {
        issues.error('COVERAGE_GAP', '<corpus>', `no fixture for ${language} × ${condition}`);
      }
    }
  }

  return issues.result();
}

export function describeIssues(result: ValidationResult): string {
  return result.issues.map(formatIssue).join('\n');
}
