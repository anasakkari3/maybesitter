/**
 * The assistants a user can bring context from, and where to send them.
 *
 * ── Two URLs: the app's, and the web chat ────────────────────────
 *
 * `appUrl` is a path the vendor's app claims, so a universal link hands it to
 * the installed app. `webUrl` is where the chat itself lives on the web. They
 * differ because an app path is not a chat page: without the ChatGPT app,
 * `https://chatgpt.com/app` answers 302 → apps.apple.com (checked with curl,
 * 2026-09-26), and somebody who wanted to paste a question lands in the App
 * Store (closure CL2b, #21). `openAssistant.ts` therefore tries `appUrl` only
 * through iOS's `universalLinksOnly` check — which opens nothing when no app
 * claims it — and opens `webUrl` otherwise. Android App Links already choose
 * between app and browser, so Android opens `webUrl` directly.
 *
 * ── https, and no scheme detection ───────────────────────────────
 *
 * The alternative to universal links —
 * `canOpenURL` against `chatgpt://` and friends — needs three competitors'
 * schemes declared in `LSApplicationQueriesSchemes` and an Android `<queries>`
 * block, which is a store-review change that buys nothing the OS is not already
 * doing.
 *
 * ── Each URL is one the vendor's app claims ───────────────────────
 *
 * A universal link reaches the installed app only if the path is listed in the
 * vendor's apple-app-site-association file; anything else opens Safari. Checked
 * against those files on 2026-09-25:
 *   - claude.ai claims `/new` — kept.
 *   - chatgpt.com does NOT claim `/`, but claims `/app` — so `/app`, not `/`.
 *   - gemini.google.com claims only its download paths; `/app` is kept and
 *     opens the web app, which is the best on offer.
 * Re-check these files before changing a URL; the in-app browser fallback in
 * `openAssistant.ts` can never open an app, so a wrong path here means the web.
 *
 * `other` has no URL on purpose. Somebody using an assistant we have not named
 * can still copy the question and paste the answer back, which is the part of
 * this flow that actually carries the value.
 */
import type { Strings } from '../../i18n/strings';

export type ImportAssistant = 'chatgpt' | 'gemini' | 'claude' | 'other';

export const IMPORT_ASSISTANTS: readonly ImportAssistant[] = ['chatgpt', 'gemini', 'claude', 'other'];

export interface AssistantDescriptor {
  /** The universal link the vendor's app claims; tried only where the OS can say "no app". */
  readonly appUrl: string | null;
  /** The web chat. `null` means there is nothing to open. */
  readonly webUrl: string | null;
  readonly labelKey: keyof Strings;
}

export const ASSISTANTS: Record<ImportAssistant, AssistantDescriptor> = {
  chatgpt: { appUrl: 'https://chatgpt.com/app', webUrl: 'https://chatgpt.com/', labelKey: 'aiImportAssistantChatgpt' },
  gemini: { appUrl: 'https://gemini.google.com/app', webUrl: 'https://gemini.google.com/app', labelKey: 'aiImportAssistantGemini' },
  claude: { appUrl: 'https://claude.ai/new', webUrl: 'https://claude.ai/new', labelKey: 'aiImportAssistantClaude' },
  other: { appUrl: null, webUrl: null, labelKey: 'aiImportAssistantOther' },
};
