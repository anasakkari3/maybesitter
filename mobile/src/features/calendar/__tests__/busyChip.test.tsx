/**
 * The conflict note, rendered in all three languages (UC-3.2, #186 step 7).
 *
 * Arabic and Hebrew rather than English, because English is the language in
 * which a mistake here is invisible. The copy is looked up by key, so a chip
 * that fell back to English would still *say* something; asserting against
 * `ar.json` and `he.json` is what makes "it is translated" a fact rather than
 * an assumption.
 *
 * ── On digits ────────────────────────────────────────────────────
 *
 * This app pins Latin digits for Arabic (`ar-u-nu-latn`, and `INTL_LOCALE` in
 * `i18n/locale.ts` explains why at length), so the times read the same in all
 * three. That is a decision made elsewhere, and the reason it is worth writing
 * down here is that it means the usual Arabic-digit trap — a guard built on
 * `\\d`, which is ASCII-only — cannot bite this chip. Nothing in this feature
 * pattern-matches on a digit anywhere; the times go through `Intl` and the
 * copy through the locale files.
 *
 * ── What is asserted about the all-day case ──────────────────────
 *
 * A different sentence, not the same one with empty times. "Overlaps a calendar
 * event 00:00–00:00" is what you get from a chip that treats an all-day entry
 * as a timed one, and it reads as a bug to anybody who sees it.
 */
import React from 'react';
import { describe, expect, it } from '@jest/globals';
import { render, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider } from '../../../state/AppContext';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import { BusyConflictChip } from '../BusyConflictChip';
import type { DeviceBusyBlock } from '../busyBlocks';
import ar from '../../../i18n/locales/ar.json';
import en from '../../../i18n/locales/en.json';
import he from '../../../i18n/locales/he.json';

const NOW = new Date();
const MINUTE = 60_000;

function block(from: number, to: number, allDay = false): DeviceBusyBlock {
  return {
    nativeId: `b${from}`,
    startAt: new Date(NOW.getTime() + from * MINUTE).toISOString(),
    endAt: new Date(NOW.getTime() + to * MINUTE).toISOString(),
    allDay,
  };
}

/** The part of the sentence before the `{range}` hole, which is the copy itself. */
function prefixOf(template: string): string {
  return template.split('{range}')[0]!.trim();
}

async function chipIn(lang: 'ar' | 'en' | 'he', blocks: DeviceBusyBlock[]) {
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
  await render(
    <AppProvider>
      <BusyConflictChip blocks={blocks} testID="chip" />
    </AppProvider>,
  );
  // The stored preference is read in an effect, so the first frame is still
  // whatever the device said.
  await waitFor(() => {
    expect(screen.queryByTestId('chip')?.props.children).toContain(
      blocks.some((one) => !one.allDay)
        ? prefixOf({ ar, en, he }[lang].calendarBusyConflict)
        : { ar, en, he }[lang].calendarBusyConflictAllDay,
    );
  });
  return String(screen.getByTestId('chip').props.children);
}

describe('a timed clash', () => {
  it('reads in Arabic, with the times in it', async () => {
    const label = await chipIn('ar', [block(60, 150)]);
    expect(label).toContain(prefixOf(ar.calendarBusyConflict));
    expect(label).not.toContain(prefixOf(en.calendarBusyConflict));
    // A range, not one time: the note has to say how long the thing is.
    expect(label).toMatch(/[0-9]{2}:[0-9]{2}.+[0-9]{2}:[0-9]{2}/);
  });

  it('reads in Hebrew', async () => {
    const label = await chipIn('he', [block(60, 150)]);
    expect(label).toContain(prefixOf(he.calendarBusyConflict));
    expect(label).not.toContain(prefixOf(en.calendarBusyConflict));
  });

  it('reads in English', async () => {
    expect(await chipIn('en', [block(60, 150)])).toContain(prefixOf(en.calendarBusyConflict));
  });
});

describe('an all-day entry', () => {
  it('gets its own sentence in Arabic, with no times pretending to be a range', async () => {
    const label = await chipIn('ar', [block(0, 60 * 24, true)]);
    expect(label).toBe(ar.calendarBusyConflictAllDay);
    expect(label).not.toContain('00:00');
  });

  it('gets its own sentence in Hebrew', async () => {
    expect(await chipIn('he', [block(0, 60 * 24, true)])).toBe(he.calendarBusyConflictAllDay);
  });

  it('gives way to a timed clash on the same day, because that one has an answer in it', async () => {
    const label = await chipIn('ar', [block(0, 60 * 24, true), block(60, 150)]);
    expect(label).toContain(prefixOf(ar.calendarBusyConflict));
  });
});

describe('nothing to say', () => {
  it('draws nothing at all rather than an empty pill', async () => {
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
    await render(
      <AppProvider>
        <BusyConflictChip blocks={[]} testID="chip" />
      </AppProvider>,
    );
    expect(screen.queryByTestId('chip')).toBeNull();
  });
});
