import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor } from '@testing-library/react-native';
import { MemoryScreen } from '../../memory/MemoryScreen';
import { searchableCount } from '../../things/searchModel';
import { foldForSearch } from '../../../text/foldForSearch';
import { NOW, Providers, fact, flatStyle, prepareM6, teardown, type M6Harness } from '../../../__acceptance__/m6/harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

/** Regressions for Codex's M6a-1 Task A inspection r2 (`runs/m6a1-inspectA2`). */
let harness: M6Harness | undefined;
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(NOW); });
afterEach(async () => { await teardown(harness); harness = undefined; jest.useRealTimers(); });

describe('M6A-INSPECT-R2-001 the server minimum counts letters and digits by code point', () => {
  it.each([['a-', 1], ['ا،', 1], ['😀a', 1], ['ab', 2], ['اب', 2], ['אב', 2], ['3a', 2]] as [string, number][])(
    '%s has %i', (raw, expected) => {
      expect(searchableCount(foldForSearch(raw))).toBe(expected);
    },
  );
});

describe('M6A-INSPECT-R2-002 a fact is set in its own script\'s face', () => {
  it.each<['ar' | 'he', string, string, RegExp]>([
    ['ar', 'he-fact', 'פגישה מחר', /Hebrew/], // a Hebrew fact in the Arabic app
    ['he', 'ar-fact', 'اجتماع بكرة', /Kufi|Arabic/], // an Arabic fact in the Hebrew app
    ['ar', 'en-fact', 'Dentist tomorrow', /Jakarta/], // an English fact in the Arabic app
  ])('%s UI, %s', async (language, id, content, face) => {
    harness = await prepareM6(language, { memoryItems: [fact(id, content)] });
    await render(<Providers harness={harness}><MemoryScreen onBack={() => undefined} /></Providers>);
    await waitFor(() => expect(screen.queryByTestId(`memory-screen-item-${id}`)).not.toBeNull());
    expect(String(flatStyle(screen.getByTestId(`memory-screen-item-${id}`)).fontFamily)).toMatch(face);
  });
});
