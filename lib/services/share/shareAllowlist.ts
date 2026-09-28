/**
 * The action allowlist for a share (#193 step 2).
 *
 * ══ WHY THIS IS IN CODE AND NOT IN THE PROMPT ════════════════════
 *
 * The prompt already tells the model that shared content is untrusted. A prompt
 * is a request. This file is the part that does not depend on the model having
 * agreed: whatever comes back out of the capture pipeline for a *share* is
 * rebuilt here, field by field, from an allowlist — so a model that has been
 * talked into returning `{"action":"delete_all"}`, `"confirmed": true`, a
 * `suggestedNextAction.kind` of `send_message` or fifty items with URLs in
 * their titles produces, at most, fewer proposals than it asked for.
 *
 * The response type it rebuilds into has **no field able to express** delete,
 * update, subscribe, send or confirm. That is the invariant; this is its
 * enforcement.
 *
 * ── Why the field list is the contract's and not #193's ──────────
 *
 * #193 sketches the item fields as `title`, `dueAt`, `remindAt`, `person`,
 * `kind`, `evidence*`, `confidence`, `page`. That was UC-3.0's design sketch.
 * The shape the server actually emits is `CaptureProposalItemContract`, and an
 * allowlist written against the sketch would have dropped every real item —
 * `resolvedTime` is what `dueAt` became, and `evidence` lives on the envelope
 * rather than on the item. So the list below is imported from the contract that
 * the route really answers with, and the sketch's names are recorded here as
 * the history they are. A validator whose vocabulary the server does not speak
 * is not strict; it is broken.
 *
 * ── Reports, never throws ────────────────────────────────────────
 *
 * The idiom is `lib/safety/postValidator.ts`'s: every refusal is a value in a
 * returned list, in input order, and no input of any shape raises. A share that
 * arrives while the model is compromised must still answer the phone.
 */
import { detectPromptInjection } from '../../../src/extraction/ollamaExtractor';

/**
 * Every field one proposed item may carry, from `CaptureProposalItemContract`.
 *
 * Adding a field to that contract without adding it here drops the field from
 * every share, which is the safe direction: a share loses a decoration, and a
 * test in `tests/share/shareInjectionSuite.test.ts` says so out loud.
 */
export const ALLOWED_ITEM_FIELDS: readonly string[] = [
  'itemId',
  'title',
  'resolvedTime',
  'needsClarification',
  'priority',
  'priorityEstimated',
  // The day and whether it was guessed (L4). Without these here a share naming
  // a weekday lost its whole item as `unknown_field`.
  'resolvedDate',
  'dateEstimated',
  'clarification',
];

/** Every field the proposal envelope itself may carry. */
export const ALLOWED_PROPOSAL_FIELDS: readonly string[] = [
  'version',
  'proposalId',
  'status',
  'noCommitmentReason',
  'items',
  'seeds',
  'provenance',
];

/** The three next actions that exist. Nothing here can send, delete or confirm. */
export const ALLOWED_NEXT_ACTION_KINDS: readonly string[] = ['review', 'plan_time', 'set_reminder'];

/** The statuses a proposal may claim. */
const ALLOWED_STATUSES: readonly string[] = [
  'proposed',
  'needs_clarification',
  'no_commitment',
  'rejected',
  'unresolved_intent',
];

/**
 * The most items one share may propose.
 *
 * A compromised model's cheapest move is volume, and this is the bound on it.
 *
 * **One hundred, and the number is not arbitrary.** It is `MAX_DEADLINES` in
 * `lib/calendar/icsImport.ts` — the same ceiling #193 step 9 puts on one ICS
 * refresh — so the two untrusted bulk paths into this product answer to one
 * number rather than to two that drift.
 *
 * It is deliberately **above** every honest ceiling below it: the document
 * channel already caps at forty items, and a fifty-message WhatsApp export
 * that is genuinely fifty commitments must survive intact. A cap that fired on
 * a real share would be this file breaking the product to look strict, which
 * is precisely the failure #193's benign-recall requirement exists to catch —
 * and it did catch an earlier draft of this constant at twenty, against
 * `tests/share/whatsappChannel.test.ts`'s forty-nine-message case.
 */
export const MAX_SHARE_ITEMS = 100;

/** Why one item, or one field, did not survive. */
export type ShareDropReason =
  /** The item was not an object at all. */
  | 'unreadable_item'
  /** The item, or the proposal, carried a field no contract declares. */
  | 'unknown_field'
  /** A URL in a title: `https?://`, `www.`, or `webcal://`. */
  | 'url'
  /** `tel:` or `mailto:` — an instruction to contact somebody. */
  | 'contact_uri'
  /** The title is addressed to the assistant, per `detectPromptInjection`. */
  | 'instruction_title'
  /** The title was absent or not a string. */
  | 'unusable_title'
  /** Past `MAX_SHARE_ITEMS`. */
  | 'over_item_cap'
  /** A `suggestedNextAction.kind` outside the three that exist. */
  | 'forbidden_next_action'
  /** A `status` outside the contract's enum. */
  | 'unknown_status'
  /** An `itemId` that was absent, oversized, or a link. */
  | 'unusable_id'
  /** A seed whose shape or whose rendered summary this will not pass on. */
  | 'unreadable_seed'
  /**
   * A field the contract declares, carrying a value it does not allow.
   *
   * Its own reason, because the item itself survives. Review's finding: a
   * hostile `clarification.params`, a `resolvedTime` that is an object and a
   * free-text `priority` were all stripped correctly and **silently** — the
   * item came back with `drops: []`, so `ignoredSegments` was 0 and the
   * review screen told the person nothing had been ignored. `rebuildSeeds`
   * already reported its drops; these did not.
   */
  | 'unusable_value';

export interface ShareAllowlistDrop {
  /** The item's index in the input, or null for a proposal-level refusal. */
  readonly index: number | null;
  readonly reason: ShareDropReason;
  /** The offending key, when the reason names one. Never the value. */
  readonly field?: string;
}

export interface ShareAllowlistResult<T> {
  /** The proposal, rebuilt from allowed fields only. */
  readonly proposal: T;
  /** Every refusal, in input order. `length` is what the envelope counts. */
  readonly drops: readonly ShareAllowlistDrop[];
}

/** `https://`, `www.` and `webcal://` — a link, however it was written. */
const URL_PATTERN = /https?:\/\/|\bwww\.[a-z0-9-]|webcal:\/\//i;
/** An instruction to contact somebody, which a title may never be. */
const CONTACT_URI_PATTERN = /\b(tel|mailto|sms|facetime):/i;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Is this title a link, a contact instruction, or a sentence aimed at the
 * assistant?
 *
 * `detectPromptInjection` rather than a second local regex, deliberately: the
 * guard already normalises away zero-width and bidi obfuscation and already
 * knows the Arabic and Hebrew phrasings, and a private copy here would be a
 * second vocabulary that drifts from the first (Sprint 06's lesson, stated at
 * the top of `postValidator.ts`).
 */
/**
 * The most characters one proposed title may carry.
 *
 * `MAX_TITLE_LENGTH` in `lib/calendar/icsImport.ts`, deliberately the same
 * number: both are "a title a person reads on a review screen", and two
 * ceilings for one idea drift. A model talked into returning a paragraph as a
 * title is not caught by any check above this — the paragraph contains no URL
 * and no instruction — it just makes the review screen unreadable.
 */
export const MAX_TITLE_CHARACTERS = 120;

export function titleDropReason(title: unknown): ShareDropReason | null {
  if (typeof title !== 'string' || title.trim() === '') return 'unusable_title';
  if (Array.from(title).length > MAX_TITLE_CHARACTERS) return 'unusable_title';
  return freeTextDropReason(title);
}

/**
 * The same three checks, for any string that reaches a person's screen.
 *
 * Split out from `titleDropReason` because a title is not the only rendered
 * string in this response. `seeds[].summary` is rendered in Review and
 * **persisted when the user taps Keep** (`captureContracts.ts`), and a
 * clarification's `params` are interpolated into the question the phone
 * renders. An attacker-controlled string in either is one tap from the
 * account, and before this they were copied through untouched.
 */
function freeTextDropReason(text: string): ShareDropReason | null {
  if (URL_PATTERN.test(text)) return 'url';
  if (CONTACT_URI_PATTERN.test(text)) return 'contact_uri';
  if (detectPromptInjection(text) !== null) return 'instruction_title';
  return null;
}

/** Own properties only. `in` walks the prototype chain; see `rebuildItem`. */
function owns(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isIsoLike(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

/** An id this response may carry: short, and not a link. */
function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    && !URL_PATTERN.test(value) && !CONTACT_URI_PATTERN.test(value);
}

const PRIORITY_LEVELS: readonly string[] = ['low', 'normal', 'high'];
const CLARIFICATION_FIELDS: readonly string[] = ['time', 'action', 'time_period', 'which_day'];
const SEED_KINDS: readonly string[] = ['consideration', 'waiting_for', 'idea', 'possible_goal'];
const REQUESTED_ENGINES: readonly string[] = ['model', 'rules'];
const EXECUTED_ENGINES: readonly string[] = ['gemini', 'ollama', 'rule-based'];
const NO_COMMITMENT_REASONS: readonly string[] = [
  'informational', 'greeting_or_chat', 'question', 'past_event', 'negated_request', 'low_confidence',
];

/**
 * A key-level allowlist is only half of one.
 *
 * Review's finding, and it is the sharper half: the first version refused
 * unknown *keys* and then copied the allowed keys' **values** through
 * verbatim. So `clarification` could carry a whole nested payload,
 * `resolvedTime` could be an object where the client's `.strict()` Zod schema
 * expects `string | null` — a crash on the phone, not a refusal —
 * `priority` could be free text, and `itemId` could be a URL. Every one of
 * those passed with `drops: []`.
 *
 * So every value is rebuilt to its declared type here, and a value that is
 * not the type the contract declares is dropped rather than coerced.
 * Coercing would be this file inventing data.
 */
function rebuildClarification(
  raw: unknown,
  report: (field: string) => void,
): unknown {
  if (raw === null || raw === undefined) return raw;
  if (!isObject(raw)) { report('clarification'); return null; }
  if (!isSafeId(raw.questionId) || typeof raw.questionKey !== 'string') { report('clarification'); return null; }
  if (freeTextDropReason(raw.questionKey) !== null) { report('clarification.questionKey'); return null; }
  if (typeof raw.field !== 'string' || !CLARIFICATION_FIELDS.includes(raw.field)) {
    report('clarification.field');
    return null;
  }
  const params: Record<string, string> = {};
  if (isObject(raw.params)) {
    for (const key of Object.keys(raw.params)) {
      const value = raw.params[key];
      // Rendered into the sentence the phone shows. Screened exactly as a
      // title is, because it reaches the same eyes.
      if (typeof value === 'string' && freeTextDropReason(value) === null) params[key] = value;
      else report('clarification.params');
    }
  }
  const options: unknown[] = [];
  if (Array.isArray(raw.options)) {
    for (const option of raw.options) {
      if (!isObject(option)) continue;
      if (!isSafeId(option.optionId) || typeof option.labelKey !== 'string') continue;
      if (freeTextDropReason(option.labelKey) !== null) continue;
      const labelParams: Record<string, string> = {};
      if (isObject(option.labelParams)) {
        for (const key of Object.keys(option.labelParams)) {
          const value = option.labelParams[key];
          if (typeof value === 'string' && freeTextDropReason(value) === null) labelParams[key] = value;
          else report('clarification.options[].labelParams');
        }
      }
      const value: Record<string, string> = {};
      if (isObject(option.value)) {
        for (const key of ['localTime', 'localDate']) {
          const candidate = option.value[key];
          if (typeof candidate === 'string' && candidate.length <= 32) value[key] = candidate;
        }
      }
      options.push({ optionId: option.optionId, labelKey: option.labelKey, labelParams, value });
    }
  }
  return {
    questionId: raw.questionId,
    field: raw.field,
    questionKey: raw.questionKey,
    params,
    options,
    allowFreeText: raw.allowFreeText === true,
  };
}

/**
 * `seeds[].summary` is rendered in Review and persisted on a tap.
 *
 * The one field in this response that is *already* intended to be
 * attacker-adjacent free text — it is "the sentence the person typed" — and
 * on a share the person did not type it, a stranger did. Screened like a
 * title, and the seed is dropped rather than blanked, because a seed with no
 * summary is an empty row somebody is asked to decide about.
 */
function rebuildSeeds(raw: unknown, drops: ShareAllowlistDrop[]): unknown[] {
  if (!Array.isArray(raw)) return [];
  const seeds: unknown[] = [];
  raw.forEach((candidate: unknown, index: number) => {
    if (!isObject(candidate)) { drops.push({ index, reason: 'unreadable_seed' }); return; }
    if (!isSafeId(candidate.seedItemId)
      || typeof candidate.kind !== 'string' || !SEED_KINDS.includes(candidate.kind)) {
      drops.push({ index, reason: 'unreadable_seed' });
      return;
    }
    if (typeof candidate.summary !== 'string') { drops.push({ index, reason: 'unreadable_seed' }); return; }
    const reason = freeTextDropReason(candidate.summary);
    if (reason !== null) { drops.push({ index, reason, field: 'seeds[].summary' }); return; }
    seeds.push({
      seedItemId: candidate.seedItemId,
      kind: candidate.kind,
      summary: candidate.summary,
    });
  });
  return seeds;
}

/** `{ requestedEngine, executedEngine, fallbackUsed }`, or nothing. */
function rebuildProvenance(raw: unknown): unknown {
  if (!isObject(raw)) return undefined;
  if (typeof raw.requestedEngine !== 'string' || !REQUESTED_ENGINES.includes(raw.requestedEngine)) return undefined;
  if (typeof raw.executedEngine !== 'string' || !EXECUTED_ENGINES.includes(raw.executedEngine)) return undefined;
  return {
    requestedEngine: raw.requestedEngine,
    executedEngine: raw.executedEngine,
    fallbackUsed: raw.fallbackUsed === true,
  };
}

/**
 * Rebuilds a share's proposal out of the fields the contract declares.
 *
 * Pure, total, and order-preserving. The returned `drops` are the reasons, in
 * input order: proposal-level refusals first, then one entry per refused item.
 */
export function applyShareActionAllowlist<T>(raw: unknown): ShareAllowlistResult<T> {
  const drops: ShareAllowlistDrop[] = [];
  if (!isObject(raw)) {
    // Not a proposal at all. The empty one is built by the caller, which knows
    // the ids; all this can honestly say is that nothing survived.
    return { proposal: { items: [] } as unknown as T, drops: [{ index: null, reason: 'unreadable_item' }] };
  }

  for (const key of Object.keys(raw)) {
    if (!ALLOWED_PROPOSAL_FIELDS.includes(key)) drops.push({ index: null, reason: 'unknown_field', field: key });
  }

  const kept: Record<string, unknown> = {};
  kept.version = typeof raw.version === 'string' && raw.version.length <= 16 ? raw.version : 'v1';
  kept.proposalId = isSafeId(raw.proposalId) ? raw.proposalId : '';
  if (typeof raw.status === 'string' && ALLOWED_STATUSES.includes(raw.status)) {
    kept.status = raw.status;
  } else {
    drops.push({ index: null, reason: 'unknown_status' });
    kept.status = 'no_commitment';
  }
  if (typeof raw.noCommitmentReason === 'string' && NO_COMMITMENT_REASONS.includes(raw.noCommitmentReason)) {
    kept.noCommitmentReason = raw.noCommitmentReason;
  }

  const rawItems = Array.isArray(raw.items) ? raw.items : [];
  const items: Record<string, unknown>[] = [];
  rawItems.forEach((candidate: unknown, index: number) => {
    if (items.length >= MAX_SHARE_ITEMS) {
      drops.push({ index, reason: 'over_item_cap' });
      return;
    }
    if (!isObject(candidate)) {
      drops.push({ index, reason: 'unreadable_item' });
      return;
    }
    const unknown = Object.keys(candidate).find((key) => !ALLOWED_ITEM_FIELDS.includes(key));
    if (unknown !== undefined) {
      drops.push({ index, reason: 'unknown_field', field: unknown });
      return;
    }
    const reason = titleDropReason(candidate.title);
    if (reason !== null) {
      drops.push({ index, reason });
      return;
    }
    if (!isSafeId(candidate.itemId)) {
      drops.push({ index, reason: 'unusable_id' });
      return;
    }
    /*
     * `hasOwnProperty`, not `key in candidate`.
     *
     * `in` walks the prototype chain, so an item whose *prototype* carried
     * `priority` had it copied into the response while `Object.keys` — which
     * is what the unknown-field check above reads — saw nothing to refuse.
     * The two loops disagreed about what the object contained.
     */
    /*
     * Every value this strips is *reported*, not only removed.
     *
     * A drop the envelope does not count is a drop the person is not told
     * about: `ignoredSegments` is what the review screen renders as "some
     * parts were ignored", and an item whose clarification was a payload
     * came back looking untouched.
     */
    const report = (field: string) => { drops.push({ index, reason: 'unusable_value', field }); };
    const item: Record<string, unknown> = { itemId: candidate.itemId, title: candidate.title };
    if (candidate.resolvedTime === null || candidate.resolvedTime === undefined) {
      item.resolvedTime = null;
    } else if (isIsoLike(candidate.resolvedTime)) {
      item.resolvedTime = candidate.resolvedTime;
    } else {
      // An object here is a crash on the phone, not a refusal: the client's
      // schema is `.strict()` and expects `string | null`.
      report('resolvedTime');
      item.resolvedTime = null;
    }
    item.needsClarification = candidate.needsClarification === true;
    if (owns(candidate, 'priority')) {
      if (typeof candidate.priority === 'string' && PRIORITY_LEVELS.includes(candidate.priority)) {
        item.priority = candidate.priority;
      } else {
        report('priority');
      }
    }
    if (owns(candidate, 'priorityEstimated')) item.priorityEstimated = candidate.priorityEstimated === true;
    // A day key and its flag travel together, or neither does: a guess flag
    // with no day would mark nothing, and a day without it would read as stated.
    if (owns(candidate, 'resolvedDate')) {
      if (typeof candidate.resolvedDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(candidate.resolvedDate)) {
        item.resolvedDate = candidate.resolvedDate;
        item.dateEstimated = candidate.dateEstimated === true;
      } else {
        report('resolvedDate');
      }
    }
    if (owns(candidate, 'clarification')) {
      const clarification = rebuildClarification(candidate.clarification, report);
      if (clarification !== undefined) item.clarification = clarification;
    }
    items.push(item);
  });
  kept.items = items;
  kept.seeds = rebuildSeeds(raw.seeds, drops);
  const provenance = rebuildProvenance(raw.provenance);
  if (provenance !== undefined) kept.provenance = provenance;

  // A status that claimed commitments when none survived would send the review
  // screen a headline its own list contradicts.
  if (items.length === 0 && (kept.status === 'proposed' || kept.status === 'needs_clarification')) {
    kept.status = 'no_commitment';
  }

  return { proposal: kept as unknown as T, drops };
}

/**
 * The next action, or null — and a drop when the model named one that is not
 * one of the three.
 *
 * ── On reachability, stated rather than implied ──────────────────
 *
 * `suggestNextAction` in `shareIntakeService.ts` *derives* the action from the
 * items that survived, so on today's only path the `kind` can never be
 * anything but one of the three. Review proved that by deleting the check and
 * watching the suite stay green, and it is worth being exact about what that
 * means: the `kind` branch is **defence in depth against a future caller**,
 * not a live control, and it is covered by a direct unit test rather than by
 * an end-to-end one that cannot reach it. The `itemId` branch and the rebuild
 * below *are* live.
 */
export function allowedNextAction<A extends { kind: string; itemId: string }>(
  action: A | null,
  keptItemIds: ReadonlySet<string>,
): { action: A | null; drop: ShareAllowlistDrop | null } {
  if (action === null || !isObject(action)) return { action: null, drop: null };
  if (!ALLOWED_NEXT_ACTION_KINDS.includes(action.kind)) {
    return { action: null, drop: { index: null, reason: 'forbidden_next_action' } };
  }
  // An action naming an item that did not survive is an action pointing at
  // nothing; the screen would open an empty sheet.
  if (!keptItemIds.has(action.itemId)) {
    return { action: null, drop: { index: null, reason: 'forbidden_next_action' } };
  }
  /*
   * Rebuilt, not returned. `{ kind: 'review', itemId: 'i1', action:
   * 'delete_all' }` used to come back with the third key intact — this
   * function's own docstring said it refused what the product cannot do, and
   * it only refused the *kind*.
   */
  return { action: { kind: action.kind, itemId: action.itemId } as A, drop: null };
}
