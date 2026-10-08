/**
 * `goal_invalid` and `seed_invalid` have their own words and a recovery that
 * takes out only that family (M3b). Inspection M3B-A-005: both fell back to the
 * legacy title-and-time sentence, with nothing to do about it.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { AccessibilityInfo, Platform } from 'react-native';
import { screen } from '@testing-library/react-native';
import en from '../../../i18n/locales/en.json';
import {
  defaultReply, lastRequest, openCards, openGenericCapture, prepareM3b, press, say, teardown, waitForRequest, withKinds, type M3bHarness,
} from '../../../__acceptance__/m3b/harness';
import { answer, mixedConfirmation, mixedProposal } from '../../../__acceptance__/m3b/fixtures';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'UTC' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

let harness: M3bHarness;
beforeEach(async () => { harness = await prepareM3b(); });
afterEach(async () => { await teardown(harness); jest.restoreAllMocks(); });

describe('M3b invalid-family refusals', () => {
  it.each<[string, string, string, 'selectedGoalItemIds' | 'selectedSeedItemIds']>([
    ['goal_invalid', en.xRefusedGoalInvalid, en.xRefusedGoalsAction, 'selectedGoalItemIds'],
    ['seed_invalid', en.xRefusedSeedInvalid, en.xRefusedSeedAction, 'selectedSeedItemIds'],
  ])('%s: its own line, and the action saves the rest without that family', async (code, line, action, field) => {
    const raw = mixedProposal('thought');
    let confirms = 0;
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
    harness.server.handler = withKinds(['goal', 'habit', 'thought'], (request) => {
      if (request.method === 'POST' && request.path.endsWith('/capture/chat')) return { status: 200, body: answer(raw) };
      if (request.method === 'POST' && request.path.endsWith('/capture/confirm')) {
        confirms += 1;
        return confirms === 1
          ? { status: 400, body: { success: false, error: 'capture refused', failureCode: code, replayed: false, persisted: [], failed: [] } }
          : { status: 200, body: mixedConfirmation() };
      }
      return defaultReply(request);
    });
    await openGenericCapture(harness);
    await say();
    await openCards();
    await press('review-confirm');
    await waitForRequest(harness, 'POST', /\/capture\/confirm$/);
    const first = lastRequest(harness, 'POST', /\/capture\/confirm$/).body as Record<string, string[]>;
    expect(first[field]?.length).toBeGreaterThan(0);

    await screen.findByTestId('capture-confirm-refused');
    expect(screen.getByText(line)).toBeTruthy();
    // VoiceOver hears it too (M3B-A-006): iOS has no live regions.
    expect(Platform.OS).toBe('ios');
    expect(announce).toHaveBeenCalledWith(line);
    expect(screen.queryByText(en.captureConfirmBadEdit)).toBeNull();
    expect(screen.getByText(action)).toBeTruthy();
    await press('capture-confirm-refused-action');
    await press('review-confirm');
    await waitForRequest(harness, 'POST', /\/capture\/confirm$/, 2);
    const second = lastRequest(harness, 'POST', /\/capture\/confirm$/).body as Record<string, string[]>;
    expect(second[field]).toEqual([]);
    // Only the named family leaves the save.
    const other = field === 'selectedGoalItemIds' ? 'selectedHabitItemIds' : 'selectedGoalItemIds';
    expect(second[other]).toEqual(first[other]);
  });
});
