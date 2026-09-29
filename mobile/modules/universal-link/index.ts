/**
 * The native "open only in an installed app" check (closure CL2b, #21), or null.
 *
 * iOS only: `UIApplication.open(url, options: [.universalLinksOnly: true])`,
 * resolving whether an app opened the link. Android App Links already choose
 * between the installed app and the browser, so there is no Android half.
 *
 * `requireOptionalNativeModule`, like `exact-alarm`: a build without this
 * module — Expo Go, a unit test, a dev client from before it existed — must
 * still start. What a missing answer means is decided in
 * `src/features/aiImport/openAssistant.ts`.
 */
import { requireOptionalNativeModule } from 'expo';

export interface UniversalLinkNativeModule {
  /** Resolves true only when an installed app claimed and opened the link. */
  openUniversalLink(url: string): Promise<boolean>;
}

export function universalLinkNativeModule(): UniversalLinkNativeModule | null {
  return requireOptionalNativeModule<UniversalLinkNativeModule>('UniversalLink');
}
