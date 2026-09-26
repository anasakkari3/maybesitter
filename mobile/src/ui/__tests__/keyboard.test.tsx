/**
 * `AvoidKeyboard`, the one keyboard-avoiding container (UAT 2026-09-26, #6).
 *
 * The capture screen's literal repro lives in
 * `screens/__tests__/captureKeyboardOffset.test.tsx`. This file holds the
 * container's own rules and the census: a bare KeyboardAvoidingView measures
 * itself against its parent, so any chrome above it — the verify-email banner —
 * makes it under-pad, and no screen may use one.
 */
import React from 'react';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { Keyboard, StyleSheet, Text, TextInput, type KeyboardEvent } from 'react-native';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as windowFrame from '../windowFrame';
import { AvoidKeyboard, ENTRANCE_SETTLE_MS, keyboardOverlap } from '../keyboard';

afterEach(() => { jest.restoreAllMocks(); });

const SRC = join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === '__tests__' || entry === '__fixtures__' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

describe('keyboardOverlap', () => {
  it('is how far the keyboard reaches into the view, in window space', () => {
    // 134pt of banner above, the view runs to the bottom of an 874pt screen.
    expect(keyboardOverlap({ y: 134, height: 740 }, 538)).toBe(336);
    expect(keyboardOverlap({ y: 0, height: 874 }, 538)).toBe(336);
  });

  it('is zero when the keyboard stops short of the view', () => {
    expect(keyboardOverlap({ y: 100, height: 300 }, 538)).toBe(0);
  });

  it('is zero for a keyboard that reports no position (cross-fade transitions)', () => {
    expect(keyboardOverlap({ y: 134, height: 740 }, 0)).toBe(0);
  });
});

describe('AvoidKeyboard', () => {
  it('lifts for a keyboard that was already up when it mounted', async () => {
    // A screen swapped in under a focused field gets no show event.
    jest.spyOn(Keyboard, 'isVisible').mockReturnValue(true);
    jest.spyOn(TextInput.State, 'currentlyFocusedInput').mockReturnValue({} as never);
    jest.spyOn(Keyboard, 'metrics').mockReturnValue({ screenX: 0, screenY: 538, width: 402, height: 336 });
    jest.spyOn(windowFrame, 'measureWindowFrame').mockResolvedValue({ y: 134, height: 740 });
    await render(<AvoidKeyboard testID="box" style={{ flex: 1 }}><Text>body</Text></AvoidKeyboard>);
    await fireEvent(screen.getByTestId('box'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 402, height: 740 } } });
    await waitFor(() =>
      expect((StyleSheet.flatten(screen.getByTestId('box').props.style) as { paddingBottom: number }).paddingBottom).toBe(336));
  });

  // D4: welcome mounted after email sign-up, whose focused password field had
  // just unmounted. iOS still reported the keyboard; no field on the new
  // screen was focused. Padding for that keyboard floats the footer away from
  // where it is drawn.
  it('ignores a keyboard iOS still reports when no field is focused', async () => {
    jest.spyOn(Keyboard, 'isVisible').mockReturnValue(true);
    jest.spyOn(Keyboard, 'metrics').mockReturnValue({ screenX: 0, screenY: 538, width: 402, height: 336 });
    jest.spyOn(TextInput.State, 'currentlyFocusedInput').mockReturnValue(null as never);
    const measure = jest.spyOn(windowFrame, 'measureWindowFrame').mockResolvedValue({ y: 134, height: 740 });
    await render(<AvoidKeyboard testID="box"><Text>body</Text></AvoidKeyboard>);
    await fireEvent(screen.getByTestId('box'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 402, height: 740 } } });
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect((StyleSheet.flatten(screen.getByTestId('box').props.style) as { paddingBottom: number }).paddingBottom).toBe(0);
    expect(measure).not.toHaveBeenCalled();
  });

  it('measures again once the screen\'s entrance has settled (review M-1)', async () => {
    jest.useFakeTimers();
    try {
      const handlers: Record<string, ((event: KeyboardEvent) => void)[]> = {};
      jest.spyOn(Keyboard, 'addListener').mockImplementation(((name: string, handler: (event: KeyboardEvent) => void) => {
        (handlers[name] ??= []).push(handler);
        return { remove: () => {} };
      }) as never);
      // Mid-entrance the view sits 7pt low; settled, it does not.
      const measure = jest.spyOn(windowFrame, 'measureWindowFrame')
        .mockResolvedValueOnce({ y: 141, height: 740 })
        .mockResolvedValue({ y: 134, height: 740 });
      await render(<AvoidKeyboard testID="box"><Text>body</Text></AvoidKeyboard>);
      await React.act(async () => {
        handlers.keyboardWillShow?.forEach((h) => h({ endCoordinates: { screenX: 0, screenY: 538, width: 402, height: 336 } } as KeyboardEvent));
      });
      const pad = () => (StyleSheet.flatten(screen.getByTestId('box').props.style) as { paddingBottom: number }).paddingBottom;
      expect(pad()).toBe(343);
      await React.act(async () => { jest.advanceTimersByTime(ENTRANCE_SETTLE_MS); });
      expect(measure).toHaveBeenCalledTimes(2);
      expect(pad()).toBe(336);
    } finally {
      jest.useRealTimers();
    }
  });

  it('follows the keyboard changing height while it stays up (review M-2)', async () => {
    const handlers: Record<string, ((event: KeyboardEvent) => void)[]> = {};
    jest.spyOn(Keyboard, 'addListener').mockImplementation(((name: string, handler: (event: KeyboardEvent) => void) => {
      (handlers[name] ??= []).push(handler);
      return { remove: () => {} };
    }) as never);
    jest.spyOn(windowFrame, 'measureWindowFrame').mockResolvedValue({ y: 0, height: 874 });
    await render(<AvoidKeyboard testID="box"><Text>body</Text></AvoidKeyboard>);
    const pad = () => (StyleSheet.flatten(screen.getByTestId('box').props.style) as { paddingBottom: number }).paddingBottom;
    await React.act(async () => {
      handlers.keyboardWillShow?.forEach((h) => h({ endCoordinates: { screenX: 0, screenY: 538, width: 402, height: 336 } } as KeyboardEvent));
    });
    expect(pad()).toBe(336);
    // The emoji keyboard is taller; iOS posts only a frame change.
    await React.act(async () => {
      handlers.keyboardWillChangeFrame?.forEach((h) => h({ endCoordinates: { screenX: 0, screenY: 494, width: 402, height: 380 } } as KeyboardEvent));
    });
    expect(pad()).toBe(380);
  });

  it('fills its parent, so padding cannot grow it (review M-4)', async () => {
    await render(<AvoidKeyboard testID="box"><Text>body</Text></AvoidKeyboard>);
    expect((StyleSheet.flatten(screen.getByTestId('box').props.style) as { flex: number }).flex).toBe(1);
  });

  it('keeps the caller\'s style', async () => {
    await render(<AvoidKeyboard testID="box" style={{ flex: 1, backgroundColor: 'red' }}><Text>body</Text></AvoidKeyboard>);
    const style = StyleSheet.flatten(screen.getByTestId('box').props.style) as Record<string, unknown>;
    expect(style.flex).toBe(1);
    expect(style.backgroundColor).toBe('red');
    expect(style.paddingBottom).toBe(0);
  });

  it('ignores a show event that a newer hide superseded', async () => {
    const handlers: Record<string, ((event: KeyboardEvent) => void)[]> = {};
    jest.spyOn(Keyboard, 'addListener').mockImplementation(((name: string, handler: (event: KeyboardEvent) => void) => {
      (handlers[name] ??= []).push(handler);
      return { remove: () => {} };
    }) as never);
    let resolveFrame: (frame: windowFrame.WindowFrame) => void = () => {};
    jest.spyOn(windowFrame, 'measureWindowFrame').mockReturnValue(new Promise((resolve) => { resolveFrame = resolve; }));
    await render(<AvoidKeyboard testID="box"><Text>body</Text></AvoidKeyboard>);
    await React.act(async () => {
      handlers.keyboardWillShow?.forEach((h) => h({ endCoordinates: { screenX: 0, screenY: 538, width: 402, height: 336 } } as KeyboardEvent));
      handlers.keyboardWillHide?.forEach((h) => h({} as KeyboardEvent));
      resolveFrame({ y: 134, height: 740 });
    });
    expect((StyleSheet.flatten(screen.getByTestId('box').props.style) as { paddingBottom: number }).paddingBottom).toBe(0);
  });
});

describe('census', () => {
  it('no screen uses a bare KeyboardAvoidingView', () => {
    const offenders = sourceFiles(SRC)
      .filter((path) => /<KeyboardAvoidingView\b|\bKeyboardAvoidingView\s*[,}]/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path));
    expect(offenders).toEqual([]);
  });

  it('every screen with a keyboard and a pinned footer goes through AvoidKeyboard', () => {
    for (const file of [
      'screens/CaptureScreen.tsx',
      'screens/ReviewScreen.tsx',
      'screens/EmailAuthScreen.tsx',
      'features/onboarding/OnboardingChrome.tsx',
    ]) {
      expect(`${file}: ${/<AvoidKeyboard\b/.test(readFileSync(join(SRC, file), 'utf8'))}`).toBe(`${file}: true`);
    }
  });
});
