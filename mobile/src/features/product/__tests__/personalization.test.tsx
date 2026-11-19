import React from 'react';
import { beforeEach, expect, it, jest } from '@jest/globals';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider } from '../../../state/AppContext';
import { PersonalizationScreen } from '../ContextScreens';
import mockFixture from '../../../api/__fixtures__/memory.withSuggestion.json';
import { strings } from '../../../i18n/strings';
const mockCreate = jest.fn();
const mockDecide = jest.fn();
const mockMemory: { data: unknown } = { data: null };
jest.mock('../../../api/queries', () => ({
  useIntelligenceDecided: () => () => undefined,
  useMemory: () => ({ data: mockMemory.data ?? mockFixture, isPending: false, error: null, refetch: jest.fn() }),
  useConsents: () => ({ data: { currentVersions: { personalization: 'v1' }, personalization: { state: 'granted' } }, isPending: false, error: null, refetch: jest.fn() }),
  useSetPersonalizationConsent: () => ({ mutateAsync: jest.fn() }),
  useCreateMemory: () => ({ mutate: mockCreate, isPending: false, error: null, reset: jest.fn() }),
  useMemorySuggestion: () => ({ mutate: mockDecide, isPending: false, error: null }),
}));
const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
beforeEach(() => { jest.clearAllMocks(); mockMemory.data = null; });
it('editing learning requires an explicit save and does not accept the original suggestion', async () => {
  await render(<SafeAreaProvider initialMetrics={metrics}><AppProvider><PersonalizationScreen /></AppProvider></SafeAreaProvider>);
  const t = Object.values(strings).find(value => screen.queryAllByText(value.xLearned).length > 0)!;
  await fireEvent.press(screen.getAllByLabelText(t.memoryEdit)[0]!);
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockDecide).not.toHaveBeenCalled();
  await fireEvent.changeText(screen.getByTestId('personalization-edit-input'), 'I prefer quiet mornings');
  await fireEvent.press(screen.getByTestId('personalization-edit-save'));
  expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'preference', content: 'I prefer quiet mornings' }), expect.any(Object));
  expect(mockDecide).not.toHaveBeenCalled();
});

// UAT 2026-09-27 (#17, shot 100): «ما بينحفظ إشي إلا إذا إنت حفظته» said
// twice — in the toggle's consent words and again as the learned section's
// lede — under a subtitle that said nothing about the page. The consent's
// words stay (personalizationConsentCopy.test.ts holds them); the repeats go.
it('says each thing once: no repeated "nothing is saved" lede, no decorative subtitle', async () => {
  await render(<SafeAreaProvider initialMetrics={metrics}><AppProvider><PersonalizationScreen /></AppProvider></SafeAreaProvider>);
  for (const t of Object.values(strings)) {
    expect(screen.queryAllByText(t.memorySuggestionsLede)).toHaveLength(0);
    expect(screen.queryAllByText(t.xMyBody)).toHaveLength(0);
  }
  expect(Object.values(strings).filter(t => screen.queryAllByText(t.trustPersonalizationBody).length > 0)).toHaveLength(1);
});

/*
 * de7fcb84 audit CA8.3: «عدّل» → save stored the person's own sentence but
 * left the suggestion open; the same card stayed, and «خليه» then stored the
 * same meaning a second time. A saved edit settles the suggestion.
 */
it('a saved edit retires the suggestion it was made from', async () => {
  mockCreate.mockImplementation((...args: unknown[]) => { (args[1] as { onSuccess?: () => void }).onSuccess?.(); });
  await render(<SafeAreaProvider initialMetrics={metrics}><AppProvider><PersonalizationScreen /></AppProvider></SafeAreaProvider>);
  const t = Object.values(strings).find(value => screen.queryAllByText(value.xLearned).length > 0)!;
  await fireEvent.press(screen.getAllByLabelText(t.memoryEdit)[0]!);
  await fireEvent.changeText(screen.getByTestId('personalization-edit-input'), 'I work best before noon');
  await fireEvent.press(screen.getByTestId('personalization-edit-save'));
  expect(mockDecide).toHaveBeenCalledWith(expect.objectContaining({
    decision: 'dismiss',
    suggestion: expect.objectContaining({ fingerprint: 'R1_focus_window:09:00-12:00' }),
  }));
});

/*
 * de7fcb84 audit CXA8.5: a defer (R2) suggestion was explained here with the
 * focus-window (R1) words — «أشياء خلّصتها بآخر 28 يوم: 6. بهالساعات: 6.» for
 * six defers. The memory screen already chose per rule; this screen now does too.
 */
it('explains a defer suggestion with what it was read from, not with finished items', async () => {
  mockMemory.data = {
    ...(mockFixture as object),
    suggestions: [{ ruleId: 'R2_defer_default', fingerprint: 'R2_defer_default:60m', deferMinutes: 60, confidence: 1, evidence: { matchingCount: 6, totalCount: 6, lookbackDays: 28 } }],
  };
  await render(<SafeAreaProvider initialMetrics={metrics}><AppProvider><PersonalizationScreen /></AppProvider></SafeAreaProvider>);
  const t = Object.values(strings).find(value => screen.queryAllByText(value.xLearned).length > 0)!;
  const deferWords = t.memorySuggestionDeferEvidence.split('{')[0]!.trim();
  expect(screen.queryAllByText(new RegExp(deferWords.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).length).toBeGreaterThan(0);
});
