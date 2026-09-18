/**
 * The probes, one per provider read this repository can already normalize.
 *
 * Each probe is a thin binding: take what the provider returned, hand it to
 * the *production* normalizer, report how many records came out. No probe
 * parses a provider payload itself, because a second parser is a second
 * opinion, and the day the two disagree the verification is worth nothing.
 *
 * So a probe fails in exactly one way: the production adapter threw. That is
 * the signal — the response no longer satisfies the contract the rest of the
 * product reads.
 *
 * ── Why every probe skips today ──────────────────────────────────
 *
 * A probe needs a `ProviderReadPort`. This repository contains no
 * implementation of one, for any provider: the adapters on main are
 * normalizers behind ports (`GmailApiPort`, `MeetingTranscriptPort`,
 * `ProviderOAuthClient`, `ProviderCredentialVault`) whose only implementations
 * are test doubles. There is no HTTP client, no OAuth code exchange, no
 * credential storage and no provider SDK anywhere in the dependency tree.
 *
 * That is why the catalog registers no ports. Every probe reports
 * `SKIPPED_UNSUPPORTED_LIVE_PROBE` until someone supplies one, and a provider
 * stays "live verification ready", not "verified live". Wiring a port is the
 * one thing left, and it is deliberately the caller's to write so that the
 * production transport and the verified transport are the same object.
 */
import {
  normalizeGmailMessage,
  type GmailHistoryPage,
} from '../integrations/gmail/adapter';
import {
  normalizeMicrosoftBusyContext,
  normalizeMicrosoftMail,
  type MicrosoftCalendarPayload,
  type MicrosoftMailPayload,
} from '../integrations/microsoftGraph/adapter';
import { normalizeRescueTimeAggregate } from '../integrations/rescuetime/adapter';
import { normalizeMeetingTranscript, type MeetingTranscriptPayload } from '../integrations/meetings/meetingIntelligence';
import type { ProbeContext, ProbeNormalization, ProviderProbe } from './liveProviderVerification';

/** A bounded sample. Verification proves a shape, it does not pull a mailbox. */
const SAMPLE_LIMIT = 5;

function records(count: number): ProbeNormalization {
  return { recordCount: count };
}

function asObject(raw: unknown, what: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError(`${what} must be an object`);
  }
  return raw as Record<string, unknown>;
}

function asArray(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${what} must be an array`);
  return value;
}

/**
 * Gmail: a bounded history page.
 *
 * Every message goes through `normalizeGmailMessage`, which is also what
 * applies the untrusted-content boundary — so this checks the safety boundary
 * survives a real message, not only the field names. Bodies are normalized and
 * dropped; only the count is kept.
 */
const gmailMessages: ProviderProbe = {
  provider: 'google',
  operation: 'gmail.history.list',
  credentialEnvVars: ['MAYBESITTER_LIVE_GOOGLE_ACCESS_TOKEN'],
  readOnly: true,
  limit: SAMPLE_LIMIT,
  normalize(raw: unknown, context: ProbeContext): ProbeNormalization {
    const page = asObject(raw, 'Gmail history page') as unknown as GmailHistoryPage;
    const messages = asArray(page.messages, 'Gmail history page messages');
    for (const message of messages) {
      normalizeGmailMessage(message as GmailHistoryPage['messages'][number], context.connectionId, context.now);
    }
    return records(messages.length);
  },
};

/** Microsoft Graph: bounded mail metadata. */
const graphMail: ProviderProbe = {
  provider: 'microsoft',
  operation: 'graph.mail.list',
  credentialEnvVars: ['MAYBESITTER_LIVE_MICROSOFT_ACCESS_TOKEN'],
  readOnly: true,
  limit: SAMPLE_LIMIT,
  normalize(raw: unknown, context: ProbeContext): ProbeNormalization {
    const items = asArray(asObject(raw, 'Graph mail response').value, 'Graph mail value');
    for (const item of items) {
      normalizeMicrosoftMail(item as MicrosoftMailPayload, context.connectionId, context.now);
    }
    return records(items.length);
  },
};

/**
 * Microsoft Graph: bounded calendar metadata, normalized to busy blocks.
 *
 * The busy projection is the one the planner consumes, so this is the shape
 * that matters rather than the raw event.
 */
const graphCalendar: ProviderProbe = {
  provider: 'microsoft',
  operation: 'graph.calendar.list',
  credentialEnvVars: ['MAYBESITTER_LIVE_MICROSOFT_ACCESS_TOKEN'],
  readOnly: true,
  limit: SAMPLE_LIMIT,
  normalize(raw: unknown, context: ProbeContext): ProbeNormalization {
    const items = asArray(asObject(raw, 'Graph calendar response').value, 'Graph calendar value');
    for (const item of items) {
      normalizeMicrosoftBusyContext(item as MicrosoftCalendarPayload, context.connectionId, context.now);
    }
    return records(items.length);
  },
};

/**
 * RescueTime: one aggregate window.
 *
 * `normalizeRescueTimeAggregate` parses before it normalizes, so a shape
 * change surfaces here rather than as a silently wrong focus context.
 */
const rescueTimeAggregate: ProviderProbe = {
  provider: 'rescuetime',
  operation: 'rescuetime.aggregate.read',
  credentialEnvVars: ['MAYBESITTER_LIVE_RESCUETIME_API_KEY'],
  readOnly: true,
  limit: 1,
  normalize(raw: unknown, context: ProbeContext): ProbeNormalization {
    normalizeRescueTimeAggregate(
      raw as Parameters<typeof normalizeRescueTimeAggregate>[0],
      context.connectionId,
      context.now,
    );
    return records(1);
  },
};

/**
 * Meeting provider: transcript metadata for one meeting.
 *
 * Read-only and bounded. `normalizeMeetingTranscript` applies the untrusted
 * boundary; segment text is normalized and discarded, never reported.
 */
const meetingTranscript: ProviderProbe = {
  provider: 'meeting',
  operation: 'meeting.transcript.read',
  credentialEnvVars: ['MAYBESITTER_LIVE_MEETING_ACCESS_TOKEN'],
  readOnly: true,
  limit: 1,
  normalize(raw: unknown): ProbeNormalization {
    const payload = asObject(raw, 'meeting transcript') as unknown as MeetingTranscriptPayload;
    // The normalized context carries the transcript as one string, so the
    // count comes from the input segments. A count, never the text.
    normalizeMeetingTranscript(payload);
    return records(asArray(payload.segments, 'meeting transcript segments').length);
  },
};

/**
 * Every probe this repository can define today.
 *
 * Todoist, Notion and WHOOP are absent on purpose, and
 * `PROVIDERS_WITHOUT_LIVE_PROBES` says why for each.
 */
export const PROVIDER_PROBES: readonly ProviderProbe[] = Object.freeze([
  gmailMessages,
  graphMail,
  graphCalendar,
  rescueTimeAggregate,
  meetingTranscript,
]);

/**
 * Providers this harness cannot honestly cover, and the reason.
 *
 * Kept next to the probes so the gap is as visible as the coverage.
 */
export const PROVIDERS_WITHOUT_LIVE_PROBES: ReadonlyArray<{
  readonly provider: string;
  readonly reason: string;
}> = Object.freeze([
  {
    provider: 'todoist',
    reason:
      'normalizeTodoistSyncPage needs an IntegrationConnectionRecord, which only exists once a real connection has been stored. There is no connection registry implementation to store one, so a probe would have to fabricate the record and would then be verifying its own fixture.',
  },
  {
    provider: 'notion',
    reason:
      'normalizeSelectedNotionTask needs both a connection record and an explicit NotionSelection. Without a stored selection a probe would either crawl the workspace, which the policy forbids, or invent a selection and verify nothing real.',
  },
  {
    provider: 'whoop',
    reason:
      'lib/integrations/whoop/backend.ts is token-lifecycle and sync-planning only. It exposes no response normalizer, so there is no contract for a live response to be validated against.',
  },
  {
    provider: 'revenuecat',
    reason:
      'Entitlement projection is server-side and could be probed, but the thing that actually needs verifying is the StoreKit and Play Billing purchase flow. A server HTTP read cannot stand in for that, and claiming it does would be the false green this harness exists to avoid.',
  },
  {
    provider: 'healthkit / health-connect',
    reason: 'Device and native verification lanes. Out of scope for an HTTP harness by construction.',
  },
]);
