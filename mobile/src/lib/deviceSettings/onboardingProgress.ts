/**
 * Whether this person has finished onboarding (UC-2.R1, #171).
 *
 * ── The device copy is the step; the account says whether ────────
 *
 * This value is per install, and sign-out clears it (a shared phone must not
 * hand the next person a finished state). On its own that made the same
 * account replay every screen after signing out and back in (audit
 * 2026-10-03, #5). So a device with no progress now asks the account — see
 * `resolveOnboardingGate` at the bottom of this file — and an account that
 * has answered the consent screen opens straight into the app, on this phone
 * or a new one. A brand-new account has answered nothing and gets every
 * screen.
 *
 * ── Which step, not just whether ─────────────────────────────────
 *
 * The stored value is the step to resume on, so killing the app mid-survey
 * comes back to the survey rather than to the welcome screen (#171's manual
 * acceptance asks for exactly that).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export const ONBOARDING_STORAGE_KEY = 'onboarding.v1';

/** In order. `done` is the terminal value and means the app is reachable. */
export const ONBOARDING_STEPS = [
  'welcome',
  'consent',
  'routine',
  // The self-description (UC-2.7b, #168). After the routine survey, because it
  // asks for far more of somebody than five multiple-choice questions do, and
  // a person who has already answered something small is being asked for the
  // larger thing in context rather than cold.
  'about',
  'notifications',
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export type OnboardingProgress = OnboardingStep | 'done';

export function isOnboardingProgress(value: unknown): value is OnboardingProgress {
  return value === 'done' || (ONBOARDING_STEPS as readonly string[]).includes(value as string);
}

/**
 * Where to resume.
 *
 * An unreadable or unrecognised value resumes at `welcome`, never at `done`: a
 * corrupt byte must not be able to skip the consent screen. That is the whole
 * reason this function does not simply coerce.
 */
export async function loadOnboardingProgress(): Promise<OnboardingProgress> {
  try {
    const stored = await AsyncStorage.getItem(ONBOARDING_STORAGE_KEY);
    return isOnboardingProgress(stored) ? stored : 'welcome';
  } catch {
    return 'welcome';
  }
}

export async function saveOnboardingProgress(progress: OnboardingProgress): Promise<void> {
  try {
    await AsyncStorage.setItem(ONBOARDING_STORAGE_KEY, progress);
  } catch {
    // A progress marker that will not persist must not block the person from
    // using the app. They see the screens again next launch, which is
    // annoying and safe; being stuck on step one is neither.
  }
}

export async function clearOnboardingProgress(): Promise<void> {
  try {
    await AsyncStorage.removeItem(ONBOARDING_STORAGE_KEY);
  } catch {
    // See above.
  }
}

export function nextStep(step: OnboardingStep): OnboardingProgress {
  const index = ONBOARDING_STEPS.indexOf(step);
  return ONBOARDING_STEPS[index + 1] ?? 'done';
}

export function previousStep(step: OnboardingStep): OnboardingStep | null {
  const index = ONBOARDING_STEPS.indexOf(step);
  return index > 0 ? ONBOARDING_STEPS[index - 1]! : null;
}

/**
 * What the account itself says about onboarding (audit 2026-10-03, #5).
 *
 * The device bit above is cleared on sign-out, so on its own it made a person
 * who signed out and back in with the same account sit through every screen
 * again — consents included. The consent screen's answer is on the account
 * (`GET /api/mobile/consents`, `recommendations.asked`), survives sign-out and
 * reinstalls, and is written by exactly one screen: the onboarding consent
 * step, which records the recommendation question whether it was switched on
 * or left off. An account that has answered it has been onboarded.
 *
 * The steps after it — routine, about you, reminders — are all skippable and
 * all reachable again from Settings, so they are not a reason to replay the
 * consent screen for an account that has already answered it.
 */
export type AccountOnboardingSignal =
  /** The consents view arrived. */
  | { kind: 'answered'; consentAsked: boolean }
  /** Still asking. */
  | { kind: 'pending' }
  /** The server could not be reached. */
  | { kind: 'unreachable' };

/**
 * Whether the gate may open: `true` the app, `false` onboarding, `null` hold.
 *
 * Order matters. The device copy wins when it says anything more than "never
 * started": `done` opens the app, and a step mid-way resumes there (this
 * install, this account, no sign-out in between). Only a device that has no
 * progress — a fresh install, or one that was signed out — asks the account.
 * An unreachable server falls back to onboarding, never to the app: the
 * consent screen must not be skipped on a guess.
 */
export function resolveOnboardingGate(
  device: OnboardingProgress | null,
  account: AccountOnboardingSignal,
): boolean | null {
  if (device === null) return null;
  if (device === 'done') return true;
  if (device !== 'welcome') return false;
  if (account.kind === 'pending') return null;
  if (account.kind === 'unreachable') return false;
  return account.consentAsked;
}
