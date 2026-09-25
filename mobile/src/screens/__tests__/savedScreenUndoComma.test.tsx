import React from 'react';
import { describe, expect, it, jest } from '@jest/globals';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider } from '../../state/AppContext';
import { SavedScreen } from '../SavedScreen';
import * as captureProvider from '../../features/capture/CaptureProvider';
import { LANGUAGE_STORAGE_KEY } from '../../i18n/language';

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

describe('SavedScreen undo rollback locale-aware list formatting', () => {
  async function renderWithLang(lang: 'en' | 'he' | 'ar', undoMock: () => Promise<captureProvider.UndoOutcome>) {
    jest.spyOn(captureProvider, 'useCaptureFlow').mockReturnValue({
      state: {
        stage: 'saved',
        input: 'task',
        proposal: null,
        persisted: [
          { itemId: '1', commitmentId: 'c1', title: lang === 'ar' ? 'المهمة الأولى' : lang === 'he' ? 'משימה ראשונה' : 'First task', importance: 'must', timing: null },
          { itemId: '2', commitmentId: 'c2', title: lang === 'ar' ? 'المهمة الثانية' : lang === 'he' ? 'משימה שנייה' : 'Second task', importance: 'must', timing: null },
        ],
        failed: [],
        collisions: [],
        undoable: true,
      },
      aiGranted: true,
      aiAsked: true,
      open: jest.fn(),
      setText: jest.fn(),
      analyze: jest.fn(),
      adoptProposal: jest.fn(),
      toggleItem: jest.fn(),
      selectAll: jest.fn(),
      deselectAll: jest.fn(),
      editItem: jest.fn(),
      clarify: jest.fn(),
      confirm: jest.fn(),
      undo: undoMock,
      backToComposer: jest.fn(),
      close: jest.fn(),
    } as any);

    await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <AppProvider>
          <SavedScreen />
        </AppProvider>
      </SafeAreaProvider>
    );
  }

  it('formats partial undo list with Latin comma (, ) in English control (en)', async () => {
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
    await AsyncStorage.setItem('settings.language.chosen', 'true');

    const undoMock = jest.fn<() => Promise<captureProvider.UndoOutcome>>().mockResolvedValue({
      undone: [],
      stillSaved: ['c1', 'c2'],
    });

    await renderWithLang('en', undoMock);

    // Click undo
    const undoButton = screen.getByTestId('saved-undo');
    fireEvent.press(undoButton);

    await waitFor(() => {
      const outcome = screen.getByTestId('saved-undo-partial');
      expect(outcome).toBeTruthy();
      const text = Array.isArray(outcome.props.children)
        ? outcome.props.children.join('')
        : String(outcome.props.children);
      expect(text).toContain('First task, Second task');
      expect(text).not.toContain('،');
    });
  });

  it('formats partial undo list with standard comma (, ) in Hebrew probe (he)', async () => {
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'he');
    await AsyncStorage.setItem('settings.language.chosen', 'true');

    const undoMock = jest.fn<() => Promise<captureProvider.UndoOutcome>>().mockResolvedValue({
      undone: [],
      stillSaved: ['c1', 'c2'],
    });

    await renderWithLang('he', undoMock);

    const undoButton = screen.getByTestId('saved-undo');
    fireEvent.press(undoButton);

    await waitFor(() => {
      const outcome = screen.getByTestId('saved-undo-partial');
      expect(outcome).toBeTruthy();
      const text = Array.isArray(outcome.props.children)
        ? outcome.props.children.join('')
        : String(outcome.props.children);
      expect(text).toContain('משימה ראשונה, משימה שנייה');
      expect(text).not.toContain('،');
    });
  });

  it('formats partial undo list with Arabic comma (، ) in Arabic probe (ar)', async () => {
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
    await AsyncStorage.setItem('settings.language.chosen', 'true');

    const undoMock = jest.fn<() => Promise<captureProvider.UndoOutcome>>().mockResolvedValue({
      undone: [],
      stillSaved: ['c1', 'c2'],
    });

    await renderWithLang('ar', undoMock);

    const undoButton = screen.getByTestId('saved-undo');
    fireEvent.press(undoButton);

    await waitFor(() => {
      const outcome = screen.getByTestId('saved-undo-partial');
      expect(outcome).toBeTruthy();
      const text = Array.isArray(outcome.props.children)
        ? outcome.props.children.join('')
        : String(outcome.props.children);
      expect(text).toContain('المهمة الأولى، المهمة الثانية');
      expect(text).toContain('،');
    });
  });
});
