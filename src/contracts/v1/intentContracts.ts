/**
 * Intent Seeds — unresolved intent between no-op input and a commitment (#519).
 *
 * A Seed is something the user is *considering*, *waiting on*, or *may want to
 * do later*: «Maybe I'll apply to NVIDIA this semester», «I'm waiting for the
 * doctor to reply», «I want to think about travelling in December». It is
 * deliberately none of the existing kinds:
 *
 *  - not a **Commitment** — nothing was decided, so nothing is scheduled,
 *    ranked, planned, or reminded;
 *  - not a **Memory** fact — it is not a claim about the person;
 *  - not a **Goal** — a goal is a confirmed target; a Seed becomes one only by
 *    an explicit promotion the user performs.
 *
 * ── The state path is one direction, by hand ─────────────────────
 *
 *     no-op ← Seed proposal → confirmed Seed → explicit promotion → Goal/Commitment
 *
 * Every arrow to the right is a user action. Nothing in this contract can move
 * on its own: there is no confidence field, no maturity score, and no status
 * transition a background job can perform. `promoted` is written only by the
 * promote endpoint, in the same transaction that creates the Goal or
 * Commitment through the *existing* confirmation boundary — never by a patch.
 *
 * ── What a Seed may never do ──────────────────────────────────────
 *
 * Per the issue's rules, enforced where they can be and asserted by tests
 * where they cannot:
 *
 *  - does not enter Priority (no rank input reads the store);
 *  - does not enter the Daily Plan (`isPlannable` sees commitments only);
 *  - creates no standard reminders (a seed has no timeSpec and no command);
 *  - never becomes actionable because confidence increased (there is no
 *    confidence);
 *  - `revisitAt` is the user's own "reconsider this" marker, never a deadline
 *    — promotion does not copy it onto a commitment's timeSpec.
 *
 * ── Content-free observability ────────────────────────────────────
 *
 * `SEED_EVENT_NAMES` is the closed set of lifecycle events. They are audit
 * lines (`PilotAuditEvent`): a type, an outcome, a reason code. The `summary`
 * — the user's own sentence — is never logged, which is why this file declares
 * the names and no event carries a payload field.
 */

export const INTENT_SEED_SCHEMA_VERSION = 'intent-seed-v1' as const;

/**
 * What kind of unresolved intent this is.
 *
 * `consideration` — "maybe I'll …", "thinking about …".
 * `waiting_for`   — the user is waiting on somebody or something else.
 * `idea`          — a possibility noted down, not yet even considered.
 * `possible_goal` — "someday / one day / I dream of …".
 */
export type SeedKind = 'consideration' | 'waiting_for' | 'idea' | 'possible_goal';

export const SEED_KINDS: readonly SeedKind[] = ['consideration', 'waiting_for', 'idea', 'possible_goal'];

/**
 * Where a Seed is in its life.
 *
 * `open`      — kept, nothing scheduled.
 * `snoozed`   — the user said "Later"; `revisitAt` is theirs, set by them.
 * `waiting`   — a `waiting_for` seed whose answer has not arrived.
 * `promoted`  — terminal: it became a Goal or a Commitment, and `promotedTo`
 *               names it. Written only by the promote path.
 * `dismissed` — terminal: the user dropped it on purpose. The row is kept so
 *               the action is inspectable; DELETE removes it outright.
 * `expired`   — reserved. Nothing sets it yet: there is no sweeper, because
 *               expiring somebody's intent without asking is the silent
 *               promotion's mirror image. Declared so the day a sweep is
 *               *designed*, the status already exists.
 */
export type SeedStatus = 'open' | 'snoozed' | 'waiting' | 'promoted' | 'dismissed' | 'expired';

export const SEED_STATUSES: readonly SeedStatus[] = [
  'open',
  'snoozed',
  'waiting',
  'promoted',
  'dismissed',
  'expired',
];

/** The statuses a patch may move a seed between. Everything else is a boundary crossing. */
export const SEED_USER_STATUSES: readonly SeedStatus[] = ['open', 'snoozed', 'waiting', 'dismissed'];

/**
 * The longest summary a seed carries, in code points.
 *
 * 200, and the number is not chosen here: it is `MAX_MEMORY_CONTENT_LENGTH`,
 * the bound the confirmed-goal representation already enforces. A seed that
 * could not be promoted to a goal because it is 40 characters too long would
 * be a dead end the user cannot see from the screen — "Turn into a goal"
 * failing on the one seed they most wanted to keep. So the wider bound is the
 * one that has to give, and a segment longer than this is not proposed as a
 * seed at all rather than being truncated into a sentence nobody wrote.
 *
 * Code points rather than UTF-16 units, for the reason `requireContent` gives:
 * an Arabic or Hebrew sentence gets the same allowance an English one does.
 */
export const SEED_SUMMARY_MAX_CHARACTERS = 200;

export interface IntentSeed {
  readonly version: typeof INTENT_SEED_SCHEMA_VERSION;
  readonly seedId: string;
  readonly scopeId: string;
  readonly kind: SeedKind;
  /**
   * The user's own words. For `source: 'capture'` this is the exact segment
   * the proposal carried — copied from the stored proposal at confirm time,
   * never re-sent by the client, so there is no paraphrase for a model to have
   * invented a date, a person, or an inference into.
   */
  readonly summary: string;
  readonly status: SeedStatus;
  /**
   * When the user wants to be asked about this again. Their date, set by them
   * — a "reconsider this" marker, not a due time. Null means never.
   */
  readonly revisitAt: string | null;
  readonly source: 'capture' | 'manual' | 'share';
  /** The proposal id for a capture seed; null for a manual one. */
  readonly sourceRef: string | null;
  readonly provenance: {
    /** The capture proposal this seed was confirmed from, when there is one. */
    readonly proposalId: string | null;
    /** The engine that read the sentence, when one did. */
    readonly extractor: string | null;
    /**
     * When the user confirmed the seed. Always set on a stored seed: a seed
     * that nobody confirmed does not exist, which is the whole boundary.
     */
    readonly confirmedByUserAt: string;
  };
  /**
   * What it became, written by the promote path and by nothing else. A patch
   * that tried to write this would be a seed promoting itself.
   */
  readonly promotedTo: { readonly kind: 'commitment' | 'goal'; readonly id: string } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The seed half of a capture proposal (#519).
 *
 * `summary` is the segment the user wrote, verbatim. The deterministic
 * detector (`src/extraction/unresolvedIntent.ts`) is the only producer, which
 * is what the issue's rules — exact source evidence, no invented date, no
 * invented person, no sensitive inference — come down to when nothing between
 * the keyboard and this object rewrites the sentence.
 */
export interface CaptureSeedProposalContract {
  readonly seedItemId: string;
  readonly kind: SeedKind;
  readonly summary: string;
}

/**
 * What a caller may supply when creating a seed. Server-assigned fields
 * (seedId, status, provenance, promotedTo, timestamps) are never accepted —
 * the same rule the memory store keeps.
 */
export interface CreateSeedInput {
  readonly scopeId: string;
  readonly kind: SeedKind;
  readonly summary: string;
  readonly source: 'capture' | 'manual' | 'share';
  readonly sourceRef: string | null;
  readonly provenance: IntentSeed['provenance'];
  /**
   * The idempotency key the document id is derived from. A second create with
   * the same key returns the first seed rather than writing a twin — this is
   * what makes "confirm" safe to retry on a flaky connection.
   */
  readonly idempotencyKey: string;
}

/** What a patch may change. `status` is limited to SEED_USER_STATUSES. */
export interface PatchSeedInput {
  readonly summary?: string;
  readonly kind?: SeedKind;
  readonly status?: SeedStatus;
  /** An ISO instant, or null to clear the user's own revisit marker. */
  readonly revisitAt?: string | null;
}

/** The user's own data export for one scope: every seed, whatever its status. */
export interface SeedExport {
  readonly version: typeof INTENT_SEED_SCHEMA_VERSION;
  readonly scopeId: string;
  readonly exportedAt: string;
  readonly seeds: readonly IntentSeed[];
}

export interface IntentSeedStore {
  /**
   * Creates the seed, or returns the one this idempotency key already made.
   * `replayed` distinguishes the two so the route can answer 201 once and 200
   * for the retry — and so a double-tap cannot write two seeds.
   */
  create(input: CreateSeedInput, now: string): Promise<{ seed: IntentSeed; replayed: boolean }>;
  /** One seed in this scope. An id from another scope reads as absent. */
  get(scopeId: string, seedId: string): Promise<IntentSeed | null>;
  /** Every seed in the scope, newest first — including terminal ones. */
  list(scopeId: string): Promise<readonly IntentSeed[]>;
  /**
   * Applies a user patch. Returns null when the seed is not in the scope (or
   * does not exist). Refuses `promoted` — that status belongs to the promote
   * path alone.
   */
  patch(scopeId: string, seedId: string, input: PatchSeedInput, now: string): Promise<IntentSeed | null>;
  /**
   * The promotion claim: sets `status: 'promoted'` and `promotedTo` inside one
   * storage transaction, refusing (null) when the seed is already promoted or
   * dismissed. The only writer of `promotedTo`, so a promotion is claimed
   * exactly once and a racing second tap replays instead of double-creating.
   */
  claimPromotion(
    scopeId: string,
    seedId: string,
    promotedTo: { kind: 'commitment' | 'goal'; id: string },
    now: string,
  ): Promise<IntentSeed | null>;
  /** Removes outright. Returns false when not found in this scope. */
  remove(scopeId: string, seedId: string): Promise<boolean>;
  /** Removes every seed in a scope. Returns the number deleted. */
  deleteScope(scopeId: string): Promise<number>;
  export(scopeId: string, now: string): Promise<SeedExport>;
}

/**
 * The lifecycle events, and the whole of what may be observed (#519).
 *
 * Written to the account's audit log (`PilotAuditEvent`), whose shape — a
 * type, an outcome, a reason code — cannot carry the summary at all. That is
 * the mechanism behind "never log summary", not a convention.
 */
export const SEED_EVENT_NAMES = [
  'seed_proposed',
  'seed_confirmed',
  'seed_snoozed',
  'seed_promoted',
  'seed_dismissed',
] as const;

export type SeedEventName = (typeof SEED_EVENT_NAMES)[number];

/**
 * Seed fields that must never appear in analytics, audit fields, or telemetry
 * payloads. `summary` is the user's sentence; `promotedTo.id` names what it
 * became. The route tests assert the audit lines carry neither.
 */
export const SEED_TELEMETRY_FORBIDDEN_FIELDS = ['summary', 'promotedTo', 'sourceRef'] as const;
