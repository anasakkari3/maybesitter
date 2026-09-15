/**
 * Why a fact is on the screen, in words (UC-3.16, #202).
 *
 * The server decides the *classification* — `sourceLabel` needs both `source`
 * and `provenance` and is computed once, in `lib/services/mobile/memoryService.ts`.
 * This module decides the *wording*, because the words are the app's and exist
 * in three languages. Nothing here re-derives a classification; it maps.
 *
 * ── Confidence is banded here, not on the server ─────────────────
 *
 * The record carries a number. #202 asks the screen never to show it, and a
 * number is worse than imprecise here — "0.62 sure that you focus in the
 * morning" invites the reader to treat a threshold as a measurement. The band
 * is a presentation decision, so it lives with the presentation, and the
 * boundaries are constants a reader can check rather than a formula.
 *
 * ── Staleness is two different sentences ─────────────────────────
 *
 * A user-stated fact gets a ten-year TTL, which is the store's way of writing
 * "until you change it" (`USER_STATED_MEMORY_TTL_MS`). Printing a date in 2036
 * would be technically true and would tell the reader nothing except that we
 * intend to keep it forever, phrased alarmingly. Anything shorter is an
 * inference with a real expiry, and that date is a thing about their own data
 * the user is owed. So the two are worded apart, on the TTL, not on `source`:
 * the boundary that matters is how long it is kept, whoever said it.
 */
import type { MemoryItem, MemorySourceLabel } from '../../api/schemas/profile';

/** The i18n key for each label the server can send. */
export const SOURCE_LABEL_STRING: Record<MemorySourceLabel, string> = {
  you_told_us: 'memorySourceYouTold',
  you_answered_onboarding: 'memorySourceOnboarding',
  noticed_from_confirmed: 'memorySourceNoticed',
  model_suggested_you_confirmed: 'memorySourceAiConfirmed',
  model_suggested: 'memorySourceAi',
};

/**
 * The three groups the list is cut into.
 *
 * By who asserted the fact, not by kind: a user reading this screen is asking
 * "which of these did I say and which did you decide?", and a heading that
 * split goals from preferences would answer a question nobody asked.
 */
export type MemoryGroup = 'told' | 'noticed' | 'suggested';

export const GROUP_STRING: Record<MemoryGroup, string> = {
  told: 'memoryGroupTold',
  noticed: 'memoryGroupNoticed',
  suggested: 'memoryGroupSuggested',
};

export const MEMORY_GROUP_ORDER: readonly MemoryGroup[] = ['told', 'noticed', 'suggested'];

export function groupOf(item: Pick<MemoryItem, 'sourceLabel'>): MemoryGroup {
  switch (item.sourceLabel) {
    case 'noticed_from_confirmed': return 'noticed';
    case 'model_suggested':
    case 'model_suggested_you_confirmed': return 'suggested';
    default: return 'told';
  }
}

export type ConfidenceBand = 'certain' | 'fairly_sure' | 'not_sure_yet';

/** At or above this, a guess is "fairly sure". Below it, it is not. */
export const FAIRLY_SURE_AT = 0.6;

export function confidenceBand(confidence: number): ConfidenceBand {
  if (!Number.isFinite(confidence)) return 'not_sure_yet';
  if (confidence >= 1) return 'certain';
  return confidence >= FAIRLY_SURE_AT ? 'fairly_sure' : 'not_sure_yet';
}

export const CONFIDENCE_STRING: Record<ConfidenceBand, string> = {
  certain: 'memorySureCertain',
  fairly_sure: 'memorySureFairly',
  not_sure_yet: 'memorySureNot',
};

/**
 * A fact kept "until you change it" rather than until a date.
 *
 * Five years is far outside any inference TTL (90 days) and far inside the
 * user-stated one (ten years), so it separates the two without either side
 * having to know the other's constant.
 */
const KEPT_INDEFINITELY_MS = 5 * 365 * 24 * 60 * 60 * 1_000;

export function keptIndefinitely(item: Pick<MemoryItem, 'staleAfter' | 'createdAt'>): boolean {
  const span = Date.parse(item.staleAfter) - Date.parse(item.createdAt);
  return Number.isFinite(span) && span >= KEPT_INDEFINITELY_MS;
}

export const ORIGIN_STRING: Record<NonNullable<MemoryItem['evidence']['origin']>, string> = {
  routine_survey: 'memoryOriginSurvey',
  self_description: 'memoryOriginDescription',
  manual: 'memoryOriginManual',
  capture: 'memoryOriginCapture',
};

export interface EvidenceLine {
  /** Stable across languages, so a test can name a line without quoting copy. */
  key: 'origin' | 'recorded' | 'observed' | 'confirmed' | 'edited' | 'observations' | 'stale';
  text: string;
}

export interface EvidenceCopy {
  strings: Record<string, string>;
  /** Formats an ISO instant as a date in the reader's locale and zone. */
  date: (iso: string) => string;
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
}

/**
 * The "Why?" answer for one fact, as lines.
 *
 * Only lines that say something are produced. A `confirmedAt` equal to the
 * moment the record was written adds nothing — the user typed it and it was
 * stored, which `recorded` already says — so it is dropped rather than
 * printed twice in different words.
 */
export function evidenceLines(item: MemoryItem, copy: EvidenceCopy): EvidenceLine[] {
  const { strings, date } = copy;
  const lines: EvidenceLine[] = [];
  const origin = item.evidence.origin;

  if (origin) lines.push({ key: 'origin', text: strings[ORIGIN_STRING[origin]] ?? '' });

  lines.push({
    key: 'recorded',
    text: fill(strings.memoryWhyRecorded ?? '', { date: date(item.evidence.recordedAt) }),
  });

  if (item.evidence.observedAt !== item.evidence.recordedAt) {
    lines.push({
      key: 'observed',
      text: fill(strings.memoryWhyObserved ?? '', { date: date(item.evidence.observedAt) }),
    });
  }

  if (item.evidence.confirmedAt && item.evidence.confirmedAt !== item.evidence.recordedAt) {
    lines.push({
      key: 'confirmed',
      text: fill(strings.memoryWhyConfirmed ?? '', { date: date(item.evidence.confirmedAt) }),
    });
  }

  if (item.evidence.edited) lines.push({ key: 'edited', text: strings.memoryWhyEdited ?? '' });

  lines.push({
    key: 'observations',
    text: item.evidence.observationCount === 0
      ? (strings.memoryWhyNoObservations ?? '')
      : fill(strings.memoryWhyObservations ?? '', { count: String(item.evidence.observationCount) }),
  });

  lines.push({
    key: 'stale',
    text: keptIndefinitely(item)
      ? (strings.memoryKeptUntilChanged ?? '')
      : fill(strings.memoryKeptUntil ?? '', { date: date(item.staleAfter) }),
  });

  return lines.filter(line => line.text !== '');
}
