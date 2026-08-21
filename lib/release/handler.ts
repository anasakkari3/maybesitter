/**
 * The controlled-release endpoint's request handling, kept out of the route.
 *
 * The route parses JSON and nothing else; every decision below is reachable
 * from a test with no server, no port and no filesystem.
 * `lib/personalizationControls/handler.ts` is the same shape and the reason it
 * is the shape.
 *
 * ── Reports, never throws ────────────────────────────────────────
 *
 * Every field read here is on an object a caller built, so every read can be
 * hostile. A handler that throws turns a bad request into a 500 and a stack
 * trace, which tells the client nothing it can act on. Every rejection names a
 * code in one vocabulary instead.
 *
 * ── `now` comes from the caller, and is required ─────────────────
 *
 * Not defaulted to `Date.now()`. Consents, study answers and deletion receipts
 * all carry an instant a participant may later be shown, and an instant this
 * module invented is one nobody can reproduce. It is checked with `isInstant`
 * rather than for being a non-empty string, because `2026-02-30` parses — to
 * the 2nd of March — and every store below would have thrown a 500 on it. That
 * was Sprint 10's review finding, and it is not repeated here.
 *
 * ── The response instant is the request's, never the client's ────
 *
 * `submit_response` ignores any `respondedAt` in the body. A participant's
 * client that could date its own answer would make a study whose timestamps
 * the respondent chooses, which cannot be ordered against the runs it is about.
 *
 * ── Consent responses carry the exposure they imply ──────────────
 *
 * A grant or a revocation returns the rebuilt exposure decision in the same
 * response, so a client cannot show a live exposure beside a withdrawn consent
 * even if it wanted to. Same reason the controls handler rebuilds the
 * inventory next to a flipped toggle.
 */
import {
  SHADOW_CONSENT_SCOPES,
  isInstant,
  type Instant,
  type ShadowConsentScope,
  type ShadowEvidencePillar,
  type ShadowPilotDecision,
} from '../../src/contracts/v1/shadowPipelineContracts';
import type { ShadowStudyConsentStore } from './consentStore';
import type { ShadowStudyResponseStore } from './studyStore';
import {
  deleteShadowStudyParticipant,
  type ShadowArchiveAccess,
  type ShadowStudyDeletionInput,
} from './deletion';
import {
  buildEvidencePackage,
  type ShadowPillarSource,
} from './evidence';
import {
  checkStageConfiguration,
  resolveCohortExposure,
  resolveStagedExposure,
  tallyExposure,
  type ShadowExposurePort,
  type ShadowStageConfiguration,
} from './exposure';
import { parseStudyResponse, summarizeStudyResponses } from './study';

export const RELEASE_ACTIONS = Object.freeze([
  'consent_status',
  'grant_consent',
  'revoke_consent',
  'exposure',
  'cohort_exposure',
  'submit_response',
  'study_summary',
  'evidence_package',
  'delete',
] as const);

export type ReleaseAction = (typeof RELEASE_ACTIONS)[number];

export const RELEASE_REJECTION_CODES = Object.freeze([
  'MALFORMED_REQUEST_BODY',
  'MISSING_INSTANT',
  'MALFORMED_INSTANT',
  'MISSING_PARTICIPANT',
  'UNKNOWN_ACTION',
  'UNKNOWN_SCOPE',
  'CONSENT_REJECTED',
  'RESPONSE_REJECTED',
  'DELETION_REFUSED',
  'EVIDENCE_REFUSED',
  'NOT_WIRED',
] as const);

export type ReleaseRejectionCode = (typeof RELEASE_REJECTION_CODES)[number];

export interface ReleaseRejection {
  readonly kind: 'rejected';
  readonly code: ReleaseRejectionCode;
  readonly detail: string;
}

export interface ReleaseOutcome {
  readonly status: number;
  readonly response: unknown;
}

/**
 * Everything the endpoint reads, named in one place.
 *
 * The seams are injected rather than imported for the reason
 * `PersonalizationControlsPort.deriver` is: #45's trace store and #46's SLO
 * readings land on other branches, and a handler that imported them could not
 * be written — or tested — until they merged. `traces` and `replayBundles` are
 * `ShadowArchiveAccess` variants so an unwired one is a shape rather than an
 * absence, and `evidenceSources` is optional so a build without it refuses the
 * package instead of assembling one out of nothing.
 */
export interface ReleaseHandlerDeps {
  readonly consent: ShadowStudyConsentStore;
  readonly responses: ShadowStudyResponseStore;
  readonly configuration: ShadowStageConfiguration;
  readonly resolvePilot: (participantId: string, at: Instant) => ShadowPilotDecision;
  readonly traces: ShadowArchiveAccess;
  readonly replayBundles: ShadowArchiveAccess;
  readonly deletePersonalization?: ShadowStudyDeletionInput['deletePersonalization'];
  readonly evidenceSources?: () => Readonly<Record<ShadowEvidencePillar, ShadowPillarSource>>;
}

function reject(code: ReleaseRejectionCode, detail: string, status = 400): ReleaseOutcome {
  return { status, response: { kind: 'rejected', code, detail } satisfies ReleaseRejection };
}

function asObject(body: unknown): Record<string, unknown> | null {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

function readString(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function portFor(deps: ReleaseHandlerDeps): ShadowExposurePort {
  return { configuration: deps.configuration, consent: deps.consent, resolvePilot: deps.resolvePilot };
}

export function handleReleaseRequest(deps: ReleaseHandlerDeps, body: unknown): ReleaseOutcome {
  const parsed = asObject(body);
  if (parsed === null) return reject('MALFORMED_REQUEST_BODY', 'the request body is not an object');

  const now = readString(parsed, 'now');
  if (now === null) return reject('MISSING_INSTANT', 'now is required; this module never reads a clock');
  if (!isInstant(now)) {
    return reject('MALFORMED_INSTANT', `now is not an ISO instant with an explicit offset: ${now}`);
  }

  const action = readString(parsed, 'action');
  const port = portFor(deps);

  /**
   * The participant-scoped actions read this. It is not a top-level requirement
   * because `cohort_exposure`, `study_summary` and `evidence_package` are about
   * the study rather than about a person, and demanding a participant id for
   * them would mean supplying an irrelevant one.
   */
  const participantId = readString(parsed, 'participantId');
  const requireParticipant = (): ReleaseOutcome | string =>
    participantId === null
      ? reject('MISSING_PARTICIPANT', 'participantId is required and must be a non-empty string')
      : participantId;
  const isRejection = (value: ReleaseOutcome | string): value is ReleaseOutcome => typeof value !== 'string';

  switch (action) {
    case 'consent_status': {
      const who = requireParticipant();
      if (isRejection(who)) return who;
      return {
        status: 200,
        response: {
          kind: 'consent',
          consent: deps.consent.read(who),
          exposure: resolveStagedExposure(port, who, now),
        },
      };
    }

    case 'grant_consent': {
      const who = requireParticipant();
      if (isRejection(who)) return who;
      const raw = parsed.scopes;
      if (!Array.isArray(raw) || raw.length === 0) {
        return reject('UNKNOWN_SCOPE', 'scopes is required and must be a non-empty array of study consent scopes');
      }
      const unknown = raw.filter((scope) => !(SHADOW_CONSENT_SCOPES as readonly unknown[]).includes(scope));
      if (unknown.length > 0) {
        return reject('UNKNOWN_SCOPE', `not a study consent scope: ${unknown.map((scope) => String(scope)).join(', ')}`);
      }
      const result = deps.consent.grant(who, raw as readonly ShadowConsentScope[], now);
      if (result.status === 'rejected') {
        return reject('CONSENT_REJECTED', `${result.reason}: ${result.detail}`);
      }
      return {
        status: 200,
        response: {
          kind: 'consent_written',
          consent: result.consent,
          exposure: resolveStagedExposure(port, who, now),
        },
      };
    }

    case 'revoke_consent': {
      const who = requireParticipant();
      if (isRejection(who)) return who;
      const result = deps.consent.revoke(who, now);
      if (result.status === 'rejected') {
        return reject('CONSENT_REJECTED', `${result.reason}: ${result.detail}`);
      }
      return {
        status: 200,
        response: {
          kind: 'consent_revoked',
          consent: result.consent,
          // Rebuilt in the same response: a withdrawn consent and a live
          // exposure cannot be shown side by side.
          exposure: resolveStagedExposure(port, who, now),
        },
      };
    }

    case 'exposure': {
      const who = requireParticipant();
      if (isRejection(who)) return who;
      return { status: 200, response: { kind: 'exposure', decision: resolveStagedExposure(port, who, now) } };
    }

    case 'cohort_exposure': {
      const decisions = resolveCohortExposure(port, now);
      return {
        status: 200,
        response: {
          kind: 'cohort_exposure',
          configuration: deps.configuration,
          // Reported beside the decisions rather than instead of them: a
          // misconfigured stage is something an operator has to see, and
          // refusing the whole read would hide who is currently exposed.
          configurationDefects: checkStageConfiguration(deps.configuration),
          decisions,
          tally: tallyExposure(deps.configuration, decisions),
        },
      };
    }

    case 'submit_response': {
      const who = requireParticipant();
      if (isRejection(who)) return who;
      // `respondedAt` is the request's `now`, never the body's. See the header.
      const parsedResponse = parseStudyResponse({ ...parsed, participantId: who }, now);
      if (parsedResponse.status === 'rejected') {
        return reject('RESPONSE_REJECTED', `${parsedResponse.reason}: ${parsedResponse.detail}`);
      }
      const stored = deps.responses.record(parsedResponse.response);
      if (stored.status === 'rejected') {
        return reject('RESPONSE_REJECTED', `${stored.reason}: ${stored.detail}`);
      }
      return {
        status: 200,
        response: { kind: 'response_recorded', response: stored.response, superseded: stored.superseded },
      };
    }

    case 'study_summary':
      return {
        status: 200,
        response: { kind: 'study_summary', summary: summarizeStudyResponses(deps.responses.listAll()) },
      };

    case 'evidence_package': {
      if (deps.evidenceSources === undefined) {
        return reject('NOT_WIRED', 'no evidence sources are wired in this build; a package cannot be assembled', 501);
      }
      const packageId = readString(parsed, 'packageId');
      const outcome = buildEvidencePackage({
        packageId: packageId ?? '',
        assembledAt: now,
        stage: deps.configuration.stage,
        sources: deps.evidenceSources(),
      });
      if (outcome.status === 'refused') {
        return reject('EVIDENCE_REFUSED', `${outcome.reason}: ${outcome.detail}`);
      }
      return {
        status: 200,
        response: {
          kind: 'evidence_package',
          package: outcome.package,
          defects: outcome.defects,
          unavailablePillars: outcome.unavailablePillars,
          rationale: outcome.rationale,
        },
      };
    }

    case 'delete': {
      const who = requireParticipant();
      if (isRejection(who)) return who;
      const outcome = deleteShadowStudyParticipant({
        participantId: who,
        now,
        consent: deps.consent,
        responses: deps.responses,
        traces: deps.traces,
        replayBundles: deps.replayBundles,
        deletePersonalization: deps.deletePersonalization,
      });
      if (outcome.status === 'refused') {
        return reject('DELETION_REFUSED', `${outcome.reason}: ${outcome.detail}`);
      }
      if (outcome.status === 'deleted_unproven') {
        // 200, not an error: the deletion happened. What did not happen is the
        // proof, and the client is told exactly which stores could not give one.
        return {
          status: 200,
          response: {
            kind: 'deleted_unproven',
            unprovable: outcome.unprovable,
            removed: outcome.removed,
            remainingConsentRecordCount: outcome.remainingConsentRecordCount,
            detail: outcome.detail,
          },
        };
      }
      return {
        status: 200,
        response: {
          kind: 'deleted',
          receipt: outcome.receipt,
          removed: outcome.removed,
          remainingConsentRecordCount: outcome.remainingConsentRecordCount,
        },
      };
    }

    default:
      return reject('UNKNOWN_ACTION', `not an action this endpoint offers: ${String(parsed.action)}`);
  }
}
