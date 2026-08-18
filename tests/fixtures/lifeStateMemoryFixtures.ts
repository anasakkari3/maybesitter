/**
 * SYNTHETIC — ENGINEERING QA ONLY — NOT HUMAN EVIDENCE
 *
 * Life-State and runtime-memory contract fixtures (Sprint 02, issue #11).
 *
 * Every string, identifier, timestamp and scope in this file is invented for
 * engineering QA. Nothing here is production user data, pilot data, or V03
 * human evidence, and nothing here may be presented as such.
 *
 * ── What this corpus is ────────────────────────────────────────────
 *
 * This is the executable specification for two behaviours the Sprint 02
 * contracts declare but cannot enforce on their own:
 *
 *   1. `Field<T>` semantics in src/contracts/v1/lifeStateContracts.ts — in
 *      particular that "known to be zero" and "not known" are different
 *      values, and that every field carries provenance.
 *   2. Runtime-memory record-status behaviour in
 *      src/contracts/v1/memoryContracts.ts — staleness, supersession,
 *      retrieval visibility and export policy.
 *
 * Each fixture therefore declares the *expected decision*, not just an input.
 * A fixture that asserts something vague is worse than no fixture, so where
 * the committed contracts genuinely do not determine a value, the fixture
 * says so explicitly (`unpinned`, `staleAfterNote`) instead of guessing.
 *
 * ── The matrix ─────────────────────────────────────────────────────
 *
 * Four context conditions × four languages, 16 positive fixtures:
 *
 *   missing      Nothing to ground on. DomainState is empty and the scope has
 *                no retrievable memory. Every LifeState field must be
 *                { known: false, reason: 'NO_DATA' }. A language-tagged probe
 *                record exists under a *different* scope, so "no data for this
 *                scope" is provably not "no data anywhere".
 *   stale        Data exists but is old. The domain input is ~6 months behind
 *                the clock, so recentOutcomes inside the 14-day window is
 *                known-zero (NOT unknown). The memory record is past its
 *                staleAfter boundary: retrieve() must miss it and prune() must
 *                expire it.
 *   conflicting  Two commitments claim the same instant, and memory holds both
 *                a supersession chain and an unresolved contradiction. Nothing
 *                may be silently merged, dropped, or auto-resolved.
 *   sensitive    Clinical content. Records must resolve to
 *                exportPolicy 'personal_never_export' (including when the
 *                caller omits the field), and no commitment title or person
 *                may appear anywhere in the projected LifeState.
 *
 * The expected decision for a condition is *language-invariant*: only the ids
 * and the text change across ar | he | en | mixed. A language-dependent
 * decision is a multilingual regression by definition.
 *
 * ── Reading rules this corpus commits to ───────────────────────────
 *
 * The contracts leave a few things open. Where a fixture must choose, it
 * chooses once, here, and says why:
 *
 *  - `provenance.derivedFrom` is the newest `updatedAt` among the DomainState
 *    records that feed *that* field. Fields fed by open commitments only
 *    (availability, load) therefore carry an older `derivedFrom` than
 *    `commitments`, which is fed by every commitment. When no record feeds the
 *    field (recentOutcomes with nothing inside the window), `derivedFrom` is
 *    null while `source` stays 'domain_state' — the field is known-zero, not
 *    unknown.
 *  - `provenance.computedAt` always equals the fixture clock. A projection
 *    that reads the system clock fails every fixture at once.
 *  - Commitment id arrays (`openCommitmentIds`, `overdueCommitmentIds`) are
 *    compared as *sets*; the contract fixes no ordering. `busyWindows` is
 *    compared in order, ascending by `startsAt` then by `commitmentId`, which
 *    is the only deterministic ordering available.
 *  - `staleAfter` is `putAt + ttlMs`, i.e. it is measured from write time and
 *    never from `observedAt`. A fact observed long ago but recorded today is
 *    not born stale. The `sensitive` fixtures deliberately carry a record whose
 *    `observedAt` precedes its `createdAt` to pin that distinction.
 *  - `retrieve()` results are ordered newest-`observedAt` first, per the
 *    memory contract. Fixtures avoid `observedAt` ties so the order is total.
 */
import type { Commitment, DomainState, Priority, TimeSpec } from '../../src/domain/stateMachine';
import {
  DEFAULT_RECENT_OUTCOMES_WINDOW_DAYS,
  type AvailabilityView,
  type CommitmentsView,
  type FieldProvenance,
  type LoadView,
  type RecentOutcomesView,
  type UnknownReason,
} from '../../src/contracts/v1/lifeStateContracts';
import {
  DEFAULT_MEMORY_TTL_MS,
  type CreateMemoryInput,
  type ExportPolicy,
  type MemoryLanguage,
  type MemoryStatus,
} from '../../src/contracts/v1/memoryContracts';

/* ── Fixed clock ─────────────────────────────────────────────────── */

const DAY_MS = 24 * 60 * 60 * 1_000;

/** The one clock every fixture is expressed against. Nothing here reads Date.now(). */
export const FIXTURE_CLOCK = new Date('2026-08-18T09:00:00.000Z');
export const FIXTURE_CLOCK_ISO = FIXTURE_CLOCK.toISOString();

/** windowStart for the default 14-day recentOutcomes lookback. */
export const RECENT_OUTCOMES_WINDOW_START = new Date(
  FIXTURE_CLOCK.getTime() - DEFAULT_RECENT_OUTCOMES_WINDOW_DAYS * DAY_MS,
).toISOString();

function atOffsetDays(days: number, hourUtc: number, minuteUtc = 0): string {
  const d = new Date(FIXTURE_CLOCK.getTime() + days * DAY_MS);
  d.setUTCHours(hourUtc, minuteUtc, 0, 0);
  return d.toISOString();
}

function staleAfterFrom(createdAt: string, ttlMs: number = DEFAULT_MEMORY_TTL_MS): string {
  return new Date(Date.parse(createdAt) + ttlMs).toISOString();
}

const T_MINUS_205 = atOffsetDays(-205, 8);
const T_MINUS_200 = atOffsetDays(-200, 8);
const T_MINUS_182 = atOffsetDays(-182, 8);
const T_MINUS_180 = atOffsetDays(-180, 8);
const T_MINUS_120 = atOffsetDays(-120, 9);
const T_MINUS_30 = atOffsetDays(-30, 9);
const T_MINUS_20 = atOffsetDays(-20, 9);
const T_MINUS_13 = atOffsetDays(-13, 9);
const T_MINUS_10 = atOffsetDays(-10, 9);
const T_MINUS_3 = atOffsetDays(-3, 9);
const T_PLUS_2_1100 = atOffsetDays(2, 11);
const T_PLUS_6_0815 = atOffsetDays(6, 8, 15);

const FIXTURE_TIMEZONE = 'Asia/Jerusalem';

/* ── Vocabularies ────────────────────────────────────────────────── */

/**
 * Exhaustive over MemoryLanguage. Adding a language to the contract without
 * adding fixtures for it breaks this file at compile time, before the
 * coverage test ever runs.
 */
const LANGUAGE_VOCABULARY: Record<MemoryLanguage, true> = { ar: true, he: true, en: true, mixed: true };
export const FIXTURE_LANGUAGES: readonly MemoryLanguage[] = Object.freeze(
  Object.keys(LANGUAGE_VOCABULARY) as MemoryLanguage[],
);

export type ContextCondition = 'missing' | 'stale' | 'conflicting' | 'sensitive';

const CONDITION_VOCABULARY: Record<ContextCondition, true> = {
  missing: true,
  stale: true,
  conflicting: true,
  sensitive: true,
};
export const CONTEXT_CONDITIONS: readonly ContextCondition[] = Object.freeze(
  Object.keys(CONDITION_VOCABULARY) as ContextCondition[],
);

/* ── Expectation types ───────────────────────────────────────────── */

export interface ExpectedProvenance {
  readonly source: FieldProvenance['source'];
  readonly derivedFrom: string | null;
  readonly computedAt: string;
}

export interface ExpectedUnknownField {
  readonly known: false;
  readonly reason: UnknownReason;
  readonly provenance: ExpectedProvenance;
}

export interface ExpectedKnownField<T> {
  readonly known: true;
  readonly value: T;
  readonly provenance: ExpectedProvenance;
  /** View keys deliberately not pinned, mapped to the reason they are not. */
  readonly unpinned?: Readonly<Record<string, string>>;
}

export type ExpectedField<T> = ExpectedUnknownField | ExpectedKnownField<T>;

/** load's urgency score and due-soon horizon are implementation-owned; see `unpinned`. */
export type PinnedLoadView = Pick<LoadView, 'openCount' | 'overdueCount' | 'band'>;

export interface ExpectedLifeState {
  readonly commitments: ExpectedField<CommitmentsView>;
  readonly availability: ExpectedField<AvailabilityView>;
  readonly load: ExpectedField<PinnedLoadView>;
  readonly recentOutcomes: ExpectedField<RecentOutcomesView>;
}

export interface LifeStateFixtureSection {
  /** Exactly the LifeStateInput the projection under test receives. */
  readonly input: {
    readonly state: DomainState;
    readonly now: string;
    readonly scopeId: string;
    readonly windowDays?: number;
  };
  readonly expected: ExpectedLifeState;
}

export interface ExpectedMemoryRecord {
  /** Status as stored at the fixture clock, before prune() runs. */
  readonly statusBeforePrune: MemoryStatus;
  /** Status after prune(FIXTURE_CLOCK_ISO). Identical unless the record is stale. */
  readonly statusAfterPrune: MemoryStatus;
  /** Resolved policy, i.e. after the contract default is applied. */
  readonly exportPolicy: ExportPolicy;
  /** putAt + ttlMs. Measured from write time, never from observedAt. */
  readonly staleAfter: string;
  /** staleAfter <= fixture clock. */
  readonly staleAtNow: boolean;
  /** Appears in retrieve({ scopeId, now: FIXTURE_CLOCK_ISO }). */
  readonly retrievableAtNow: boolean;
  /** Appears in listAll(fixture scopeId). False for records held under another scope. */
  readonly listedInScope: boolean;
  readonly supersedesHandle?: string;
  readonly supersededByHandle?: string;
}

export interface MemoryFixtureRecord {
  /** Stable local handle. Store-assigned ids are not knowable from a fixture. */
  readonly handle: string;
  /** The ISO `now` passed to put()/supersede(), hence the record's createdAt. */
  readonly putAt: string;
  /** put() writes this record as a replacement for the named handle. */
  readonly supersedesHandle?: string;
  readonly input: CreateMemoryInput;
  /** Clinical, financial or otherwise categorically sensitive content. */
  readonly sensitive: boolean;
  readonly expected: ExpectedMemoryRecord;
}

export interface MemoryFixtureSection {
  /** Written in order; `supersedesHandle` records go through supersede(). */
  readonly records: readonly MemoryFixtureRecord[];
  /** Exact, ordered newest-observedAt first. */
  readonly expectedRetrieveHandles: readonly string[];
  /** Exact set returned by listAll(fixture scopeId). */
  readonly expectedListAllHandles: readonly string[];
  /** Return value of prune(FIXTURE_CLOCK_ISO), across every record written. */
  readonly expectedPrunedCount: number;
  /** assertNoPersonalMemory(listAll(scopeId)) throws. */
  readonly expectedAssertNoPersonalMemoryThrows: boolean;
  readonly expectedShareableAggregateHandles: readonly string[];
}

export interface LifeStateMemoryFixture {
  readonly id: string;
  readonly language: MemoryLanguage;
  readonly condition: ContextCondition;
  readonly scopeId: string;
  /** Always the fixture clock. Duplicated per fixture so a fixture reads standalone. */
  readonly now: string;
  readonly description: string;
  /** Why the expected decision is what it is. Read this before changing an expectation. */
  readonly notes: string;
  readonly lifeState: LifeStateFixtureSection;
  readonly memory: MemoryFixtureSection;
  /**
   * Strings present in the DomainState that must NOT appear anywhere in
   * JSON.stringify(projectLifeState(input)). LifeState carries ids and counts,
   * never commitment content.
   */
  readonly expectedAbsentFromProjection: readonly string[];
}

/* ── Multilingual content ────────────────────────────────────────── */

interface LanguageContent {
  readonly probe: string;
  readonly staleFact: string;
  readonly conflictOriginal: string;
  readonly conflictReplacement: string;
  readonly conflictUnresolved: string;
  readonly aggregateFact: string;
  readonly sensitiveClinical: string;
  readonly sensitiveMedication: string;
  readonly staleOverdueTitle: string;
  readonly staleCompletedTitle: string;
  readonly conflictTitleA: string;
  readonly conflictTitleB: string;
  readonly conflictTitleD: string;
  readonly conflictCompletedTitle: string;
  readonly sensitiveTitle: string;
  readonly sensitivePerson: string;
}

/**
 * Realistic logical-order text. RTL strings deliberately embed Latin words,
 * ASCII digits and (in Arabic) Arabic-Indic digits, because a bare RTL string
 * round-trips trivially while a bidirectional one is where reordering and
 * control-character damage actually show up. No string contains a bidi control
 * character; the fixture validator rejects any that does.
 */
const CONTENT: Record<MemoryLanguage, LanguageContent> = {
  ar: {
    probe: 'تجديد اشتراك Netflix قبل 27/09',
    staleFact: 'مكتب الشركة انتقل إلى شارع Rothschild 22 بتاريخ 15/04',
    conflictOriginal: 'اجتماع فريق Dev الأسبوعي يوم الأحد الساعة 10:00',
    conflictReplacement: 'اجتماع فريق Dev الأسبوعي انتقل إلى الثلاثاء الساعة 11:30',
    conflictUnresolved: 'سارة تفضل التواصل عبر WhatsApp وليس عبر البريد الإلكتروني',
    aggregateFact: 'نافذة الملخص المسائي الافتراضية في المنتج هي 20:00-21:00',
    sensitiveClinical: 'موعد متابعة السكري في عيادة Clalit يوم 24/08 الساعة 08:15',
    sensitiveMedication: 'جرعة Metformin اليومية بعد الفطور الساعة ٨ صباحا',
    staleOverdueTitle: 'تسليم تقرير الربع الأول لشركة Bezeq',
    staleCompletedTitle: 'دفع فاتورة الكهرباء رقم 4417',
    conflictTitleA: 'اجتماع فريق Dev',
    conflictTitleB: 'مكالمة مع المحاسب زياد',
    conflictTitleD: 'ترتيب أوراق التأمين',
    conflictCompletedTitle: 'إرسال العقد الموقع إلى ليلى',
    sensitiveTitle: 'مراجعة نتائج فحص الدم في عيادة Clalit',
    sensitivePerson: 'د. ندى حداد',
  },
  he: {
    probe: 'להאריך את המנוי ל-Spotify עד 30/09',
    staleFact: 'משרד החברה עבר לרחוב Rothschild 22 בתאריך 15/04',
    conflictOriginal: 'ישיבת צוות Dev השבועית ביום ראשון בשעה 10:00',
    conflictReplacement: 'ישיבת צוות Dev השבועית עברה ליום שלישי בשעה 11:30',
    conflictUnresolved: 'רונית מעדיפה תקשורת ב-WhatsApp ולא במייל',
    aggregateFact: 'חלון סיכום הערב שהוא ברירת המחדל במוצר הוא 20:00-21:00',
    sensitiveClinical: 'תור מעקב סוכרת במרפאת Maccabi ב-24/08 בשעה 08:15',
    sensitiveMedication: 'מנת Metformin יומית אחרי ארוחת בוקר בשעה 8:00',
    staleOverdueTitle: 'הגשת דוח רבעון ראשון לחברת Partner',
    staleCompletedTitle: 'תשלום חשבון החשמל מספר 4417',
    conflictTitleA: 'ישיבת צוות Dev',
    conflictTitleB: 'שיחה עם רואה החשבון יוסי',
    conflictTitleD: 'סידור מסמכי הביטוח',
    conflictCompletedTitle: 'שליחת החוזה החתום לליאת',
    sensitiveTitle: 'בדיקת דם במרפאת Maccabi',
    sensitivePerson: 'ד"ר נדב הדר',
  },
  en: {
    probe: 'Renew the Spotify subscription before 2026-09-30',
    staleFact: 'The office moved to Rothschild 22 on 2026-04-15',
    conflictOriginal: 'The weekly Dev sync is on Sunday at 10:00',
    conflictReplacement: 'The weekly Dev sync moved to Tuesday at 11:30',
    conflictUnresolved: 'Ronit prefers WhatsApp over email',
    aggregateFact: 'The product default evening digest window is 20:00-21:00',
    sensitiveClinical: 'Diabetes follow-up at the Maccabi clinic on 2026-08-24 at 08:15',
    sensitiveMedication: 'Daily Metformin dose after breakfast at 08:00',
    staleOverdueTitle: 'Submit the Q1 report to Partner',
    staleCompletedTitle: 'Pay electricity bill 4417',
    conflictTitleA: 'Dev team sync',
    conflictTitleB: 'Call the accountant Yossi',
    conflictTitleD: 'Sort the insurance paperwork',
    conflictCompletedTitle: 'Send the signed contract to Liat',
    sensitiveTitle: 'Blood test at the Maccabi clinic',
    sensitivePerson: 'Dr. Nadav Hadar',
  },
  mixed: {
    probe: 'Renew اشتراك Netflix قبل 30/09',
    staleFact: 'The office עבר לרחוב Rothschild 22 بتاريخ 15/04',
    conflictOriginal: 'Weekly sync مع فريق Dev on Sunday 10:00',
    conflictReplacement: 'Weekly sync مع فريق Dev moved to יום שלישי 11:30',
    conflictUnresolved: 'רונית prefers WhatsApp وليس البريد الإلكتروني',
    aggregateFact: 'Default evening digest window هي 20:00-21:00',
    sensitiveClinical: 'Diabetes follow-up במרפאת Maccabi يوم 24/08 at 08:15',
    sensitiveMedication: 'Daily Metformin جرعة after breakfast at 08:00',
    staleOverdueTitle: 'Submit تقرير الربع الأول to Partner',
    staleCompletedTitle: 'Pay فاتورة الكهرباء 4417',
    conflictTitleA: 'Dev team اجتماع',
    conflictTitleB: 'Call المحاسب Yossi',
    conflictTitleD: 'Sort أوراق التأمين',
    conflictCompletedTitle: 'Send the signed חוזה to ليلى',
    sensitiveTitle: 'Blood test במרפאת Maccabi',
    sensitivePerson: 'ד"ר ندى حداد',
  },
};

/* ── DomainState builders ────────────────────────────────────────── */

const DEFAULT_PRIORITY: Priority = {
  level: 'normal',
  source: 'default',
  pressureAllowed: true,
  pressureLevel: 'gentle',
};

function timeSpec(overrides: Partial<TimeSpec> = {}): TimeSpec {
  return { kind: 'unscheduled', dueAt: null, remindAt: null, timezone: FIXTURE_TIMEZONE, ...overrides };
}

function commitment(base: Pick<Commitment, 'id' | 'title'> & Partial<Commitment>): Commitment {
  return {
    kind: 'task',
    description: null,
    person: null,
    status: 'active',
    priority: DEFAULT_PRIORITY,
    timeSpec: timeSpec(),
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: T_MINUS_10,
    updatedAt: T_MINUS_10,
    confirmedAt: T_MINUS_10,
    completedAt: null,
    droppedAt: null,
    ...base,
  };
}

function stateOf(commitments: readonly Commitment[]): DomainState {
  const byId: Record<string, Commitment> = {};
  for (const c of commitments) byId[c.id] = c;
  return { commitments: byId, reminders: {}, escalationStates: {} };
}

/** Every piece of user content in the state, so absence assertions cannot be vacuous. */
function contentStringsOf(state: DomainState): readonly string[] {
  const out = new Set<string>();
  for (const c of Object.values(state.commitments)) {
    out.add(c.title);
    if (c.person) out.add(c.person);
    if (c.description) out.add(c.description);
  }
  return Object.freeze(Array.from(out).sort());
}

/* ── Expectation builders ────────────────────────────────────────── */

function absentProvenance(): ExpectedProvenance {
  return { source: 'absent', derivedFrom: null, computedAt: FIXTURE_CLOCK_ISO };
}

function domainProvenance(derivedFrom: string | null): ExpectedProvenance {
  return { source: 'domain_state', derivedFrom, computedAt: FIXTURE_CLOCK_ISO };
}

function noData(): ExpectedUnknownField {
  return { known: false, reason: 'NO_DATA', provenance: absentProvenance() };
}

const LOAD_UNPINNED: Readonly<Record<string, string>> = Object.freeze({
  totalUrgencyScore:
    'Sum of agenda urgency scores. lib/utils/agendaScoring fixes the formula, the contract does not; owned by the projection (#9).',
  dueSoonCount:
    'The contract defines no "due soon" horizon, so a fixture pinning a number here would be inventing one; owned by the projection (#9).',
});

function emptyOutcomes(derivedFrom: string | null): ExpectedKnownField<RecentOutcomesView> {
  return {
    known: true,
    value: {
      windowDays: DEFAULT_RECENT_OUTCOMES_WINDOW_DAYS,
      windowStart: RECENT_OUTCOMES_WINDOW_START,
      completedCount: 0,
      postponedCount: 0,
      ignoredCount: 0,
      droppedCount: 0,
      countsByAckState: {},
    },
    provenance: domainProvenance(derivedFrom),
  };
}

/* ── Memory builders ─────────────────────────────────────────────── */

interface MemoryRecordSpec {
  readonly handle: string;
  readonly scopeId: string;
  readonly putAt: string;
  readonly observedAt?: string;
  readonly content: string;
  readonly language: MemoryLanguage;
  readonly kind: CreateMemoryInput['kind'];
  readonly source: CreateMemoryInput['source'];
  readonly confidence: number;
  readonly evidenceIds: readonly string[];
  readonly exportPolicy?: ExportPolicy;
  readonly sensitive?: boolean;
  readonly supersedesHandle?: string;
  readonly expected: Omit<ExpectedMemoryRecord, 'exportPolicy' | 'staleAfter' | 'staleAtNow'> & {
    readonly exportPolicy?: ExportPolicy;
  };
}

function memoryRecord(spec: MemoryRecordSpec): MemoryFixtureRecord {
  const observedAt = spec.observedAt ?? spec.putAt;
  // Write time, not observation time: an old fact recorded today is not born stale.
  const staleAfter = staleAfterFrom(spec.putAt);
  const staleAtNow = Date.parse(staleAfter) <= FIXTURE_CLOCK.getTime();

  return {
    handle: spec.handle,
    putAt: spec.putAt,
    ...(spec.supersedesHandle ? { supersedesHandle: spec.supersedesHandle } : {}),
    input: {
      scopeId: spec.scopeId,
      kind: spec.kind,
      content: spec.content,
      language: spec.language,
      source: spec.source,
      confidence: spec.confidence,
      observedAt,
      evidenceIds: spec.evidenceIds,
      ...(spec.exportPolicy ? { exportPolicy: spec.exportPolicy } : {}),
    },
    sensitive: spec.sensitive ?? false,
    expected: {
      ...spec.expected,
      exportPolicy: spec.expected.exportPolicy ?? 'personal_never_export',
      staleAfter,
      staleAtNow,
    },
  };
}

/* ── Condition builders ──────────────────────────────────────────── */

function scopeOf(language: MemoryLanguage): string {
  return `scope-s02-${language}`;
}

function missingFixture(language: MemoryLanguage): LifeStateMemoryFixture {
  const scopeId = scopeOf(language);
  const otherScopeId = `${scopeId}-other`;
  const content = CONTENT[language];
  const state = stateOf([]);

  return {
    id: `${language}-missing`,
    language,
    condition: 'missing',
    scopeId,
    now: FIXTURE_CLOCK_ISO,
    description: 'Empty DomainState and no in-scope memory: nothing to ground on.',
    notes:
      'This is the fixture that keeps "unknown" distinct from "zero", in both directions. ' +
      'DomainState is the authoritative record of commitments, so an empty one means zero ' +
      'commitments with certainty: `commitments` and `load` are known-zero, and a projection ' +
      'reporting them as unknown fails here. `availability` and `recentOutcomes` describe a world ' +
      'wider than our records — an empty commitment list does not make the user free, and no ' +
      'history is not behavioural evidence — so those stay NO_DATA with an absent source. ' +
      'The probe record proves the scope filter, not the store, is what makes retrieval empty: it ' +
      'is written under a neighbouring scope and must be invisible to both retrieve() and ' +
      'listAll() for this scope.',
    lifeState: {
      input: { state, now: FIXTURE_CLOCK_ISO, scopeId },
      expected: {
        commitments: {
          known: true,
          value: {
            countsByStatus: {},
            openCount: 0,
            overdueCount: 0,
            openCommitmentIds: [],
            overdueCommitmentIds: [],
          },
          provenance: absentProvenance(),
        },
        availability: noData(),
        load: {
          known: true,
          value: { openCount: 0, overdueCount: 0, band: 'light' },
          provenance: absentProvenance(),
          unpinned: LOAD_UNPINNED,
        },
        recentOutcomes: noData(),
      },
    },
    memory: {
      records: [
        memoryRecord({
          handle: 'probe',
          scopeId: otherScopeId,
          putAt: T_MINUS_10,
          content: content.probe,
          language,
          kind: 'fact',
          source: 'user_stated',
          confidence: 0.9,
          evidenceIds: [`obs-${language}-missing-1`],
          expected: {
            statusBeforePrune: 'active',
            statusAfterPrune: 'active',
            retrievableAtNow: false,
            listedInScope: false,
          },
        }),
      ],
      expectedRetrieveHandles: [],
      expectedListAllHandles: [],
      expectedPrunedCount: 0,
      expectedAssertNoPersonalMemoryThrows: false,
      expectedShareableAggregateHandles: [],
    },
    expectedAbsentFromProjection: contentStringsOf(state),
  };
}

function staleFixture(language: MemoryLanguage): LifeStateMemoryFixture {
  const scopeId = scopeOf(language);
  const content = CONTENT[language];
  const overdueId = `cmt-stale-${language}-a`;
  const completedId = `cmt-stale-${language}-b`;

  const state = stateOf([
    commitment({
      id: overdueId,
      title: content.staleOverdueTitle,
      status: 'active',
      timeSpec: timeSpec({ kind: 'due_by', dueAt: T_MINUS_200, remindAt: T_MINUS_200 }),
      createdAt: T_MINUS_205,
      updatedAt: T_MINUS_200,
      confirmedAt: T_MINUS_205,
    }),
    commitment({
      id: completedId,
      title: content.staleCompletedTitle,
      status: 'completed',
      currentAckState: 'completed',
      timeSpec: timeSpec({ kind: 'due_by', dueAt: T_MINUS_182, remindAt: T_MINUS_182 }),
      createdAt: T_MINUS_205,
      updatedAt: T_MINUS_180,
      confirmedAt: T_MINUS_205,
      completedAt: T_MINUS_180,
    }),
  ]);

  return {
    id: `${language}-stale`,
    language,
    condition: 'stale',
    scopeId,
    now: FIXTURE_CLOCK_ISO,
    description: 'Domain input roughly six months old; the memory record is past its TTL boundary.',
    notes:
      'The point of this fixture is that old data is still data. commitments, availability and load are ' +
      'known — with an old derivedFrom — while recentOutcomes is known-ZERO rather than unknown, because ' +
      'the 14-day window genuinely observed no outcome. Returning INSUFFICIENT_DATA for recentOutcomes ' +
      'here would collapse "nothing happened" into "we do not know", which the Field<T> invariant exists ' +
      'to prevent. On the memory side the record is stale at the clock: retrieve() must miss it before ' +
      'prune() runs, and prune() must move it to expired.',
    lifeState: {
      input: { state, now: FIXTURE_CLOCK_ISO, scopeId },
      expected: {
        commitments: {
          known: true,
          value: {
            countsByStatus: { active: 1, completed: 1 },
            openCount: 1,
            overdueCount: 1,
            openCommitmentIds: [overdueId],
            overdueCommitmentIds: [overdueId],
          },
          // Newest updatedAt across all commitments: the completed one.
          provenance: domainProvenance(T_MINUS_180),
        },
        availability: {
          known: true,
          value: {
            busyWindows: [
              {
                commitmentId: overdueId,
                startsAt: T_MINUS_200,
                endsAt: null,
                timezone: FIXTURE_TIMEZONE,
                kind: 'due_by',
              },
            ],
            unscheduledCommitmentCount: 0,
          },
          // Fed by open commitments only, so the completed record does not contribute.
          provenance: domainProvenance(T_MINUS_200),
        },
        load: {
          known: true,
          value: { openCount: 1, overdueCount: 1, band: 'light' },
          provenance: domainProvenance(T_MINUS_200),
          unpinned: LOAD_UNPINNED,
        },
        // Nothing inside the window fed this field, hence derivedFrom null with a known value.
        recentOutcomes: emptyOutcomes(null),
      },
    },
    memory: {
      records: [
        memoryRecord({
          handle: 'stale-fact',
          scopeId,
          putAt: T_MINUS_120,
          content: content.staleFact,
          language,
          kind: 'fact',
          source: 'user_stated',
          confidence: 0.85,
          evidenceIds: [`obs-${language}-stale-1`],
          expected: {
            statusBeforePrune: 'active',
            statusAfterPrune: 'expired',
            retrievableAtNow: false,
            listedInScope: true,
          },
        }),
      ],
      expectedRetrieveHandles: [],
      expectedListAllHandles: ['stale-fact'],
      expectedPrunedCount: 1,
      expectedAssertNoPersonalMemoryThrows: true,
      expectedShareableAggregateHandles: [],
    },
    expectedAbsentFromProjection: contentStringsOf(state),
  };
}

function conflictingFixture(language: MemoryLanguage): LifeStateMemoryFixture {
  const scopeId = scopeOf(language);
  const content = CONTENT[language];
  const idA = `cmt-conflicting-${language}-a`;
  const idB = `cmt-conflicting-${language}-b`;
  const idC = `cmt-conflicting-${language}-c`;
  const idD = `cmt-conflicting-${language}-d`;

  const state = stateOf([
    commitment({
      id: idA,
      title: content.conflictTitleA,
      status: 'active',
      timeSpec: timeSpec({ kind: 'scheduled_event', dueAt: T_PLUS_2_1100, remindAt: T_PLUS_2_1100 }),
    }),
    commitment({
      id: idB,
      title: content.conflictTitleB,
      status: 'active',
      person: content.sensitivePerson,
      timeSpec: timeSpec({ kind: 'scheduled_event', dueAt: T_PLUS_2_1100, remindAt: T_PLUS_2_1100 }),
    }),
    commitment({
      id: idC,
      title: content.conflictCompletedTitle,
      status: 'completed',
      currentAckState: 'completed',
      timeSpec: timeSpec({ kind: 'due_by', dueAt: T_MINUS_3, remindAt: T_MINUS_3 }),
      updatedAt: T_MINUS_3,
      completedAt: T_MINUS_3,
    }),
    commitment({ id: idD, title: content.conflictTitleD, status: 'active' }),
  ]);

  return {
    id: `${language}-conflicting`,
    language,
    condition: 'conflicting',
    scopeId,
    now: FIXTURE_CLOCK_ISO,
    description:
      'Two commitments claim the same instant; memory holds a supersession chain plus an unresolved contradiction.',
    notes:
      'Nothing may be auto-resolved. availability must surface both windows at the same startsAt rather ' +
      'than merging or dropping one — the projection reports the conflict, a later module decides about ' +
      'it. On the memory side the superseded record stays inspectable via listAll() while retrieve() ' +
      'returns only the replacement, and the contradictory preference stays active alongside it because ' +
      'nothing superseded it. This fixture also carries the corpus’s only shareable_aggregate record ' +
      '(a product-level fact with no user content), the open unscheduled commitment that exercises ' +
      'unscheduledCommitmentCount, and the only non-zero recentOutcomes window.',
    lifeState: {
      input: { state, now: FIXTURE_CLOCK_ISO, scopeId },
      expected: {
        commitments: {
          known: true,
          value: {
            countsByStatus: { active: 3, completed: 1 },
            openCount: 3,
            overdueCount: 0,
            openCommitmentIds: [idA, idB, idD],
            overdueCommitmentIds: [],
          },
          provenance: domainProvenance(T_MINUS_3),
        },
        availability: {
          known: true,
          value: {
            busyWindows: [
              {
                commitmentId: idA,
                startsAt: T_PLUS_2_1100,
                endsAt: null,
                timezone: FIXTURE_TIMEZONE,
                kind: 'scheduled_event',
              },
              {
                commitmentId: idB,
                startsAt: T_PLUS_2_1100,
                endsAt: null,
                timezone: FIXTURE_TIMEZONE,
                kind: 'scheduled_event',
              },
            ],
            unscheduledCommitmentCount: 1,
          },
          provenance: domainProvenance(T_MINUS_10),
        },
        load: {
          known: true,
          // 3 open commitments: above LOAD_BAND_THRESHOLDS.light (2), at or below moderate (5).
          value: { openCount: 3, overdueCount: 0, band: 'moderate' },
          provenance: domainProvenance(T_MINUS_10),
          unpinned: LOAD_UNPINNED,
        },
        recentOutcomes: {
          known: true,
          value: {
            windowDays: DEFAULT_RECENT_OUTCOMES_WINDOW_DAYS,
            windowStart: RECENT_OUTCOMES_WINDOW_START,
            completedCount: 1,
            postponedCount: 0,
            ignoredCount: 0,
            droppedCount: 0,
            countsByAckState: { completed: 1 },
          },
          provenance: domainProvenance(T_MINUS_3),
        },
      },
    },
    memory: {
      records: [
        memoryRecord({
          handle: 'aggregate',
          scopeId,
          putAt: T_MINUS_20,
          content: content.aggregateFact,
          language,
          kind: 'fact',
          source: 'deterministic_rule',
          confidence: 1,
          evidenceIds: [],
          exportPolicy: 'shareable_aggregate',
          expected: {
            statusBeforePrune: 'active',
            statusAfterPrune: 'active',
            exportPolicy: 'shareable_aggregate',
            retrievableAtNow: true,
            listedInScope: true,
          },
        }),
        memoryRecord({
          handle: 'original',
          scopeId,
          putAt: T_MINUS_30,
          content: content.conflictOriginal,
          language,
          kind: 'fact',
          source: 'user_stated',
          confidence: 0.8,
          evidenceIds: [`obs-${language}-conflicting-1`],
          expected: {
            statusBeforePrune: 'superseded',
            statusAfterPrune: 'superseded',
            retrievableAtNow: false,
            listedInScope: true,
            supersededByHandle: 'replacement',
          },
        }),
        memoryRecord({
          handle: 'replacement',
          scopeId,
          putAt: T_MINUS_10,
          supersedesHandle: 'original',
          content: content.conflictReplacement,
          language,
          kind: 'fact',
          source: 'user_stated',
          confidence: 0.9,
          evidenceIds: [`obs-${language}-conflicting-2`],
          expected: {
            statusBeforePrune: 'active',
            statusAfterPrune: 'active',
            retrievableAtNow: true,
            listedInScope: true,
            supersedesHandle: 'original',
          },
        }),
        memoryRecord({
          handle: 'unresolved',
          scopeId,
          putAt: T_MINUS_3,
          content: content.conflictUnresolved,
          language,
          kind: 'preference',
          source: 'model_inferred',
          confidence: 0.7,
          evidenceIds: [`obs-${language}-conflicting-3`],
          expected: {
            statusBeforePrune: 'active',
            statusAfterPrune: 'active',
            retrievableAtNow: true,
            listedInScope: true,
          },
        }),
      ],
      // Newest observedAt first: T-3, T-10, T-20. No ties, so the order is total.
      expectedRetrieveHandles: ['unresolved', 'replacement', 'aggregate'],
      expectedListAllHandles: ['aggregate', 'original', 'replacement', 'unresolved'],
      expectedPrunedCount: 0,
      expectedAssertNoPersonalMemoryThrows: true,
      expectedShareableAggregateHandles: ['aggregate'],
    },
    expectedAbsentFromProjection: contentStringsOf(state),
  };
}

function sensitiveFixture(language: MemoryLanguage): LifeStateMemoryFixture {
  const scopeId = scopeOf(language);
  const content = CONTENT[language];
  const id = `cmt-sensitive-${language}-a`;

  const state = stateOf([
    commitment({
      id,
      title: content.sensitiveTitle,
      person: content.sensitivePerson,
      status: 'active',
      timeSpec: timeSpec({ kind: 'scheduled_event', dueAt: T_PLUS_6_0815, remindAt: T_PLUS_6_0815 }),
    }),
  ]);

  return {
    id: `${language}-sensitive`,
    language,
    condition: 'sensitive',
    scopeId,
    now: FIXTURE_CLOCK_ISO,
    description: 'Clinical commitment and clinical memory records under one scope.',
    notes:
      'Two separate guarantees. First, export policy: the clinical record omits exportPolicy and must ' +
      'still resolve to personal_never_export, so the protection cannot be lost by a caller forgetting ' +
      'the field, and assertNoPersonalMemory must throw over this scope. Second, projection minimisation: ' +
      'CommitmentsView carries ids and counts but no titles, so the clinical title and the clinician name ' +
      'must be absent from the serialised LifeState entirely. Both strings are present in the input ' +
      'DomainState, so the absence assertion is not vacuous. The clinical record also observes three days ' +
      'before it is written, pinning that staleAfter runs from write time: an old observation recorded ' +
      'today is not born stale.',
    lifeState: {
      input: { state, now: FIXTURE_CLOCK_ISO, scopeId },
      expected: {
        commitments: {
          known: true,
          value: {
            countsByStatus: { active: 1 },
            openCount: 1,
            overdueCount: 0,
            openCommitmentIds: [id],
            overdueCommitmentIds: [],
          },
          provenance: domainProvenance(T_MINUS_10),
        },
        availability: {
          known: true,
          value: {
            busyWindows: [
              {
                commitmentId: id,
                startsAt: T_PLUS_6_0815,
                endsAt: null,
                timezone: FIXTURE_TIMEZONE,
                kind: 'scheduled_event',
              },
            ],
            unscheduledCommitmentCount: 0,
          },
          provenance: domainProvenance(T_MINUS_10),
        },
        load: {
          known: true,
          value: { openCount: 1, overdueCount: 0, band: 'light' },
          provenance: domainProvenance(T_MINUS_10),
          unpinned: LOAD_UNPINNED,
        },
        recentOutcomes: emptyOutcomes(null),
      },
    },
    memory: {
      records: [
        memoryRecord({
          handle: 'clinical',
          scopeId,
          putAt: T_MINUS_10,
          observedAt: T_MINUS_13,
          content: content.sensitiveClinical,
          language,
          kind: 'fact',
          source: 'user_stated',
          confidence: 0.95,
          evidenceIds: [`obs-${language}-sensitive-1`],
          sensitive: true,
          // exportPolicy deliberately omitted: the contract default must apply.
          expected: {
            statusBeforePrune: 'active',
            statusAfterPrune: 'active',
            retrievableAtNow: true,
            listedInScope: true,
          },
        }),
        memoryRecord({
          handle: 'medication',
          scopeId,
          putAt: T_MINUS_10,
          content: content.sensitiveMedication,
          language,
          kind: 'fact',
          source: 'user_stated',
          confidence: 0.9,
          evidenceIds: [`obs-${language}-sensitive-2`],
          exportPolicy: 'personal_never_export',
          sensitive: true,
          expected: {
            statusBeforePrune: 'active',
            statusAfterPrune: 'active',
            retrievableAtNow: true,
            listedInScope: true,
          },
        }),
      ],
      // medication observedAt T-10, clinical observedAt T-13: newest first.
      expectedRetrieveHandles: ['medication', 'clinical'],
      expectedListAllHandles: ['clinical', 'medication'],
      expectedPrunedCount: 0,
      expectedAssertNoPersonalMemoryThrows: true,
      expectedShareableAggregateHandles: [],
    },
    expectedAbsentFromProjection: contentStringsOf(state),
  };
}

const CONDITION_BUILDERS: Record<ContextCondition, (language: MemoryLanguage) => LifeStateMemoryFixture> = {
  missing: missingFixture,
  stale: staleFixture,
  conflicting: conflictingFixture,
  sensitive: sensitiveFixture,
};

/** The positive corpus: every language × every condition, built in a fixed order. */
export const LIFE_STATE_MEMORY_FIXTURES: readonly LifeStateMemoryFixture[] = Object.freeze(
  FIXTURE_LANGUAGES.flatMap((language) =>
    CONTEXT_CONDITIONS.map((condition) => CONDITION_BUILDERS[condition](language)),
  ),
);

export function fixtureFor(
  language: MemoryLanguage,
  condition: ContextCondition,
): LifeStateMemoryFixture | undefined {
  return LIFE_STATE_MEMORY_FIXTURES.find((f) => f.language === language && f.condition === condition);
}

/** Every user-visible string in the corpus, for bidi and round-trip assertions. */
export function corpusStrings(): readonly string[] {
  const out: string[] = [];
  for (const fixture of LIFE_STATE_MEMORY_FIXTURES) {
    for (const c of Object.values(fixture.lifeState.input.state.commitments)) {
      out.push(c.title);
      if (c.person) out.push(c.person);
      if (c.description) out.push(c.description);
    }
    for (const record of fixture.memory.records) out.push(record.input.content);
  }
  return Object.freeze(out);
}

/* ── Negative corpus ─────────────────────────────────────────────── */

/**
 * Deliberately malformed fixtures. Each one carries exactly one defect and the
 * issue code the validator must raise for it. Their only purpose is to prove
 * the validator can fail — a checker that never rejects anything is not a
 * checker. They are `unknown`-typed on purpose: several defects are not
 * expressible in the fixture type.
 */
export interface MalformedFixtureCase {
  readonly id: string;
  readonly defect: string;
  readonly expectedIssueCode: string;
  readonly fixture: unknown;
}

const AR_SENSITIVE = sensitiveFixture('ar');
const HE_STALE = staleFixture('he');
const EN_CONFLICTING = conflictingFixture('en');
const MIXED_MISSING = missingFixture('mixed');

function withMemory(
  base: LifeStateMemoryFixture,
  memory: Partial<MemoryFixtureSection>,
): Record<string, unknown> {
  return { ...base, memory: { ...base.memory, ...memory } };
}

function replaceRecord(
  base: LifeStateMemoryFixture,
  handle: string,
  patch: (record: MemoryFixtureRecord) => Record<string, unknown>,
): readonly unknown[] {
  return base.memory.records.map((record) => (record.handle === handle ? patch(record) : record));
}

export const MALFORMED_FIXTURES: readonly MalformedFixtureCase[] = Object.freeze([
  {
    id: 'malformed-not-an-object',
    defect: 'The fixture is a string rather than an object.',
    expectedIssueCode: 'FIXTURE_NOT_OBJECT',
    fixture: 'ar-sensitive',
  },
  {
    id: 'malformed-invalid-language',
    defect: 'language is "fr", which the memory contract does not declare.',
    expectedIssueCode: 'INVALID_LANGUAGE',
    fixture: { ...AR_SENSITIVE, id: 'malformed-invalid-language', language: 'fr' },
  },
  {
    id: 'malformed-invalid-condition',
    defect: 'condition is "unclear", which is outside the four context conditions.',
    expectedIssueCode: 'INVALID_CONDITION',
    fixture: { ...AR_SENSITIVE, id: 'malformed-invalid-condition', condition: 'unclear' },
  },
  {
    id: 'malformed-non-iso-now',
    defect: 'now is "18 August 2026", which is not an ISO timestamp.',
    expectedIssueCode: 'INVALID_TIMESTAMP',
    fixture: { ...AR_SENSITIVE, id: 'malformed-non-iso-now', now: '18 August 2026' },
  },
  {
    id: 'malformed-computed-at-drift',
    defect: 'A provenance.computedAt is a different instant from the fixture clock.',
    expectedIssueCode: 'PROVENANCE_COMPUTED_AT_MISMATCH',
    fixture: {
      ...AR_SENSITIVE,
      id: 'malformed-computed-at-drift',
      lifeState: {
        ...AR_SENSITIVE.lifeState,
        expected: {
          ...AR_SENSITIVE.lifeState.expected,
          commitments: {
            ...AR_SENSITIVE.lifeState.expected.commitments,
            provenance: { source: 'domain_state', derivedFrom: T_MINUS_10, computedAt: T_MINUS_3 },
          },
        },
      },
    },
  },
  {
    id: 'malformed-empty-state-expects-known',
    defect:
      'A missing-condition fixture expects a known availability field over an empty DomainState. ' +
      'Unlike commitments, an empty record says nothing about whether the user is free, so ' +
      'claiming knowledge here asserts something no data supports.',
    expectedIssueCode: 'EMPTY_STATE_EXPECTS_UNKNOWN',
    fixture: {
      ...MIXED_MISSING,
      id: 'malformed-empty-state-expects-known',
      lifeState: {
        ...MIXED_MISSING.lifeState,
        expected: {
          ...MIXED_MISSING.lifeState.expected,
          availability: {
            known: true,
            value: { busyWindows: [], unscheduledCommitmentCount: 0 },
            provenance: { source: 'absent', derivedFrom: null, computedAt: FIXTURE_CLOCK_ISO },
          },
        },
      },
    },
  },
  {
    id: 'malformed-no-data-over-populated-state',
    defect: 'A populated fixture claims NO_DATA for recentOutcomes instead of a known-zero window.',
    expectedIssueCode: 'NO_DATA_OVER_POPULATED_STATE',
    fixture: {
      ...HE_STALE,
      id: 'malformed-no-data-over-populated-state',
      lifeState: {
        ...HE_STALE.lifeState,
        expected: {
          ...HE_STALE.lifeState.expected,
          recentOutcomes: {
            known: false,
            reason: 'NO_DATA',
            provenance: { source: 'absent', derivedFrom: null, computedAt: FIXTURE_CLOCK_ISO },
          },
        },
      },
    },
  },
  {
    id: 'malformed-unknown-reason-outside-vocabulary',
    defect: 'An unknown field uses reason "MAYBE", which the contract does not declare.',
    expectedIssueCode: 'INVALID_UNKNOWN_REASON',
    fixture: {
      ...MIXED_MISSING,
      id: 'malformed-unknown-reason-outside-vocabulary',
      lifeState: {
        ...MIXED_MISSING.lifeState,
        expected: {
          ...MIXED_MISSING.lifeState.expected,
          load: { known: false, reason: 'MAYBE', provenance: { source: 'absent', derivedFrom: null, computedAt: FIXTURE_CLOCK_ISO } },
        },
      },
    },
  },
  {
    id: 'malformed-sensitive-shareable',
    defect: 'A record marked sensitive expects exportPolicy shareable_aggregate.',
    expectedIssueCode: 'SENSITIVE_EXPORT_POLICY',
    fixture: withMemory(AR_SENSITIVE, {
      records: replaceRecord(AR_SENSITIVE, 'medication', (record) => ({
        ...record,
        input: { ...record.input, exportPolicy: 'shareable_aggregate' },
        expected: { ...record.expected, exportPolicy: 'shareable_aggregate' },
      })) as never,
      expectedShareableAggregateHandles: ['medication'],
    }),
  },
  {
    id: 'malformed-confidence-out-of-range',
    defect: 'A record declares confidence 1.4, outside the contract range 0..1.',
    expectedIssueCode: 'CONFIDENCE_OUT_OF_RANGE',
    fixture: withMemory(AR_SENSITIVE, {
      records: replaceRecord(AR_SENSITIVE, 'clinical', (record) => ({
        ...record,
        input: { ...record.input, confidence: 1.4 },
      })) as never,
    }),
  },
  {
    id: 'malformed-empty-content',
    defect: 'A record declares whitespace-only content.',
    expectedIssueCode: 'EMPTY_CONTENT',
    fixture: withMemory(AR_SENSITIVE, {
      records: replaceRecord(AR_SENSITIVE, 'clinical', (record) => ({
        ...record,
        input: { ...record.input, content: '   ' },
      })) as never,
    }),
  },
  {
    id: 'malformed-bidi-control-character',
    defect: 'Content carries a U+202E right-to-left override, which mangles logical order.',
    expectedIssueCode: 'BIDI_CONTROL_CHARACTER',
    fixture: withMemory(AR_SENSITIVE, {
      records: replaceRecord(AR_SENSITIVE, 'clinical', (record) => ({
        ...record,
        input: { ...record.input, content: `‮عيادة Clalit‬` },
      })) as never,
    }),
  },
  {
    id: 'malformed-language-script-mismatch',
    defect: 'An Arabic-tagged record carries Latin-only content.',
    expectedIssueCode: 'LANGUAGE_SCRIPT_MISMATCH',
    fixture: withMemory(AR_SENSITIVE, {
      records: replaceRecord(AR_SENSITIVE, 'clinical', (record) => ({
        ...record,
        input: { ...record.input, content: 'Diabetes follow-up at the clinic' },
      })) as never,
    }),
  },
  {
    id: 'malformed-stale-after-from-observed-at',
    defect: 'staleAfter is measured from observedAt rather than from write time, so an old observation is born nearly stale.',
    expectedIssueCode: 'STALE_AFTER_MISMATCH',
    fixture: withMemory(AR_SENSITIVE, {
      records: replaceRecord(AR_SENSITIVE, 'clinical', (record) => ({
        ...record,
        expected: { ...record.expected, staleAfter: staleAfterFrom(T_MINUS_13) },
      })) as never,
    }),
  },
  {
    id: 'malformed-stale-expectation-mismatch',
    defect: 'A record whose staleAfter is in the past claims it is not stale at the clock.',
    expectedIssueCode: 'STALE_EXPECTATION_MISMATCH',
    fixture: withMemory(HE_STALE, {
      records: replaceRecord(HE_STALE, 'stale-fact', (record) => ({
        ...record,
        expected: { ...record.expected, staleAtNow: false },
      })) as never,
    }),
  },
  {
    id: 'malformed-retrievable-stale-record',
    defect: 'A stale record claims it is still retrievable, which retrieve() forbids.',
    expectedIssueCode: 'RETRIEVE_EXPECTATION_INCONSISTENT',
    fixture: withMemory(HE_STALE, {
      records: replaceRecord(HE_STALE, 'stale-fact', (record) => ({
        ...record,
        expected: { ...record.expected, retrievableAtNow: true },
      })) as never,
      expectedRetrieveHandles: ['stale-fact'],
    }),
  },
  {
    id: 'malformed-unknown-supersedes-handle',
    defect: 'A record supersedes a handle that does not exist in the fixture.',
    expectedIssueCode: 'UNKNOWN_SUPERSEDES_HANDLE',
    fixture: withMemory(EN_CONFLICTING, {
      records: replaceRecord(EN_CONFLICTING, 'replacement', (record) => ({
        ...record,
        supersedesHandle: 'ghost',
        expected: { ...record.expected, supersedesHandle: 'ghost' },
      })) as never,
    }),
  },
  {
    id: 'malformed-retrieve-order',
    defect: 'expectedRetrieveHandles is ordered oldest-observedAt first.',
    expectedIssueCode: 'RETRIEVE_ORDER_INVALID',
    fixture: withMemory(EN_CONFLICTING, {
      expectedRetrieveHandles: ['aggregate', 'replacement', 'unresolved'],
    }),
  },
  {
    id: 'malformed-prune-count',
    defect: 'A fixture with one stale record expects prune() to return 0.',
    expectedIssueCode: 'PRUNE_COUNT_MISMATCH',
    fixture: withMemory(HE_STALE, { expectedPrunedCount: 0 }),
  },
  {
    id: 'malformed-vacuous-absence-assertion',
    defect: 'expectedAbsentFromProjection names a string that is nowhere in the DomainState.',
    expectedIssueCode: 'VACUOUS_ABSENCE_ASSERTION',
    fixture: {
      ...AR_SENSITIVE,
      id: 'malformed-vacuous-absence-assertion',
      expectedAbsentFromProjection: [...AR_SENSITIVE.expectedAbsentFromProjection, 'never-in-the-state'],
    },
  },
]);
