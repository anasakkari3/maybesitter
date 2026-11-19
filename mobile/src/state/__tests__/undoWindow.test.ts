import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { AppState } from 'react-native';
import { TOAST_SECONDS } from '../../ui/toast';
import { UNDO_WINDOW_MS, deferWithUndo, flushPendingCommits, pendingCommitCount } from '../undoWindow';

/**
 * The undo window (CA11.2, CX3.1; owner decision 2026-11-19): an action with
 * «رجّعها» is held for the toast's few seconds and only then sent. «رجّعها»
 * cancels it, so nothing reaches the server and nothing needs reversing there.
 */
afterEach(() => {
  flushPendingCommits();
  jest.useRealTimers();
});

describe('the undo window', () => {
  it('is exactly as long as the toast that offers it', () => {
    expect(UNDO_WINDOW_MS).toBe(TOAST_SECONDS * 1000);
  });

  it('sends the action once when the window closes', () => {
    jest.useFakeTimers();
    const commit = jest.fn();
    deferWithUndo(commit);
    jest.advanceTimersByTime(UNDO_WINDOW_MS - 1);
    expect(commit).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(commit).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(UNDO_WINDOW_MS * 3);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(pendingCommitCount()).toBe(0);
  });

  it('never sends an action that was taken back, and a second undo is a no-op', () => {
    jest.useFakeTimers();
    const commit = jest.fn();
    const undo = deferWithUndo(commit);
    expect(undo()).toBe(true);
    expect(undo()).toBe(false);
    jest.advanceTimersByTime(UNDO_WINDOW_MS * 2);
    flushPendingCommits();
    expect(commit).not.toHaveBeenCalled();
  });

  it('cannot take an action back once it was sent', () => {
    jest.useFakeTimers();
    const commit = jest.fn();
    const undo = deferWithUndo(commit);
    jest.advanceTimersByTime(UNDO_WINDOW_MS);
    expect(undo()).toBe(false);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('sends what is pending at once when the app leaves the foreground, so a closed app loses nothing', () => {
    const listeners: ((state: string) => void)[] = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((_type: string, listener: (state: string) => void) => {
      listeners.push(listener);
      return { remove: () => {} };
    }) as never);
    jest.useFakeTimers();
    const commit = jest.fn();
    deferWithUndo(commit);
    for (const listener of listeners) listener('background');
    expect(commit).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(UNDO_WINDOW_MS);
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
