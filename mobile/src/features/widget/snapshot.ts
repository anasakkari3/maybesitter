/**
 * What the home-screen widget is allowed to know (UC-3.R1, #203).
 *
 * ── One pure function decides what leaves the app ────────────────
 *
 * The widget runs in another process — a WidgetKit extension on iOS, the
 * launcher on Android — and reads a JSON snapshot this app writes into shared
 * storage. The home screen and the lock screen are the two most public places
 * a phone has, so the rule is enforced **here, before the write**, not in the
 * widget: when titles are not allowed, the real title is replaced by the
 * "Private commitment" label and never reaches the App Group or the widget
 * store at all. A widget that received the title and chose not to draw it
 * would leave the title sitting in a plist anyone with a backup can read.
 *
 * ── The contract ─────────────────────────────────────────────────
 *
 * `schemaVersion: 1`, the shape the retired Flutter publisher wrote
 * (`archive/flutter-final`, `pilot_presence_snapshot_publisher.dart`), with
 * three changes that make the native sides dumb:
 *
 *  - `labels`, `locale` and `direction` travel in the snapshot. The widget is
 *    drawn in the language the *app* is in — which the user can set apart from
 *    the phone's — and in its direction, without a second copy of the strings.
 *  - Each item carries its `timeLabel` already formatted and its deep `link`,
 *    so Swift and the Android renderer neither format dates nor build URLs.
 *  - The next step (`GET /api/mobile/recommendations/next-step`) is the first
 *    item, flagged `isNextStep`, and the rest of the top three are the open
 *    items of Today in the Flutter publisher's order.
 *
 * `swift/Snapshot.swift` in `targets/widget/` decodes exactly this; keep the two
 * in step.
 */
import type { Commitment } from '../../api/schemas/common';
import { isRtl, type Locale } from '../../i18n/locale';
import { toViewModel, type Importance } from '../commitments/model';

/** Thirty minutes, as the Flutter publisher had it. After that the widget says "stale". */
export const SNAPSHOT_TTL_MS = 30 * 60 * 1000;

/** The most items a widget shows: the next step and two more. */
export const MAX_ITEMS = 3;

/** The key both native sides read. Versioned so a contract change is a new key. */
export const SNAPSHOT_KEY = 'maybesitter.widget.snapshot.v1';

/** The App Group the iOS app and its widget extension share. */
export const APP_GROUP = 'group.com.maybesitter.app';

/**
 * Where a snapshot is drawn.
 *
 * `widget` is the home screen, `lockScreen` the iOS accessory families.
 *
 * The opt-in allows **the home screen only**. The lock screen is readable by
 * anyone holding the phone without unlocking it, and a widget cannot tell
 * whether the phone is locked, so it never receives titles — not even from a
 * user who turned them on. On the home screen the Swift views are also marked
 * `.privacySensitive()`, so iOS hides them while the device is locked
 * (StandBy, an iPad home screen seen from the lock screen).
 */
export type WidgetSurface = 'widget' | 'lockScreen';

export const OPT_IN_SURFACES: readonly WidgetSurface[] = ['widget'];

export type WidgetLabels = {
  privateCommitment: string;
  nextStep: string;
  empty: string;
  capture: string;
  stale: string;
};

export type WidgetItem = {
  id: string;
  /** The real title only when allowed; otherwise `labels.privateCommitment`. */
  title: string;
  titleRedacted: boolean;
  redactionReason: 'titlesNotAllowed' | null;
  /** `null` when the next step is not in Today's list, so its importance is unknown. */
  priority: Importance | null;
  /** Already formatted in the app's language and zone, or null for no time. */
  timeLabel: string | null;
  dueAt: string | null;
  category: Commitment['category'];
  isNextStep: boolean;
  link: string;
};

export type WidgetSnapshot = {
  contract: 'commitmentSnapshot';
  schemaVersion: 1;
  generatedAt: string;
  expiresAt: string;
  surface: WidgetSurface;
  titlePrivacy:
    | { mode: 'neverIncludeTitles'; allowedSurfaceIds: [] }
    | { mode: 'allowedSurfacesOnly'; allowedSurfaceIds: WidgetSurface[] };
  locale: Locale;
  direction: 'rtl' | 'ltr';
  labels: WidgetLabels;
  links: { capture: string; today: string };
  items: WidgetItem[];
};

export type SnapshotInput = {
  /** Today's commitments as the list endpoint returned them. */
  today: readonly Commitment[];
  /** `recommendation.primaryStep`, or null when there is none. */
  nextStep: { commitmentId: string; title: string } | null;
  /** The user's "Show titles on the home screen widget" answer. */
  titlesAllowed: boolean;
  surface: WidgetSurface;
  locale: Locale;
  labels: WidgetLabels;
  now: Date;
  /** Injected so this stays pure and Jest need not know the device's Intl. */
  formatTime: (date: Date) => string;
};

/**
 * The same id shape `links.ts` accepts. An item whose id the router would drop
 * is left out rather than written with a link that opens nothing.
 */
const LINKABLE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export const widgetLinks = {
  commitment: (id: string) => `maybesitter://commitments/${id}`,
  capture: 'maybesitter://capture?source=widget&input=voice',
  today: 'maybesitter://today',
} as const;

const IMPORTANCE_ORDER: Record<Importance, number> = { must: 0, should: 1, nice: 2 };

function compareOpen(a: Commitment, b: Commitment, now: string): number {
  const va = toViewModel(a, now);
  const vb = toViewModel(b, now);
  const byImportance = IMPORTANCE_ORDER[va.importance] - IMPORTANCE_ORDER[vb.importance];
  if (byImportance !== 0) return byImportance;
  // Timed before untimed, then earliest first.
  const ta = va.shownAt ? Date.parse(va.shownAt) : Number.POSITIVE_INFINITY;
  const tb = vb.shownAt ? Date.parse(vb.shownAt) : Number.POSITIVE_INFINITY;
  if (ta !== tb) return ta < tb ? -1 : 1;
  // Code-unit order, not `localeCompare`: the widget's order must not depend
  // on which Intl the device's engine ships.
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  return 0;
}

export function buildSnapshot(input: SnapshotInput): WidgetSnapshot {
  const { labels, now, surface } = input;
  const nowIso = now.toISOString();
  // The one line the privacy rule turns on. Both conditions: the user opted
  // in, *and* this surface is one the opt-in covers.
  const showTitles = input.titlesAllowed && OPT_IN_SURFACES.includes(surface);

  const open = input.today.filter((c) => toViewModel(c, nowIso).status === 'active' && LINKABLE_ID.test(c.id));
  const sorted = [...open].sort((a, b) => compareOpen(a, b, nowIso));

  const itemFor = (commitment: Commitment | null, id: string, realTitle: string, isNextStep: boolean): WidgetItem => {
    const view = commitment ? toViewModel(commitment, nowIso) : null;
    const allDay = commitment?.timeSpec.allDay === true;
    const shownAt = view?.shownAt ?? null;
    return {
      id,
      title: showTitles ? realTitle : labels.privateCommitment,
      titleRedacted: !showTitles,
      redactionReason: showTitles ? null : 'titlesNotAllowed',
      priority: view?.importance ?? null,
      timeLabel: shownAt && !allDay ? input.formatTime(new Date(shownAt)) : null,
      dueAt: shownAt,
      category: commitment?.category ?? null,
      isNextStep,
      link: widgetLinks.commitment(id),
    };
  };

  const items: WidgetItem[] = [];
  const step = input.nextStep;
  if (step && LINKABLE_ID.test(step.commitmentId)) {
    const inToday = open.find((c) => c.id === step.commitmentId) ?? null;
    items.push(itemFor(inToday, step.commitmentId, step.title, true));
  }
  for (const commitment of sorted) {
    if (items.length >= MAX_ITEMS) break;
    if (items.some((item) => item.id === commitment.id)) continue;
    items.push(itemFor(commitment, commitment.id, commitment.title, false));
  }

  return {
    contract: 'commitmentSnapshot',
    schemaVersion: 1,
    generatedAt: nowIso,
    expiresAt: new Date(now.getTime() + SNAPSHOT_TTL_MS).toISOString(),
    surface,
    titlePrivacy: showTitles
      ? { mode: 'allowedSurfacesOnly', allowedSurfaceIds: [...OPT_IN_SURFACES] }
      : { mode: 'neverIncludeTitles', allowedSurfaceIds: [] },
    locale: input.locale,
    direction: isRtl(input.locale) ? 'rtl' : 'ltr',
    labels,
    links: { capture: widgetLinks.capture, today: widgetLinks.today },
    items,
  };
}

export type WidgetDisplayState = 'loading' | 'empty' | 'stale' | 'populated';

/**
 * What the widget draws. The Swift side implements the same four states in
 * `WidgetDisplayState`; this one is what the Android renderer uses.
 */
export function displayStateOf(snapshot: WidgetSnapshot | null, now: Date): WidgetDisplayState {
  if (!snapshot || snapshot.contract !== 'commitmentSnapshot' || snapshot.schemaVersion !== 1) return 'loading';
  const expires = Date.parse(snapshot.expiresAt);
  if (Number.isNaN(expires) || now.getTime() >= expires) return 'stale';
  return snapshot.items.length === 0 ? 'empty' : 'populated';
}

/** Parses what a store handed back. Anything unreadable is "no snapshot". */
export function parseSnapshot(raw: string | null): WidgetSnapshot | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const snapshot = value as WidgetSnapshot;
    if (snapshot.contract !== 'commitmentSnapshot' || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.items)) {
      return null;
    }
    return snapshot;
  } catch {
    return null;
  }
}
