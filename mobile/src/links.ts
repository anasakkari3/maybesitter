import { useEffect } from 'react';
import { Linking } from 'react-native';
import type { Lang } from './i18n/strings';
import type { ThemePref } from './state/types';

/**
 * Deep links (UC-2.R3, #173).
 *
 *   maybesitter://capture?source=widget&input=voice
 *                                          the capture flow, with how it was
 *                                          entered (UC-2.R2, #172)
 *   maybesitter://today                    a tab or screen by name
 *   maybesitter://commitments/<id>         one commitment
 *   maybesitter://item/<id>                the same, the widget's older spelling
 *   maybesitter://next                     the next-step card, which lives on Today
 *
 * plus `?lang=` and `?theme=` on any of them. In Expo Go the same path arrives
 * as exp://host:port/--/<path>.
 *
 * ── A link is untrusted input ────────────────────────────────────
 *
 * Any app or web page on the device can fire one of these, and the id in it is
 * about to be interpolated into an API path. `encodeURIComponent` in the
 * endpoint stops a traversal from changing the route, but a link is still the
 * one place a stranger chooses a string this app then acts on — so the id is
 * validated against a shape here and the link is dropped, not repaired, when
 * it does not match. Repairing an id would be guessing which commitment a
 * stranger meant.
 */
export type CaptureLinkSource = 'tab' | 'widget' | 'share' | 'notification';
export type CaptureLinkInput = 'text' | 'voice';

export type LinkTarget =
  | { kind: 'screen'; name: string }
  | { kind: 'commitment'; id: string }
  | { kind: 'nextStep' }
  /**
   * Capture, and how it was reached.
   *
   * `source` is recorded rather than assumed `tab`, because a widget or a share
   * sheet is a different entry and #172 asks the flow to know which. Both
   * values are validated against their enums: a link is untrusted input, and
   * `source=<script>` must be an unrecognised link rather than a stored string.
   */
  | { kind: 'capture'; source: CaptureLinkSource; input: CaptureLinkInput };

export interface ParsedLink {
  target: LinkTarget;
  lang?: Lang;
  theme?: ThemePref;
}

/**
 * What a commitment id may look like.
 *
 * Deliberately the same shape as `USER_ID_PATTERN` in `lib/storage/paths.ts`,
 * which is what the storage layer already accepts as a document id — ids are
 * `randomUUID()`, so this is wider than it needs to be, and matching the
 * server's rule is better than inventing a second one that can disagree with
 * it later. No slashes, no dots, no percent signs, and bounded, so a link
 * cannot hand the client an unbounded string to put in a URL.
 */
const COMMITMENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Only these names route by name; anything else is not a screen. */
function screenTarget(name: string): LinkTarget | null {
  return name.length > 0 && /^[a-z][a-zA-Z0-9]{0,32}$/.test(name)
    ? { kind: 'screen', name }
    : null;
}

export function parseLink(url: string): ParsedLink | null {
  const afterScheme = url.includes('/--/') ? url.split('/--/')[1] : url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  if (afterScheme == null) return null;
  const [rawPath = '', query = ''] = afterScheme.split('?');
  const path = rawPath.replace(/^\/+|\/+$/g, '');
  const segments = path.split('/').filter(segment => segment.length > 0);

  const params = new URLSearchParams(query);
  const target = targetFor(segments, params);
  if (!target) return null;

  const lang = params.get('lang');
  const theme = params.get('theme');
  // The keys are left out entirely when the link doesn't carry them, rather
  // than set to undefined, so a link never overwrites a stored preference.
  const link: ParsedLink = { target };
  if (lang === 'ar' || lang === 'en') link.lang = lang;
  if (theme === 'system' || theme === 'light' || theme === 'dark') link.theme = theme;
  return link;
}

const CAPTURE_SOURCES: readonly string[] = ['tab', 'widget', 'share', 'notification'];
const CAPTURE_INPUTS: readonly string[] = ['text', 'voice'];

function targetFor(segments: string[], params: URLSearchParams): LinkTarget | null {
  if (segments.length === 0) return { kind: 'screen', name: 'today' };

  const [first, second] = segments;
  if (first === 'capture') {
    if (segments.length !== 1) return null;
    const source = params.get('source');
    const input = params.get('input');
    return {
      kind: 'capture',
      // An unrecognised value falls back rather than refusing the link: the
      // user asked to capture something, and losing that over an analytics
      // parameter would be the wrong trade.
      source: (source && CAPTURE_SOURCES.includes(source) ? source : 'tab') as CaptureLinkSource,
      input: (input && CAPTURE_INPUTS.includes(input) ? input : 'text') as CaptureLinkInput,
    };
  }
  if (first === 'commitments' || first === 'item') {
    // Exactly two segments. `commitments/a/b` is not a commitment id with a
    // slash in it; it is a link this app does not understand.
    if (segments.length !== 2 || !second || !COMMITMENT_ID.test(second)) return null;
    return { kind: 'commitment', id: second };
  }
  if (segments.length !== 1) return null;
  // The widget's own name for "open whatever I should do now".
  if (first === 'next') return { kind: 'nextStep' };
  return screenTarget(first!);
}

export function useLinks(
  handlers: {
    jump: (name: string) => void;
    openCommitment: (id: string) => void;
    openNextStep: () => void;
    openCapture: (source: CaptureLinkSource, input: CaptureLinkInput) => void;
    setLang: (l: Lang) => void;
    setThemePref: (t: ThemePref) => void;
  },
  /**
   * A link that arrived while the sign-in gate was up, handed over exactly
   * once (UC-1.7 #151). `Linking.getInitialURL()` cannot see it: the app was
   * already running when it came in, and this hook mounts only after sign-in.
   */
  takePendingLink?: () => string | null,
) {
  useEffect(() => {
    const apply = (url: string | null) => {
      if (!url) return;
      const link = parseLink(url);
      if (!link) return;
      if (link.lang) handlers.setLang(link.lang);
      if (link.theme) handlers.setThemePref(link.theme);
      if (link.target.kind === 'commitment') handlers.openCommitment(link.target.id);
      else if (link.target.kind === 'nextStep') handlers.openNextStep();
      else if (link.target.kind === 'capture') handlers.openCapture(link.target.source, link.target.input);
      else handlers.jump(link.target.name);
    };
    const pending = takePendingLink?.() ?? null;
    if (pending) apply(pending);
    else Linking.getInitialURL().then(apply).catch(() => {});
    const sub = Linking.addEventListener('url', e => apply(e.url));
    return () => sub.remove();
    // handlers are recreated each render; the subscription only needs to exist once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
