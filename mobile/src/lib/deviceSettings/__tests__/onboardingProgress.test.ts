/**
 * Where onboarding resumes (UC-2.R1, #171).
 *
 * The one that matters: an unreadable or unrecognised stored value must resume
 * at `welcome`, never at `done`. A corrupt byte must not be able to skip the
 * consent screen.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ONBOARDING_STEPS,
  ONBOARDING_STORAGE_KEY,
  clearOnboardingProgress,
  isOnboardingProgress,
  loadOnboardingProgress,
  nextStep,
  previousStep,
  saveOnboardingProgress,
} from '../../../lib/deviceSettings/onboardingProgress';

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.restoreAllMocks();
});

describe('resuming', () => {
  it('starts at welcome when nothing is stored', async () => {
    expect(await loadOnboardingProgress()).toBe('welcome');
  });

  it('comes back to the step it was left on', async () => {
    await saveOnboardingProgress('routine');
    expect(await loadOnboardingProgress()).toBe('routine');
  });

  it('reports done once onboarding finished', async () => {
    await saveOnboardingProgress('done');
    expect(await loadOnboardingProgress()).toBe('done');
  });
});

describe('a stored value this build does not recognise', () => {
  it('resumes at welcome rather than skipping to done', async () => {
    await AsyncStorage.setItem(ONBOARDING_STORAGE_KEY, 'completed');
    expect(await loadOnboardingProgress()).toBe('welcome');
  });

  it('resumes at welcome when storage cannot be read', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('unreadable'));
    expect(await loadOnboardingProgress()).toBe('welcome');
  });

  it('recognises exactly the steps and done', () => {
    for (const step of ONBOARDING_STEPS) expect(isOnboardingProgress(step)).toBe(true);
    expect(isOnboardingProgress('done')).toBe(true);
    expect(isOnboardingProgress('finished')).toBe(false);
    expect(isOnboardingProgress(null)).toBe(false);
    expect(isOnboardingProgress(1)).toBe(false);
  });
});

describe('storage that will not co-operate', () => {
  it('does not throw when the step cannot be saved', async () => {
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk full'));
    await expect(saveOnboardingProgress('consent')).resolves.toBeUndefined();
  });

  it('does not throw when it cannot be cleared', async () => {
    jest.spyOn(AsyncStorage, 'removeItem').mockRejectedValueOnce(new Error('locked'));
    await expect(clearOnboardingProgress()).resolves.toBeUndefined();
  });
});

describe('the order of the steps', () => {
  it('runs welcome → consent → routine → notifications → done', () => {
    expect(nextStep('welcome')).toBe('consent');
    expect(nextStep('consent')).toBe('routine');
    expect(nextStep('routine')).toBe('notifications');
    expect(nextStep('notifications')).toBe('done');
  });

  it('goes back everywhere except the first step', () => {
    expect(previousStep('welcome')).toBeNull();
    expect(previousStep('consent')).toBe('welcome');
    expect(previousStep('notifications')).toBe('routine');
  });

  it('puts consent before anything the product does', () => {
    // If the consent screen ever stops being the second step, somebody could
    // reach the survey — which syncs to the account — before being asked.
    expect(ONBOARDING_STEPS.indexOf('consent')).toBeLessThan(ONBOARDING_STEPS.indexOf('routine'));
  });
});
