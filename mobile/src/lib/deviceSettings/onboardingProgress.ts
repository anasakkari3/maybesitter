/**
 * Whether this person has finished onboarding (UC-2.R1, #171).
 *
 * ── One bit, on the device, on purpose ───────────────────────────
 *
 * Not on the account. Onboarding explains what the app does and asks what it
 * may use; the *answers* are on the account (consents, routine), and those are
 * the parts that must follow the person to a new phone. Whether they have seen
 * the explanation is a fact about this install.
 *
 * The consequence is deliberate: a second device runs onboarding again, and
 * the consent screen there shows the answers already on the account rather
 * than asking afresh. That is the right trade — re-showing three sentences
 * costs a person ten seconds, and skipping the screens on a device that has
 * never asked would leave somebody with no idea what they had agreed to.
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
export const ONBOARDING_STEPS = ['welcome', 'consent', 'routine', 'notifications'] as const;
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
