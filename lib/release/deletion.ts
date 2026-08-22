/**
 * Deleting one study participant, and the receipt that proves it (#47).
 *
 * ── Sprint 10's receipt is embedded, not re-invented ─────────────
 *
 * `ShadowStudyDeletionReceipt` carries a whole `PersonalizationDeletionReceipt`
 * inside it, and this module gets that receipt by calling #41's
 * `deletePersonalizationScope` rather than by producing a second answer to "is
 * the personalization substrate gone". What Sprint 11 adds is three stores
 * Sprint 10 did not have: study responses, shadow traces and replay bundles.
 *
 * ── Every remainder is re-listed, never subtracted ───────────────
 *
 * The counts on the receipt are read from the stores *after* the deletes, by
 * asking them again. Subtracting what a `deleteParticipant` claimed to remove
 * from what was there before would make the receipt a restatement of the delete
 * call's own opinion, and the one failure a deletion receipt must catch is a
 * delete that reports a count and leaves rows behind.
 *
 * ── An unwired store is "we cannot prove it", not "it is empty" ──
 *
 * #45's trace and replay stores do not exist yet. Wiring a stub that answers
 * `0` would produce a receipt claiming zero traces remain — a claim nobody
 * checked, in the exact shape this repo has twice mistaken for a result. So the
 * archives arrive as a `ShadowArchiveAccess` variant, an unwired one is named
 * in `unprovable`, and the outcome is `deleted_unproven`: everything that could
 * be deleted *was* deleted (a participant who asked to be forgotten is not made
 * to wait on a missing dependency), and the one thing that cannot be
 * demonstrated is said out loud instead of asserted.
 *
 * Integration is a one-line change per archive: `wiredArchive(#45's store)`.
 *
 * ── The digest, and what it does and does not prove ──────────────
 *
 * `shadowEmptyStateDigest` is a pure function of `(participantId, deletedAt)`
 * and reads no store, exactly as `emptyStateDigestFor` does in Sprint 10 — and
 * with the same limitation, stated in the same place: it would hold even if the
 * deletion did nothing. What it gives a verifier is a value bound to this
 * participant and this instant, so one person's receipt cannot verify another's
 * deletion and last week's cannot verify today's. The load-bearing proof of
 * emptiness is the remainder counts, which are re-listed.
 *
 * It is exported because a verifier needs its own path to the number. A receipt
 * whose proof can only be produced by the module under test is not a proof.
 */
import { createHash } from 'node:crypto';
import {
  SHADOW_PIPELINE_CONTRACT_VERSION,
  SHADOW_PIPELINE_SCHEMA_VERSION,
  SHADOW_SAFE_CODE,
  isInstant,
  type Instant,
  type PersonalizationDeletionReceipt,
  type ShadowStudyDeletionReceipt,
} from '../../src/contracts/v1/shadowPipelineContracts';
import type { ShadowStudyConsentStore } from './consentStore';
import type { ShadowStudyResponseStore } from './studyStore';

/**
 * Every store a study deletion speaks for, in the receipt's own emission order.
 *
 * Listed once, and named inside the digest preimage, so a store added later
 * changes the digest — whoever adds a fourth place a participant's data lives
 * has to come here and decide what it means, rather than have it quietly
 * survive a deletion that reports success.
 */
export const SHADOW_DELETABLE_STORES = Object.freeze([
  'consent',
  'study_responses',
  'traces',
  'replay_bundles',
  'personalization',
] as const);

export type ShadowDeletableStore = (typeof SHADOW_DELETABLE_STORES)[number];

/* ── The archive seam (#45's stores, before #45 exists) ──────────── */

/**
 * The only two questions a deletion asks of a trace or replay store: how many
 * are there for this participant, and remove them.
 *
 * Deliberately not a read: #47 has no business reading trace *contents*, and a
 * port that could would be a port that could put one in a receipt.
 */
export interface ShadowParticipantArchive {
  countFor(participantId: string): number;
  deleteParticipant(participantId: string): number;
}

export type ShadowArchiveAccess =
  | { readonly status: 'wired'; readonly archive: ShadowParticipantArchive }
  | { readonly status: 'not_wired'; readonly owner: string };

export function wiredArchive(archive: ShadowParticipantArchive): ShadowArchiveAccess {
  return { status: 'wired', archive };
}

/** `owner` names who has to land before this can be proven. It reaches the caller. */
export function notWiredArchive(owner: string): ShadowArchiveAccess {
  return { status: 'not_wired', owner };
}

/** A deterministic archive for tests and fixtures. Holds ids, nothing else. */
export function createInMemoryShadowArchive(
  participantIds: readonly string[] = [],
): ShadowParticipantArchive {
  let held = [...participantIds];
  return {
    countFor: (participantId) => held.filter((id) => id === participantId).length,
    deleteParticipant: (participantId) => {
      const before = held.length;
      held = held.filter((id) => id !== participantId);
      return before - held.length;
    },
  };
}

/* ── The empty-state digest ──────────────────────────────────────── */

/** ASCII separators, spelled as escapes so an editor cannot strip them. */
const UNIT_SEPARATOR = '\u001f';
const RECORD_SEPARATOR = '\u001e';

const DELETION_PREIMAGE_SCHEMA = 'shadow-study-deletion-v1';

/**
 * The canonical preimage the digest is taken over.
 *
 * Exported alongside the digest so a verifier can check the *shape* of the
 * claim as well as its hash — agreement between two digests then means
 * agreement about the receipt rather than agreement about a hashing
 * convention, which is the rule `shadowReplayPreimage` states in the contract.
 */
export function shadowEmptyStatePreimage(participantId: string, deletedAt: Instant): string {
  return [
    `schema${UNIT_SEPARATOR}${DELETION_PREIMAGE_SCHEMA}`,
    `participant${UNIT_SEPARATOR}${participantId}`,
    `deletedAt${UNIT_SEPARATOR}${deletedAt}`,
    `stores${UNIT_SEPARATOR}${SHADOW_DELETABLE_STORES.join(UNIT_SEPARATOR)}`,
  ].join(RECORD_SEPARATOR);
}

export function shadowEmptyStateDigest(participantId: string, deletedAt: Instant): string {
  return createHash('sha256').update(shadowEmptyStatePreimage(participantId, deletedAt), 'utf8').digest('hex');
}

/* ── The deletion ────────────────────────────────────────────────── */

export interface ShadowStudyDeletionInput {
  readonly participantId: string;
  /** From the caller. This module never reads a clock. */
  readonly now: Instant;
  readonly consent: ShadowStudyConsentStore;
  readonly responses: ShadowStudyResponseStore;
  readonly traces: ShadowArchiveAccess;
  readonly replayBundles: ShadowArchiveAccess;
  /**
   * #41's `deletePersonalizationScope`, injected. Undefined when the build has
   * not wired it, which is `personalization` in `unprovable` rather than a
   * receipt with a fabricated inner one.
   */
  readonly deletePersonalization?: (scopeId: string, now: Instant) => PersonalizationDeletionReceipt;
  /** Defaults to `participantId`. Separate because the two namespaces are. */
  readonly personalizationScopeId?: string;
}

export const SHADOW_DELETION_REFUSALS = Object.freeze([
  'unsafe_participant',
  'malformed_instant',
] as const);

export type ShadowDeletionRefusal = (typeof SHADOW_DELETION_REFUSALS)[number];

export type ShadowDeletionRemovals = Readonly<Record<ShadowDeletableStore, number | null>>;

export type ShadowDeletionOutcome =
  | {
      readonly status: 'deleted';
      readonly receipt: ShadowStudyDeletionReceipt;
      readonly removed: ShadowDeletionRemovals;
      /** Not a receipt field; the contract's receipt has three remainders. */
      readonly remainingConsentRecordCount: number;
    }
  | {
      readonly status: 'deleted_unproven';
      readonly unprovable: readonly ShadowDeletableStore[];
      readonly removed: ShadowDeletionRemovals;
      readonly remainingConsentRecordCount: number;
      readonly detail: string;
    }
  | { readonly status: 'refused'; readonly reason: ShadowDeletionRefusal; readonly detail: string };

/**
 * Deletes everything this sprint stores about one participant.
 *
 * The order is: delete what can be deleted, then ask every store again, then
 * decide whether the result is provable. Deleting first means an unwired
 * dependency delays the *proof*, never the deletion — a participant who asked
 * to be forgotten is not left in the study because #45 has not merged.
 */
export function deleteShadowStudyParticipant(
  input: ShadowStudyDeletionInput,
): ShadowDeletionOutcome {
  if (typeof input.participantId !== 'string' || !SHADOW_SAFE_CODE.test(input.participantId)) {
    return {
      status: 'refused',
      reason: 'unsafe_participant',
      detail: `participantId is outside the safe-code pattern: ${String(input.participantId)}`,
    };
  }
  if (!isInstant(input.now)) {
    return {
      status: 'refused',
      reason: 'malformed_instant',
      detail: `now is not an ISO instant with an explicit offset: ${String(input.now)}`,
    };
  }

  const { participantId } = input;
  const scopeId = input.personalizationScopeId ?? participantId;

  const removedConsent = input.consent.deleteParticipant(participantId);
  const removedResponses = input.responses.deleteParticipant(participantId);
  const removedTraces = input.traces.status === 'wired'
    ? input.traces.archive.deleteParticipant(participantId)
    : null;
  const removedBundles = input.replayBundles.status === 'wired'
    ? input.replayBundles.archive.deleteParticipant(participantId)
    : null;

  let personalization: PersonalizationDeletionReceipt | null = null;
  if (input.deletePersonalization !== undefined) {
    personalization = input.deletePersonalization(scopeId, input.now);
  }

  // Re-listed, in `SHADOW_DELETABLE_STORES` order.
  const remainingConsentRecordCount = input.consent.countFor(participantId);
  const remainingStudyResponseCount = input.responses.countFor(participantId);
  const remainingTraceCount = input.traces.status === 'wired'
    ? input.traces.archive.countFor(participantId)
    : null;
  const remainingReplayBundleCount = input.replayBundles.status === 'wired'
    ? input.replayBundles.archive.countFor(participantId)
    : null;

  const removed: ShadowDeletionRemovals = {
    consent: removedConsent,
    study_responses: removedResponses,
    traces: removedTraces,
    replay_bundles: removedBundles,
    personalization: personalization === null ? null : 1,
  };

  // One condition, and `unprovable` is derived from the same reads rather than
  // accumulated beside them. A second list built from a second set of checks
  // would agree with this guard until one of them was edited.
  //
  // ── Why consent, and only consent, is checked for survival here ──
  //
  // The first version asked only "could emptiness be *read*", never "was it
  // *empty*". For three of the stores that is right: their remainders are
  // fields of the receipt, so a leftover row is caught by
  // `checkShadowStudyDeletionReceipt` and the tests below prove it, one field
  // at a time. Issuing the receipt and letting its own checker refuse it is the
  // stronger arrangement — the lie is recorded in the artifact rather than
  // swallowed by the producer.
  //
  // Consent has no such field. `ShadowStudyDeletionReceipt` carries three
  // remainders and cannot take a fourth, so `remainingConsentRecordCount` was
  // re-listed on the line above, returned beside the receipt, and acted on by
  // nothing. An integration review handed this a consent store whose
  // `deleteParticipant` returns 1 and removes nothing, and got back
  // `status: 'deleted'`, **zero defects from the contract checker**, and a
  // digest that recomputes — while the participant's granted scopes stayed
  // fully readable. A receipt is a claim of emptiness; this module may not make
  // one for a scope it can see is not empty and cannot show.
  //
  // Not symmetric with `removed`: a store that removed nothing because there
  // was nothing is fine. Only a remainder refuses.
  const survivingConsent = remainingConsentRecordCount > 0;

  if (
    remainingTraceCount === null ||
    remainingReplayBundleCount === null ||
    personalization === null ||
    survivingConsent
  ) {
    const missing: [ShadowDeletableStore, string | null][] = [
      ['consent', survivingConsent ? `${remainingConsentRecordCount} record(s) survived the delete` : null],
      ['traces', remainingTraceCount === null && input.traces.status === 'not_wired' ? input.traces.owner : null],
      ['replay_bundles', remainingReplayBundleCount === null && input.replayBundles.status === 'not_wired' ? input.replayBundles.owner : null],
      ['personalization', personalization === null ? 'no deleter wired in this build' : null],
    ];
    const unprovable = missing
      .filter(([, owner]) => owner !== null)
      .map(([store]) => store);
    const owners = missing
      .filter(([, owner]) => owner !== null)
      .map(([store, owner]) => `${store} (${String(owner)})`);
    return {
      status: 'deleted_unproven',
      unprovable,
      removed,
      remainingConsentRecordCount,
      detail: `the deletion was performed, but emptiness could not be demonstrated for: ${owners.join('; ')}`,
    };
  }

  return {
    status: 'deleted',
    removed,
    remainingConsentRecordCount,
    receipt: {
      version: SHADOW_PIPELINE_CONTRACT_VERSION,
      schemaVersion: SHADOW_PIPELINE_SCHEMA_VERSION,
      participantId,
      deletedAt: input.now,
      personalization,
      remainingTraceCount,
      remainingReplayBundleCount,
      remainingStudyResponseCount,
      emptyStateDigest: shadowEmptyStateDigest(participantId, input.now),
    },
  };
}
