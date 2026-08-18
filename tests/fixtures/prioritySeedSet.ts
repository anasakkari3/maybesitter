/**
 * SYNTHETIC — ENGINEERING QA ONLY — NOT HUMAN EVIDENCE
 *
 * Priority annotation seed set (Sprint 04, issue #19).
 *
 * Every title, person, timestamp and identifier in this file is invented for
 * engineering QA. Nothing here is production user state, pilot data, runtime
 * memory, or V03 human evidence, and nothing here may be presented as such. The
 * commitments are deliberately mundane and unattributable; no record in the
 * runtime memory store was consulted to write them.
 *
 * ── What this corpus is ────────────────────────────────────────────
 *
 * Twenty *pairs* of commitments. An annotator reads a pair and says which of
 * the two should be shown higher in the agenda, following
 * docs/quality/PRIORITY_ANNOTATION_RUBRIC.md.
 *
 * ── What this corpus deliberately does NOT contain ─────────────────
 *
 * **No expected verdict.** Not a `verdict`, not a `label`, not a `gold` field.
 * The verdict is the human judgment this sprint does not have, and a plausible
 * one written by engineering would read as human evidence while being nothing
 * of the kind. Sprint 05 calibrates ranking against this data; a fabricated row
 * here becomes a miscalibrated ordering there.
 *
 * `rubricClause` records which criterion the pair was *constructed* to exercise.
 * That is a statement about construction, not a prediction of the verdict, and
 * it must never be used as a label. Same for `designedAmbiguous`: it says the
 * pair was built so that no criterion separates it, which is why the rubric's
 * U-codes are reachable at all — it does not say any annotator will abstain.
 *
 * ── The matrix ─────────────────────────────────────────────────────
 *
 * Four languages (ar | he | en | mixed) × four load patterns (light | moderate
 * | heavy | overloaded), every cell populated, plus one designed-ambiguous pair
 * per language. Every one of the ten unordered reason mixes over
 * {overdue, due_soon, active, pending} appears at least once.
 *
 * Load pattern is *context*, not a criterion: it is here because the cost of a
 * ranking error rises with load — at `light` the user sees everything anyway,
 * at `overloaded` the item ranked second may never be reached. The rubric
 * forbids using it as a tie-break.
 *
 * The expected *treatment* of a cell is language-invariant by construction:
 * matched cells differ only in ids and text. A verdict that changes with the
 * language is a multilingual regression by definition, and the corpus is shaped
 * so that this is measurable rather than merely hoped for.
 *
 * Balance is reported rather than asserted — see
 * lib/priority/rubric/seedSetCoverage.ts, which emits the full distribution and
 * names any cell that dominates or is starved.
 */
import type {
  AckState,
  Commitment,
  CommitmentKind,
  CommitmentStatus,
  Priority,
  Reminder,
} from '../../src/domain/stateMachine';
import type { PriorityReason } from '../../src/contracts/v1/priorityContracts';

/* ── Versioning ──────────────────────────────────────────────────── */

/**
 * Judgments are only comparable within one version of the rubric's criteria, so
 * the rubric version is pinned next to the pairs it applies to. Changing a
 * criterion in docs/quality/PRIORITY_ANNOTATION_RUBRIC.md means bumping this and
 * treating existing judgments as belonging to the previous version.
 */
export const RUBRIC_VERSION = 'priority-rubric-v1' as const;

/* ── Fixed clock ─────────────────────────────────────────────────── */

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The one clock every pair is expressed against — the same instant Sprint 02's
 * fixture corpus uses, so the two corpora can be reasoned about together.
 * Nothing in this file reads Date.now(): a seed set whose overdue items depend
 * on when the suite runs is not a fixture.
 */
export const SEED_CLOCK = new Date('2026-08-18T09:00:00.000Z');
export const SEED_CLOCK_ISO = SEED_CLOCK.toISOString();

/** The due-soon window the rubric and the agenda both assume. */
export const SEED_DUE_SOON_WINDOW_MS = DAY_MS;

function atHours(offsetHours: number): string {
  return new Date(SEED_CLOCK.getTime() + offsetHours * HOUR_MS).toISOString();
}

function atDays(offsetDays: number): string {
  return new Date(SEED_CLOCK.getTime() + offsetDays * DAY_MS).toISOString();
}

/* ── Vocabularies ────────────────────────────────────────────────── */

export type SeedLanguage = 'ar' | 'he' | 'en' | 'mixed';
export type LoadPattern = 'light' | 'moderate' | 'heavy' | 'overloaded';
export type SeedSplit = 'calibration' | 'locked';

export const SEED_LANGUAGES: readonly SeedLanguage[] = Object.freeze(['ar', 'he', 'en', 'mixed']);
export const LOAD_PATTERNS: readonly LoadPattern[] = Object.freeze(['light', 'moderate', 'heavy', 'overloaded']);

/**
 * Canonical order for naming a reason mix. Two pairs that compare the same two
 * bands must produce the same mix key regardless of which side is `left`, or
 * coverage counting would double the vocabulary for no reason.
 */
const REASON_ORDER: readonly PriorityReason[] = Object.freeze(['overdue', 'due_soon', 'active', 'pending']);

export type ReasonMix = string;

export const REASON_MIXES: readonly ReasonMix[] = Object.freeze(
  REASON_ORDER.flatMap((first, index) => REASON_ORDER.slice(index).map((second) => `${first}|${second}`)),
);

/* ── Types ───────────────────────────────────────────────────────── */

export interface SeedCommitment {
  readonly commitment: Commitment;
  readonly reminders: readonly Reminder[];
  /**
   * The band this side sits in at the seed clock. Declared rather than derived
   * so the corpus states its own intent, and cross-checked against the state
   * that implies it in tests/priority/prioritySeedSet.test.ts.
   */
  readonly reason: PriorityReason;
}

export interface PrioritySeedPair {
  readonly pairId: string;
  readonly language: SeedLanguage;
  readonly loadPattern: LoadPattern;
  /** The instant both sides are evaluated at. Always the seed clock. */
  readonly clock: string;
  /** Open commitments this simulated user carries; produces `loadPattern`. */
  readonly openCommitmentCount: number;
  readonly left: SeedCommitment;
  readonly right: SeedCommitment;
  /** Which rubric criterion this pair was built to exercise. Not a label. */
  readonly rubricClause: string;
  /** Built so no criterion separates the sides. Not a predicted verdict. */
  readonly designedAmbiguous: boolean;
  readonly split: SeedSplit;
  /** Why this pair is in the set, in one line, for the annotator's benefit. */
  readonly note: string;
}

/* ── Builders ────────────────────────────────────────────────────── */

interface SideSpec {
  readonly id: string;
  readonly title: string;
  readonly reason: PriorityReason;
  readonly description?: string | null;
  readonly person?: string | null;
  readonly kind?: CommitmentKind;
  readonly status?: CommitmentStatus;
  readonly level?: Priority['level'];
  readonly source?: Priority['source'];
  /** Hours from the seed clock; negative is in the past. Null is unscheduled. */
  readonly dueAtHours?: number | null;
  readonly remindAtHours?: number | null;
  readonly ackState?: AckState;
  readonly postponedUntilHours?: number | null;
  readonly snoozes?: number;
  /** Hours before the clock that a reminder was ignored. Null for none. */
  readonly ignoredHoursAgo?: number | null;
  readonly createdDaysAgo?: number;
}

const DEFAULT_STATUS_BY_REASON: Record<PriorityReason, CommitmentStatus> = {
  overdue: 'active',
  due_soon: 'active',
  active: 'active',
  pending: 'pending_confirmation',
};

function side(spec: SideSpec): SeedCommitment {
  const dueAt = spec.dueAtHours === undefined || spec.dueAtHours === null ? null : atHours(spec.dueAtHours);
  const remindAt =
    spec.remindAtHours === undefined || spec.remindAtHours === null ? dueAt : atHours(spec.remindAtHours);
  const createdAt = atDays(-(spec.createdDaysAgo ?? 6));
  const status = spec.status ?? DEFAULT_STATUS_BY_REASON[spec.reason];

  const commitment: Commitment = {
    id: spec.id,
    kind: spec.kind ?? 'task',
    title: spec.title,
    description: spec.description ?? null,
    person: spec.person ?? null,
    status,
    priority: {
      level: spec.level ?? 'normal',
      source: spec.source ?? 'inferred',
      pressureAllowed: true,
      pressureLevel: 'gentle',
    },
    timeSpec: {
      kind: dueAt === null ? 'unscheduled' : 'due_by',
      dueAt,
      remindAt,
      timezone: 'UTC',
    },
    currentAckState: spec.ackState ?? 'seen',
    postponedUntil:
      spec.postponedUntilHours === undefined || spec.postponedUntilHours === null
        ? null
        : atHours(spec.postponedUntilHours),
    createdAt,
    updatedAt: atHours(-2),
    confirmedAt: status === 'pending_confirmation' ? null : createdAt,
    completedAt: null,
    droppedAt: null,
  };

  const reminders: Reminder[] = [];
  for (let index = 0; index < (spec.snoozes ?? 0); index += 1) {
    const scheduledFor = atHours(-((index + 1) * 12));
    reminders.push({
      id: `${spec.id}-rem-snooze-${index + 1}`,
      commitmentId: spec.id,
      reminderType: 'check_in',
      scheduledFor,
      status: 'snoozed',
      requiresAction: true,
      deliveredAt: scheduledFor,
      acknowledgedAt: null,
      snoozedUntil: atHours(index + 1),
      createdAt,
      updatedAt: scheduledFor,
    });
  }
  if (spec.ignoredHoursAgo !== undefined && spec.ignoredHoursAgo !== null) {
    const ignoredAt = atHours(-spec.ignoredHoursAgo);
    reminders.push({
      id: `${spec.id}-rem-ignored`,
      commitmentId: spec.id,
      reminderType: 'due_soon',
      scheduledFor: ignoredAt,
      status: 'ignored',
      requiresAction: true,
      deliveredAt: ignoredAt,
      acknowledgedAt: null,
      snoozedUntil: null,
      createdAt,
      updatedAt: ignoredAt,
    });
  }

  return { commitment, reminders, reason: spec.reason };
}

interface PairSpec {
  readonly pairId: string;
  readonly language: SeedLanguage;
  readonly loadPattern: LoadPattern;
  readonly openCommitmentCount: number;
  readonly left: SideSpec;
  readonly right: SideSpec;
  readonly rubricClause: string;
  readonly note: string;
  readonly designedAmbiguous?: boolean;
  readonly split?: SeedSplit;
}

function pair(spec: PairSpec): PrioritySeedPair {
  return {
    pairId: spec.pairId,
    language: spec.language,
    loadPattern: spec.loadPattern,
    clock: SEED_CLOCK_ISO,
    openCommitmentCount: spec.openCommitmentCount,
    left: side(spec.left),
    right: side(spec.right),
    rubricClause: spec.rubricClause,
    designedAmbiguous: spec.designedAmbiguous ?? false,
    split: spec.split ?? 'calibration',
    note: spec.note,
  };
}

/* ── The seed set ────────────────────────────────────────────────── */

export const PRIORITY_SEED_PAIRS: readonly PrioritySeedPair[] = Object.freeze([
  /* ── Arabic ──────────────────────────────────────────────────── */
  pair({
    pairId: 'ps-ar-light-01',
    language: 'ar',
    loadPattern: 'light',
    openCommitmentCount: 2,
    rubricClause: 'C1',
    note: 'A passed deadline against a user-set high importance. C1 stops the procedure before C3 is reached.',
    left: {
      id: 'ps-ar-light-01-a',
      title: 'تسليم تقرير الحضانة',
      description: 'التقرير الشهري المطلوب من الحضانة',
      person: 'أم ليلى',
      reason: 'overdue',
      dueAtHours: -20,
    },
    right: {
      id: 'ps-ar-light-01-b',
      title: 'تأكيد موعد طبيب الأسنان',
      person: 'عيادة النور',
      reason: 'due_soon',
      dueAtHours: 6,
      level: 'high',
      source: 'user_explicit',
    },
  }),
  pair({
    pairId: 'ps-ar-moderate-01',
    language: 'ar',
    loadPattern: 'moderate',
    openCommitmentCount: 4,
    rubricClause: 'C4',
    note: 'Levels equal and neither is timed, so C4 decides on a single snooze.',
    left: {
      id: 'ps-ar-moderate-01-a',
      title: 'مراجعة فاتورة الكهرباء',
      reason: 'active',
      snoozes: 1,
    },
    right: {
      id: 'ps-ar-moderate-01-b',
      title: 'ترتيب موعد مع المعلمة',
      person: 'الأستاذة هدى',
      reason: 'pending',
      source: 'default',
    },
  }),
  pair({
    pairId: 'ps-ar-moderate-02',
    language: 'ar',
    loadPattern: 'moderate',
    openCommitmentCount: 4,
    rubricClause: 'U1',
    designedAmbiguous: true,
    note: 'C4 fires but its sub-signals point opposite ways: more snoozes on one side, postponed and deferred on the other.',
    left: {
      id: 'ps-ar-moderate-02-c',
      title: 'متابعة طلب الإجازة مع سارة',
      kind: 'follow_up',
      person: 'سارة',
      reason: 'active',
      snoozes: 2,
    },
    right: {
      id: 'ps-ar-moderate-02-d',
      title: 'مراجعة عقد المورّد',
      reason: 'active',
      status: 'deferred',
      ackState: 'postponed',
      postponedUntilHours: 48,
    },
  }),
  pair({
    pairId: 'ps-ar-heavy-01',
    language: 'ar',
    loadPattern: 'heavy',
    openCommitmentCount: 8,
    rubricClause: 'C3',
    split: 'locked',
    note: 'Both overdue, so C1 declines and C2 does not apply; user-set importance decides at C3.',
    left: {
      id: 'ps-ar-heavy-01-a',
      title: 'إرسال مستندات التأمين',
      reason: 'overdue',
      dueAtHours: -30,
      snoozes: 1,
    },
    right: {
      id: 'ps-ar-heavy-01-b',
      title: 'دفع رسوم المدرسة',
      reason: 'overdue',
      dueAtHours: -50,
      level: 'high',
      source: 'user_explicit',
    },
  }),
  pair({
    pairId: 'ps-ar-overloaded-01',
    language: 'ar',
    loadPattern: 'overloaded',
    openCommitmentCount: 14,
    rubricClause: 'C2',
    note: 'Timed against unscheduled at the highest load, where the second-ranked item may never be reached.',
    left: {
      id: 'ps-ar-overloaded-01-a',
      title: 'حجز تذاكر السفر',
      reason: 'due_soon',
      dueAtHours: 10,
    },
    right: {
      id: 'ps-ar-overloaded-01-b',
      title: 'تحديث كلمة المرور للبنك',
      reason: 'pending',
      level: 'low',
      source: 'default',
    },
  }),

  /* ── Hebrew ──────────────────────────────────────────────────── */
  pair({
    pairId: 'ps-he-light-01',
    language: 'he',
    loadPattern: 'light',
    openCommitmentCount: 2,
    rubricClause: 'C2',
    note: 'C2 prefers the timed side over an unscheduled one even though the unscheduled side is a user-set high.',
    left: {
      id: 'ps-he-light-01-a',
      title: 'לשלוח מייל למורה של דנה',
      person: 'דנה',
      reason: 'due_soon',
      dueAtHours: 3,
    },
    right: {
      id: 'ps-he-light-01-b',
      title: 'לקבוע פגישה עם רואה החשבון',
      reason: 'active',
      level: 'high',
      source: 'user_explicit',
    },
  }),
  pair({
    pairId: 'ps-he-moderate-01',
    language: 'he',
    loadPattern: 'moderate',
    openCommitmentCount: 5,
    rubricClause: 'C1',
    note: 'An overdue low/default item against an unscheduled user-set high. C1 outranks C3 by design.',
    left: {
      id: 'ps-he-moderate-01-a',
      title: 'להגיש טופס החזר מס',
      reason: 'overdue',
      dueAtHours: -8,
      level: 'low',
      source: 'default',
    },
    right: {
      id: 'ps-he-moderate-01-b',
      title: 'לארגן את התיקייה המשותפת',
      reason: 'active',
      level: 'high',
      source: 'user_explicit',
    },
  }),
  pair({
    pairId: 'ps-he-heavy-01',
    language: 'he',
    loadPattern: 'heavy',
    openCommitmentCount: 8,
    rubricClause: 'C6',
    note: 'Identical on every criterion: the rubric applies cleanly and finds them level. A coin flip is fine here.',
    left: {
      id: 'ps-he-heavy-01-a',
      title: 'לסדר את מסמכי הביטוח',
      reason: 'pending',
    },
    right: {
      id: 'ps-he-heavy-01-b',
      title: 'להחזיר ספרים לספרייה',
      reason: 'pending',
    },
  }),
  pair({
    pairId: 'ps-he-heavy-02',
    language: 'he',
    loadPattern: 'heavy',
    openCommitmentCount: 8,
    rubricClause: 'U3',
    designedAmbiguous: true,
    note: 'Two hours apart, inside C2 dead band, level on everything else. Only relative effort would separate them.',
    left: {
      id: 'ps-he-heavy-02-c',
      title: 'להכין מצגת לישיבת ההנהלה',
      reason: 'due_soon',
      dueAtHours: 5,
      level: 'high',
      source: 'user_explicit',
    },
    right: {
      id: 'ps-he-heavy-02-d',
      title: 'לסיים את סיכום הרבעון',
      reason: 'due_soon',
      dueAtHours: 7,
      level: 'high',
      source: 'user_explicit',
    },
  }),
  pair({
    pairId: 'ps-he-overloaded-01',
    language: 'he',
    loadPattern: 'overloaded',
    openCommitmentCount: 14,
    rubricClause: 'C1',
    split: 'locked',
    note: 'The sharpest test of following the written order: an overdue low/default beats an unscheduled user-set high.',
    left: {
      id: 'ps-he-overloaded-01-a',
      title: 'לחדש את הרישיון עד סוף החודש',
      reason: 'overdue',
      dueAtHours: -21,
      level: 'low',
      source: 'default',
    },
    right: {
      id: 'ps-he-overloaded-01-b',
      title: 'לבדוק הצעות מחיר לתיקון הרכב',
      reason: 'pending',
      level: 'high',
      source: 'user_explicit',
    },
  }),

  /* ── English ─────────────────────────────────────────────────── */
  pair({
    pairId: 'ps-en-light-01',
    language: 'en',
    loadPattern: 'light',
    openCommitmentCount: 2,
    rubricClause: 'C5',
    note: 'Everything level down to C5, where one side carries an ignore inside the 24h recency window.',
    left: {
      id: 'ps-en-light-01-a',
      title: 'Draft the volunteer rota for September',
      reason: 'active',
      ignoredHoursAgo: 3,
    },
    right: {
      id: 'ps-en-light-01-b',
      title: 'Sort out the recycling collection days',
      reason: 'active',
    },
  }),
  pair({
    pairId: 'ps-en-light-02',
    language: 'en',
    loadPattern: 'light',
    openCommitmentCount: 2,
    rubricClause: 'U2',
    designedAmbiguous: true,
    note: 'Turns on whether the claim window has already closed, which the pair does not state.',
    left: {
      id: 'ps-en-light-02-c',
      title: 'Chase the insurance claim before it lapses',
      description: 'The lapse date was never written down',
      reason: 'pending',
    },
    right: {
      id: 'ps-en-light-02-d',
      title: "Confirm the plumber's quote",
      reason: 'pending',
    },
  }),
  pair({
    pairId: 'ps-en-moderate-01',
    language: 'en',
    loadPattern: 'moderate',
    openCommitmentCount: 5,
    rubricClause: 'C2',
    split: 'locked',
    note: 'Eighteen hours apart, well outside the C2 dead band, so C2 decides before importance is consulted.',
    left: {
      id: 'ps-en-moderate-01-a',
      title: 'Submit the grant report',
      reason: 'due_soon',
      dueAtHours: 2,
    },
    right: {
      id: 'ps-en-moderate-01-b',
      title: 'Pick up the prescription',
      reason: 'due_soon',
      dueAtHours: 20,
      level: 'high',
      source: 'user_explicit',
    },
  }),
  pair({
    pairId: 'ps-en-heavy-01',
    language: 'en',
    loadPattern: 'heavy',
    openCommitmentCount: 8,
    rubricClause: 'C1',
    note: 'Overdue-and-snoozed against imminent-and-important. C1 decides; C4 and C3 never run.',
    left: {
      id: 'ps-en-heavy-01-a',
      title: 'Return the faulty router',
      reason: 'overdue',
      dueAtHours: -6,
      level: 'low',
      source: 'default',
      snoozes: 2,
    },
    right: {
      id: 'ps-en-heavy-01-b',
      title: 'Send the quarterly invoice',
      person: 'Nadia',
      reason: 'due_soon',
      dueAtHours: 1,
      level: 'high',
      source: 'user_explicit',
    },
  }),
  pair({
    pairId: 'ps-en-overloaded-01',
    language: 'en',
    loadPattern: 'overloaded',
    openCommitmentCount: 14,
    rubricClause: 'C4',
    note: 'C4 on three snoozes plus a postponement, at the load where a C4 error costs the user a commitment.',
    left: {
      id: 'ps-en-overloaded-01-a',
      title: 'Send the signed lease back to Daniel',
      person: 'Daniel',
      reason: 'active',
      snoozes: 3,
      ackState: 'postponed',
      postponedUntilHours: 24,
    },
    right: {
      id: 'ps-en-overloaded-01-b',
      title: 'Book the annual eye test',
      reason: 'pending',
    },
  }),

  /* ── Mixed script ────────────────────────────────────────────── */
  pair({
    pairId: 'ps-mixed-light-01',
    language: 'mixed',
    loadPattern: 'light',
    openCommitmentCount: 2,
    rubricClause: 'C2',
    split: 'locked',
    note: 'Latin tokens embedded in RTL runs on both sides, so a bidi handling defect shows up as a ranking change.',
    left: {
      id: 'ps-mixed-light-01-a',
      title: 'إرسال invoice للعميل قبل نهاية اليوم',
      reason: 'due_soon',
      dueAtHours: 5,
    },
    right: {
      id: 'ps-mixed-light-01-b',
      title: 'לעדכן את ה-CV באתר LinkedIn',
      reason: 'active',
    },
  }),
  pair({
    pairId: 'ps-mixed-moderate-01',
    language: 'mixed',
    loadPattern: 'moderate',
    openCommitmentCount: 4,
    rubricClause: 'C4a',
    note: 'Both overdue and level to C4; the 36-hour gap clears the 24-hour C4a threshold.',
    left: {
      id: 'ps-mixed-moderate-01-a',
      title: 'رفع report الميزانية على Drive',
      reason: 'overdue',
      dueAtHours: -4,
    },
    right: {
      id: 'ps-mixed-moderate-01-b',
      title: 'לשלם את החשבון של הפיזיותרפיה',
      reason: 'overdue',
      dueAtHours: -40,
    },
  }),
  pair({
    pairId: 'ps-mixed-moderate-02',
    language: 'mixed',
    loadPattern: 'moderate',
    openCommitmentCount: 4,
    rubricClause: 'U3',
    designedAmbiguous: true,
    note: 'Three hours apart inside the C4a threshold and level on everything else; only effort or dependency would decide.',
    left: {
      id: 'ps-mixed-moderate-02-c',
      title: 'تحديث CV قبل مقابلة الاثنين',
      reason: 'overdue',
      dueAtHours: -15,
      level: 'high',
      source: 'user_explicit',
      snoozes: 1,
    },
    right: {
      id: 'ps-mixed-moderate-02-d',
      title: 'Prepare slides לפגישת הצוות',
      reason: 'overdue',
      dueAtHours: -12,
      level: 'high',
      source: 'user_explicit',
      snoozes: 1,
    },
  }),
  pair({
    pairId: 'ps-mixed-heavy-01',
    language: 'mixed',
    loadPattern: 'heavy',
    openCommitmentCount: 9,
    rubricClause: 'C2',
    note: 'At the top of the heavy band, timed against unscheduled with everything else level.',
    left: {
      id: 'ps-mixed-heavy-01-a',
      title: 'تأكيد booking قاعة الاجتماعات',
      reason: 'due_soon',
      dueAtHours: 18,
    },
    right: {
      id: 'ps-mixed-heavy-01-b',
      title: 'לבדוק את ה-warranty של המקרר',
      reason: 'pending',
    },
  }),
  pair({
    pairId: 'ps-mixed-overloaded-01',
    language: 'mixed',
    loadPattern: 'overloaded',
    openCommitmentCount: 14,
    rubricClause: 'C1',
    note: 'Deeply overdue against an unscheduled user-set high, at the load where the ordering matters most.',
    left: {
      id: 'ps-mixed-overloaded-01-a',
      title: 'إرسال الـ signed contract للمحامي',
      reason: 'overdue',
      dueAtHours: -33,
    },
    right: {
      id: 'ps-mixed-overloaded-01-b',
      title: 'לתאם shift עם המנהל',
      reason: 'active',
      level: 'high',
      source: 'user_explicit',
    },
  }),
]);

/* ── Derived views ───────────────────────────────────────────────── */

/** Canonical, side-order-independent name for the bands a pair compares. */
export function reasonMixOf(pair: PrioritySeedPair): ReasonMix {
  const sorted = [pair.left.reason, pair.right.reason].sort(
    (a, b) => REASON_ORDER.indexOf(a) - REASON_ORDER.indexOf(b),
  );
  return `${sorted[0]}|${sorted[1]}`;
}

/**
 * The held-out split, in a stable order. Sorted rather than declaration-ordered
 * because its checksum has to be reproducible from the set alone — see
 * lib/priority/rubric/seedSetLock.ts.
 */
export function lockedSplitPairs(
  pairs: readonly PrioritySeedPair[] = PRIORITY_SEED_PAIRS,
): readonly PrioritySeedPair[] {
  return pairs.filter((pair) => pair.split === 'locked').slice().sort((a, b) => (a.pairId < b.pairId ? -1 : 1));
}

/** Every human-readable string in a pair, for multilingual integrity checks. */
export function seedPairStrings(pair: PrioritySeedPair): readonly string[] {
  const out: string[] = [];
  for (const seedSide of [pair.left, pair.right]) {
    out.push(seedSide.commitment.title);
    if (seedSide.commitment.description) out.push(seedSide.commitment.description);
    if (seedSide.commitment.person) out.push(seedSide.commitment.person);
  }
  return out;
}

/* ── Seeded malformed judgments ──────────────────────────────────── */

/**
 * Deliberately broken judgment rows. These are *loader* test inputs, not
 * judgments and not a corpus: a validator that has never been shown to reject
 * anything is not evidence that the ingestion point is guarded. This mirrors
 * MALFORMED_FIXTURES in tests/fixtures/lifeStateMemoryFixtures.ts.
 */
export interface MalformedJudgmentCase {
  readonly id: string;
  readonly defect: string;
  readonly expectedIssueCode: string;
  readonly row: unknown;
}

const WELL_FORMED_ROW = Object.freeze({
  pairId: 'ps-ar-light-01',
  leftCommitmentId: 'ps-ar-light-01-a',
  rightCommitmentId: 'ps-ar-light-01-b',
  verdict: 'left',
  annotatorId: 'ann-a',
  rationale: 'C1 — left is overdue and right is not',
  judgedAt: '2026-08-18T10:00:00.000Z',
});

function broken(overrides: Record<string, unknown>): unknown {
  return { ...WELL_FORMED_ROW, ...overrides };
}

export const MALFORMED_JUDGMENTS: readonly MalformedJudgmentCase[] = Object.freeze([
  {
    id: 'row-not-an-object',
    defect: 'the row is a string rather than a judgment',
    expectedIssueCode: 'PRJ010',
    row: 'ps-ar-light-01: left',
  },
  {
    id: 'missing-pair-id',
    defect: 'no pairId, so the verdict refers to nothing',
    expectedIssueCode: 'PRJ011',
    row: broken({ pairId: '' }),
  },
  {
    id: 'self-comparison',
    defect: 'both sides name the same commitment',
    expectedIssueCode: 'PRJ014',
    row: broken({ rightCommitmentId: 'ps-ar-light-01-a' }),
  },
  {
    id: 'verdict-outside-vocabulary',
    defect: 'a verdict the contract does not define',
    expectedIssueCode: 'PRJ015',
    row: broken({ verdict: 'maybe' }),
  },
  {
    id: 'anonymous-annotator',
    defect: 'no annotatorId, so agreement cannot be computed at all',
    expectedIssueCode: 'PRJ016',
    row: broken({ annotatorId: '   ' }),
  },
  {
    id: 'empty-rationale',
    defect: 'a verdict with no rationale, which cannot be audited against the rubric',
    expectedIssueCode: 'PRJ017',
    row: broken({ rationale: '' }),
  },
  {
    id: 'unparseable-timestamp',
    defect: 'judgedAt is not an ISO timestamp',
    expectedIssueCode: 'PRJ018',
    row: broken({ judgedAt: 'last tuesday' }),
  },
  {
    id: 'unknown-field',
    defect: 'an extra field, which usually means a schema the loader does not understand',
    expectedIssueCode: 'PRJ019',
    row: broken({ confidence: 0.9 }),
  },
]);
