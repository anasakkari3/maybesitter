import { z } from 'zod';
import { weeklyBlockOfferSchema, weeklyBlockSchema } from './weeklyBlocks';
import { isoDateTime } from './common';
import { claimsSaved, hasLink } from './understoodText';

/** A full ISO instant: date, time and an offset or Z — never a bare date. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * An item's `endTime` survives only as a real end of a timed item: a full
 * instant, later than `resolvedTime`, not on an all-day item. Anything else is
 * removed — only the end, never the item (M2a).
 */
function withUsableEnd(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || !('endTime' in raw)) return raw;
  const item = raw as Record<string, unknown>;
  const end = item.endTime;
  const start = item.resolvedTime;
  const usable = typeof end === 'string' && ISO_INSTANT.test(end)
    && typeof start === 'string' && item.allDayEvent !== true
    && Date.parse(end) > Date.parse(start);
  if (usable) return raw;
  const { endTime: _dropped, ...rest } = item;
  return rest;
}

const SEED_KINDS = ['consideration', 'waiting_for', 'idea', 'possible_goal'] as const;
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F]/;
/** A summary line is plain words: not blank, no control characters, no link, no "saved". */
const understoodText = z.string().min(1).max(160).refine((text) => text.trim().length > 0
  && !CONTROL_CHARACTER.test(text) && !hasLink(text) && !claimsSaved(text));
// `pointId` (M3b, contract v8) is the point's stable identity across a change
// of family; an older server sends none, and the family id stands in for it.
const pointIdField = z.string().min(1).optional();
const understoodPointSchema = z.union([
  z.object({ kind: z.literal('commitment'), itemId: z.string().min(1), pointId: pointIdField, text: understoodText }).strict(),
  z.object({ kind: z.enum(SEED_KINDS), seedItemId: z.string().min(1), pointId: pointIdField, text: understoodText }).strict(),
  z.object({ kind: z.literal('habit'), habitItemId: z.string().min(1), pointId: pointIdField, text: understoodText }).strict(),
  z.object({ kind: z.literal('goal'), goalItemId: z.string().min(1), pointId: pointIdField, text: understoodText }).strict(),
]);
export type UnderstoodPoint = z.infer<typeof understoodPointSchema>;

const correctionSchema = z.object({
  id: z.string().min(1).max(80),
  from: z.string().min(1).max(60).regex(/^\S+$/),
  to: z.string().min(1).max(60).regex(/^\S+$/),
}).strict();
export type CaptureCorrection = z.infer<typeof correctionSchema>;

function parseCorrections(value: unknown): CaptureCorrection[] | undefined {
  if (value === undefined) return undefined;
  const parsed = z.array(correctionSchema).min(1).max(3).safeParse(value);
  if (!parsed.success) return undefined;
  return new Set(parsed.data.map((correction) => correction.id)).size === parsed.data.length ? parsed.data : undefined;
}

/**
 * A protected point a later chat message took off the list (M2b, contract v5):
 * shown, muted, with «رجّعها». Exactly one of `itemId` / `seedItemId`.
 */
const removedItemSchema = z.object({
  itemId: z.string().min(1).optional(),
  seedItemId: z.string().min(1).optional(),
  kind: z.enum(['commitment', 'possible_goal', 'consideration', 'idea', 'waiting_for']),
  text: z.string().min(1),
}).refine((entry) => (entry.itemId !== undefined && entry.seedItemId === undefined && entry.kind === 'commitment')
  || (entry.seedItemId !== undefined && entry.itemId === undefined && entry.kind !== 'commitment'));
export type CaptureRemovedItem = z.infer<typeof removedItemSchema>;

/** Tolerant: an entry of the wrong shape is dropped, a wrong value reads as none. */
function parseRemovedItems(value: unknown): CaptureRemovedItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const kept = value.flatMap((entry) => {
    const parsed = removedItemSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
  return kept.length > 0 ? kept : undefined;
}

/** A proposal revision (M2b): a non-negative integer, or absent. */
function parseRevision(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function parseUnderstoodShape(value: unknown): UnderstoodPoint[] | undefined {
  if (value === undefined) return undefined;
  const parsed = z.array(understoodPointSchema).min(1).safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** A habit's rhythm, in the habit store's own shapes (M3b). */
export const habitCadenceSchema = z.union([
  z.object({ kind: z.literal('weekly_count'), count: z.number().int().min(1).max(7) }).strict(),
  z.object({ kind: z.literal('weekdays'), weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7) }).strict(),
]);
export type HabitCadence = z.infer<typeof habitCadenceSchema>;
const clockHHMM = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const preferredWindowSchema = z.union([
  z.enum(['morning', 'afternoon', 'evening']),
  z.object({ start: clockHHMM, end: clockHHMM }).strict(),
]);
export type HabitPreferredWindow = z.infer<typeof preferredWindowSchema>;

/**
 * A habit or goal title: at most 120 code points, the way the server counts it
 * (`Array.from`), not 120 UTF-16 units — an emoji is one (M3B-A-R2-004).
 */
const kindTitleSchema = z.string().min(1).refine((value) => Array.from(value).length <= 120, { message: 'at most 120 characters' });

/**
 * A habit the chat understood (M3b, contract v8). Nothing about it is saved
 * until the review's «احفظ»; it can be selected only when `confirmable`, which
 * the server sets once the rhythm and the length are known and no question is
 * open. `explanation` is the server's own sentence built from those fields.
 */
export const captureHabitProposalSchema = z.object({
  habitItemId: z.string().min(1),
  pointId: z.string().min(1),
  title: kindTitleSchema,
  cadence: habitCadenceSchema.nullable(),
  durationMinutes: z.number().int().min(5).max(240).nullable(),
  preferredWindow: preferredWindowSchema.nullable(),
  explanation: z.string().min(1).nullable(),
  question: z.union([
    z.object({ field: z.literal('frequency'), options: z.array(z.number().int().min(1).max(7)).min(1) }),
    z.object({ field: z.literal('duration'), options: z.array(z.number().int().min(5).max(240)).min(1) }),
    z.object({ field: z.literal('kind'), options: z.array(z.enum(['habit', 'commitment'])).min(1) }),
  ]).nullable(),
  confirmable: z.boolean(),
});
export type CaptureHabitProposal = z.infer<typeof captureHabitProposalSchema>;

/** A goal the chat understood (M3b). Saved by the confirm, never before. */
export const captureGoalProposalSchema = z.object({
  goalItemId: z.string().min(1),
  pointId: z.string().min(1),
  title: kindTitleSchema,
});
export type CaptureGoalProposal = z.infer<typeof captureGoalProposalSchema>;

/** Where the chat was opened from (M3b). A hint the server keeps for the conversation. */
export const CAPTURE_ENTRIES = ['goal', 'habit', 'thought'] as const;
export type CaptureEntry = typeof CAPTURE_ENTRIES[number];

/** `GET /api/mobile/capture/kinds` (M3b, R004). Unknown entries are dropped, never trusted. */
export const captureKindsSchema = z.object({
  success: z.literal(true),
  entries: z.array(z.string()).transform((entries) => entries.filter((entry): entry is CaptureEntry =>
    (CAPTURE_ENTRIES as readonly string[]).includes(entry))),
});

/** Mirrors `capture.proposal.json`. A proposal never implies persistence. */
export const captureProposalSchema = z.object({
  version: z.string(),
  proposalId: z.string(),
  status: z.enum([
    'proposed',
    'needs_clarification',
    'no_commitment',
    'rejected',
    /**
     * The capture named something the person is considering or waiting on, and
     * no commitment at all (#519). Not `no_commitment`: there *is* something
     * to offer, and only they can say whether it is worth keeping.
     */
    'unresolved_intent',
  ]),
  /**
   * Why nothing was created, on a `no_commitment` proposal (UC-2.6, #166).
   *
   * A reason code, never a reading of what the person wrote. The client maps it
   * to one fixed neutral line; it does not compose a sentence about it, and
   * there is deliberately no therapeutic or emotional interpretation anywhere in
   * that mapping — «حسّيت بضغط» is `informational` because nothing was asked
   * for, not because the product has an opinion about how somebody feels.
   */
  noCommitmentReason: z
    .enum(['informational', 'greeting_or_chat', 'question', 'past_event', 'negated_request', 'low_confidence'])
    .optional(),
  /**
   * On a clarify answer (M4a, WIRE-M4a): the chosen free time had stopped
   * being free, nothing was saved, and the item asks again with fresh times.
   */
  reason: z.literal('not_free').optional(),
  items: z.array(
    z.preprocess(withUsableEnd, z.object({
      itemId: z.string(),
      pointId: pointIdField,
      title: z.string(),
      resolvedTime: isoDateTime.nullable(),
      needsClarification: z.boolean(),
      /**
       * When the item ends (M2a). Tolerant: anything that is not an ISO
       * instant reads as absent, so a bad end never costs the whole answer —
       * the card just shows the start.
       */
      endTime: z.string().optional(),
      /** What the extractor read the importance as: Must / Should / Nice (#164). */
      priority: z.enum(['low', 'normal', 'high']).optional(),
      /**
       * True when that level is the extractor's guess rather than something the
       * person said. The review screen marks it, because a guess presented as a
       * fact is how a product loses the right to make guesses.
       */
      priorityEstimated: z.boolean().optional(),
      /**
       * The day the item lands on, `YYYY-MM-DD` on the user's clock (L4) —
       * present even while `resolvedTime` is null because the hour is still
       * being asked for, so the card can show *which* Sunday.
       */
      resolvedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      /** True when that day is our guess from a weekday name, not their words. */
      dateEstimated: z.boolean().optional(),
      /**
       * True when the hour of `resolvedTime` is our guess: the person named
       * only a part of the day — «المسا», "tonight" — and no number (UAT round
       * 6, D2). Optional: an older server sends nothing, read as false.
       */
      timeEstimated: z.boolean().optional(),
      /**
       * True when the item happens *on* `resolvedDate` with no hour (an
       * appointment answered "no specific time", FY1 N4), not by it.
       */
      allDayEvent: z.boolean().optional(),
      /**
       * True when the item happens *on* `resolvedDate`, so clearing its hour
       * in the edit sheet keeps it there (the server's confirm rule, FY1 M1).
       * The card then reads «<day> · بدون وقت» rather than a bare «بدون وقت»
       * (UAT round 3, N11). Absent for a task, which loses the day.
       */
      eventOnDay: z.boolean().optional(),
      /**
       * The words said this repeats weekly — «كل سبت», "every Saturday"
       * (FIX-R8-CAPTURE). Content-free: weekdays 0 = Sunday … 6 = Saturday,
       * `start`/`end` as `HH:MM` once the hour is settled. Optional and not
       * yet rendered: the item itself is a one-off on the next occurrence,
       * and an older server sends nothing.
       */
      recurrenceHint: z
        .object({
          weekdays: z.array(z.number().int().min(0).max(6)),
          start: z.string().regex(/^\d{2}:\d{2}$/).optional(),
          end: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        })
        .nullable()
        .optional(),
      /**
       * The offer to keep this item as a weekly fixed block («ثابت أسبوعي»),
       * rendered «كل سبت · 10:00–16:00». Present only for a complete weekly
       * range. Confirming it means naming the item in `weeklyBlockItemIds`;
       * without that the confirm keeps the one-off.
       */
      weeklyBlock: weeklyBlockOfferSchema.optional(),
      /**
       * What this item's time lands on among the person's own things — the
       * capture chat's answer only (owner request 2026-09-30): a saved
       * commitment, a weekly block, a followed match, or the synced calendar's
       * busy time, whose `title` is null (it has none, and none is made up).
       * The chat card names each; the confirm still returns its own
       * `collisions`. Optional: absent when nothing clashes, and from an
       * older server.
       */
      conflicts: z.array(z.object({
        title: z.string().nullable(),
        startsAt: isoDateTime,
        endsAt: isoDateTime,
        kind: z.enum(['commitment', 'weekly', 'fixture', 'calendar_busy']),
        /**
         * The clash is with another card of this same list, not something
         * already saved (audit 2026-10-03 #1). Optional: an older server
         * never sends it.
         */
        inProposal: z.boolean().optional(),
      })).optional(),
      /**
       * One of the person's active goals this item looks like a step of
       * (audit 2026-10-03 #6). The card shows it as «مرتبط بهدف …», kept by
       * default and removable; the confirm names the items it is kept on in
       * `goalLinkItemIds`. Optional: an older server sends nothing.
       */
      goalLink: z.object({ goalId: z.string(), title: z.string() }).optional(),
      /**
       * Words the server corrected in a dictated message (M2b): «فهمت "الطلع"
       * إنها "اطلع"». Tolerant: anything malformed — not a list, a blank or
       * multi-word part, a repeated id, more than three — reads as absent.
       */
      corrections: z.preprocess(parseCorrections, z.array(correctionSchema).optional()),
      /**
       * The one question to ask about this item (UC-2.5, #165).
       *
       * Keys and parameters, never a sentence: the phone renders the question
       * from its own locale files, so the text is never model-generated. An
       * unrecognised `questionKey` means a newer server — the app opens #164's
       * edit sheet rather than rendering something it cannot read.
       *
       * Null with `needsClarification` still true means the one round is spent,
       * and the fallback is the same edit sheet.
       */
      clarification: z
        .object({
          questionId: z.string(),
          field: z.enum(['time', 'action', 'time_period', 'which_day']),
          questionKey: z.string(),
          params: z.record(z.string(), z.string()),
          options: z.array(
            z.object({
              optionId: z.string(),
              labelKey: z.string(),
              labelParams: z.record(z.string(), z.string()),
              value: z.object({ localTime: z.string().optional(), localDate: z.string().optional() }),
            }),
          ),
          allowFreeText: z.boolean(),
        })
        .nullable()
        .optional(),
    })),
  ),
  /**
   * What the capture may have named as unresolved intent (#519).
   *
   * `.default([])` rather than required: a backend that predates this field
   * must still parse here, and an app that reads the absence as an empty list
   * behaves exactly as it did before — it offers nothing. Nothing in here is
   * saved until the person taps Keep, which posts to `/api/mobile/seeds`; the
   * summary the server stores is read back out of its own proposal, so what is
   * kept is the sentence they typed and not one this client sent.
   */
  seeds: z
    .array(z.object({
      seedItemId: z.string(),
      pointId: pointIdField,
      kind: z.enum(['consideration', 'waiting_for', 'idea', 'possible_goal']),
      summary: z.string(),
      /** A time the thought carried (M3b, D3): offered as «حطّها التزام», never applied on its own. */
      suggestedTime: z.object({ at: isoDateTime, timeZone: z.string().min(1) }).nullable().optional(),
    }))
    .default([]),
  /**
   * Habits understood (M3b). Absent from an older server, or when the feature
   * is off; read it through `habitsOf()`, which treats absence as none.
   */
  habits: z.array(captureHabitProposalSchema).optional(),
  /** Goals understood (M3b); read through `goalsOf()`. */
  goals: z.array(captureGoalProposalSchema).optional(),
  /** The entry the conversation was opened from (M3b); null for the plain chat. */
  entry: z.enum(CAPTURE_ENTRIES).nullable().optional(),
  /**
   * What the assistant understood, line by line (M2a). Tolerant: a value of
   * the wrong shape reads as absent instead of failing the answer. Whether the
   * lines match this proposal's items and seeds is checked by
   * `usableUnderstood()` before anything is shown.
   */
  understood: z.preprocess(parseUnderstoodShape, z.array(understoodPointSchema).optional()),
  /**
   * Which version of the proposal this is (M2b). Every write the person makes
   * sends it back; absent from older servers, and then no structured edits
   * are offered.
   */
  revision: z.preprocess(parseRevision, z.number().int().nonnegative().optional()),
  /** Protected points a later message took off the list, to bring back (M2b, contract v5). */
  removedItems: z.preprocess(parseRemovedItems, z.array(removedItemSchema).optional()),
  provenance: z
    .object({
      requestedEngine: z.enum(['model', 'rules']),
      // The three the contract declares (src/contracts/v1/captureContracts.ts:167),
      // not `z.string()`. UC-2.0 (#160) asks the app to fail on an engine it does
      // not know about; a bare string accepts one silently, which is the same
      // shape of defect as a test that cannot go red.
      executedEngine: z.enum(['gemini', 'ollama', 'rule-based']),
      fallbackUsed: z.boolean(),
    })
    .optional(),
});

export type CaptureProposal = z.infer<typeof captureProposalSchema>;

/** A proposal's habits; none when the server sent none (M3b, R3-003). */
export function habitsOf(proposal: Pick<CaptureProposal, 'habits'>): CaptureHabitProposal[] {
  return proposal.habits ?? [];
}

/** A proposal's goals; none when the server sent none. */
export function goalsOf(proposal: Pick<CaptureProposal, 'goals'>): CaptureGoalProposal[] {
  return proposal.goals ?? [];
}
export type CaptureProposalItem = CaptureProposal['items'][number];
export type CaptureSeedProposal = CaptureProposal['seeds'][number];

/**
 * The understood lines, only when they describe exactly this proposal: every
 * item and every seed once, no unknown reference, and each seed line carrying
 * its seed's kind. Anything else — an older or inconsistent server — reads as
 * no list, and the review shows the cards as before (M2a).
 */
export function usableUnderstood(proposal: Pick<CaptureProposal, 'items' | 'seeds' | 'understood'> & Partial<Pick<CaptureProposal, 'habits' | 'goals'>>): UnderstoodPoint[] | undefined {
  const points = proposal.understood;
  if (!points) return undefined;
  const items = new Set(proposal.items.map((item) => item.itemId));
  const seeds = new Map(proposal.seeds.map((seed) => [seed.seedItemId, seed.kind] as const));
  const habits = new Set((proposal.habits ?? []).map((habit) => habit.habitItemId));
  const goals = new Set((proposal.goals ?? []).map((goal) => goal.goalItemId));
  const seen = new Set<string>();
  for (const point of points) {
    const key = 'itemId' in point ? `i:${point.itemId}`
      : 'seedItemId' in point ? `s:${point.seedItemId}`
        : 'habitItemId' in point ? `h:${point.habitItemId}` : `g:${point.goalItemId}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    if ('itemId' in point) {
      if (!items.has(point.itemId)) return undefined;
    } else if ('seedItemId' in point) {
      if (seeds.get(point.seedItemId) !== point.kind) return undefined;
    } else if ('habitItemId' in point) {
      if (!habits.has(point.habitItemId)) return undefined;
    } else if (!goals.has(point.goalItemId)) {
      return undefined;
    }
  }
  return seen.size === items.size + seeds.size + habits.size + goals.size ? points : undefined;
}

/**
 * A proposal as a response carries it: `understood` survives only when it
 * describes exactly this proposal (`usableUnderstood`). Lines that name an
 * unknown item, skip one, or file a seed under another kind read as absent —
 * the answer itself still parses (M2a, contract v3). The base object stays a
 * plain object so other schemas can `extend` it.
 */
export const captureProposalResponseSchema = captureProposalSchema.transform((proposal): CaptureProposal => {
  if (proposal.understood === undefined || usableUnderstood(proposal)) return proposal;
  const kept = { ...proposal };
  delete kept.understood;
  return kept;
});

/**
 * What a newly-persisted commitment landed on top of (#football-fixtures
 * task 10). No `origin` field: an earlier task carried one and it was
 * withdrawn, because a sealed annotation corpus checksums the whole
 * serialised commitment and the field moved it. A screen that needs to know a
 * colliding commitment came from a synced feed reads that off the commitment
 * itself, not off this warning.
 */
export const collisionWarningSchema = z.object({
  commitmentId: z.string(),
  title: z.string(),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
});

export type CollisionWarning = z.infer<typeof collisionWarningSchema>;

/**
 * Mirrors `capture.confirmation.json` **and** `capture.confirmationFailed.json`.
 *
 * Both shapes are the same object; `success` is what separates them. Since
 * #252 a confirm that persisted nothing also answers 404 or 400 rather than
 * 200, so the client learns of the failure from the status *and* the body —
 * and `failed[]` still names which item was refused and why, which a bare
 * error code would have thrown away.
 */
export const captureConfirmationSchema = z.object({
  success: z.boolean(),
  replayed: z.boolean(),
  persisted: z.array(
    z.object({
      itemId: z.string(),
      commitmentId: z.string(),
      title: z.string(),
      resolvedTime: isoDateTime.nullable(),
    }),
  ),
  failed: z.array(z.object({ itemId: z.string(), reason: z.string() })),
  failureCode: z
    .enum([
      'proposal_not_found',
      'proposal_rejected',
      'invalid_selection',
      'persistence_failed',
      // An edit the server refused. Separate from `invalid_selection` because
      // the selection was fine and a change to it was not (#164).
      'invalid_edit',
      // M3b: what the one confirm refuses before writing anything.
      'too_many_writes',
      'habit_invalid',
      'goal_invalid',
      'seed_invalid',
    ])
    .optional(),
  // Optional, not required: it warns rather than refuses (a candidate that
  // collides with nothing sends the same empty array an older server always
  // did), and an older backend that has not shipped this field at all must
  // still parse under this schema.
  collisions: z.array(collisionWarningSchema).optional(),
  /**
   * The weekly blocks this confirm created (items named in
   * `weeklyBlockItemIds`), each with what the phone needs for its recurring
   * device event. Optional: an older server sends nothing.
   */
  weeklyBlocks: z.array(z.object({ itemId: z.string(), block: weeklyBlockSchema })).optional(),
  /**
   * The confirmed items now counted toward a goal (`goalLinkItemIds`).
   * Optional: an older server sends nothing, and links nothing.
   */
  goalLinks: z.array(z.object({ itemId: z.string(), goalId: z.string(), commitmentId: z.string() })).optional(),
  /** What the same confirm saved of the other families (M3b). Absent from an older server, or when off. */
  habitsPersisted: z.array(z.object({ habitItemId: z.string(), pointId: z.string(), habitId: z.string(), title: z.string() })).optional(),
  goalsPersisted: z.array(z.object({ goalItemId: z.string(), pointId: z.string(), goalId: z.string(), title: z.string() })).optional(),
  seedsPersisted: z.array(z.object({ seedItemId: z.string(), pointId: z.string(), seedId: z.string(), kind: z.string(), title: z.string() })).optional(),
});

export type CaptureConfirmation = z.infer<typeof captureConfirmationSchema>;

/**
 * One line of the capture chat «احكيها» (owner decision 2026-09-30): the
 * person's message or the assistant's reply, as the server kept it.
 */
export const captureChatTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string(),
});

export type CaptureChatTurn = z.infer<typeof captureChatTurnSchema>;

/**
 * Mirrors `capture.chatProposal.json`, `capture.chatUpdated.json`,
 * `capture.chatConflict.json` and `capture.chatRules.json` —
 * `POST /api/mobile/capture/chat`.
 *
 * `proposal` is exactly what `POST /api/mobile/capture` returns, and its
 * `proposalId` is what `/capture/clarify` and `/capture/confirm` take: the chat
 * proposes, it never saves. `null` when the conversation holds nothing to
 * confirm (a greeting, a question, everything removed by talk). `reply` has
 * already passed the server's own check (`chatReply`), and is shown as it is —
 * it is words, never a state: nothing reads "saved" off it. `turns` is the
 * conversation as the server kept it, oldest first, bounded; it is the record
 * the screen draws, not the phone's own memory of what was said.
 */
export const captureChatSchema = z.object({
  conversationId: z.string(),
  reply: z.string(),
  engine: z.enum(['model', 'rules']),
  proposal: captureProposalResponseSchema.nullable(),
  turns: z.array(captureChatTurnSchema),
});

export type CaptureChatAnswer = z.infer<typeof captureChatSchema>;

/**
 * What the chat route refuses with (`capture.chatNotFound.json`,
 * `capture.chatTooLong.json`). The reason is what the client acts on:
 * `conversation_not_found` starts a fresh conversation once, `text_too_long`
 * is the capture's own too-long line.
 */
export const captureChatRefusalSchema = z.object({
  success: z.literal(false),
  error: z.string(),
  reason: z.enum(['message_required', 'invalid_conversation_id', 'conversation_not_found', 'text_too_long', 'payload_too_large']),
  maxCharacters: z.number().int().positive().optional(),
  maxBytes: z.number().int().positive().optional(),
});

/**
 * 409 `proposal_changed` (M2b), as the routes send it: the chat edit carries
 * the current chat answer; confirm, clarify and seed keep carry the current
 * proposal and whether it is still open or already confirmed.
 */
export const proposalChangedChatSchema = z.object({
  reason: z.literal('proposal_changed'),
  answer: captureChatSchema,
  // Whether the current proposal is still open or already confirmed (M2b,
  // F7c); an older server says nothing, read as open.
  state: z.enum(['open', 'confirmed']).optional(),
});
export const proposalChangedProposalSchema = z.object({
  reason: z.literal('proposal_changed'),
  proposal: captureProposalResponseSchema,
  state: z.enum(['open', 'confirmed']),
  confirmation: z.unknown().optional(),
});
