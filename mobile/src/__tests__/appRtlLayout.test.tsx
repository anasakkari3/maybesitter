import React from 'react';
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { render, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LANGUAGE_STORAGE_KEY } from '../i18n/language';

jest.mock('expo-font', () => ({ useFonts: () => [true, null] }));
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

// eslint-disable-next-line import/first
import App from '../../App';

describe('App root RTL direction coverage across lifecycle gates', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('renders direction: rtl at the provider root for Arabic probe (ar)', async () => {
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
    await AsyncStorage.setItem('settings.language.chosen', 'true');
    const view = await render(<App />);

    await waitFor(() => {
      const nodes = view.queryAllByTestId('direction-root');
      expect(nodes.length).toBe(1);
      const rootNode = nodes[0];
      if (!rootNode) throw new Error('missing direction-root');
      const style = Array.isArray(rootNode.props.style)
        ? Object.assign({}, ...rootNode.props.style.filter(Boolean))
        : rootNode.props.style;
      expect(style.direction).toBe('rtl');
    });
  });

  it('renders direction: rtl at the provider root for Hebrew probe (he)', async () => {
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'he');
    await AsyncStorage.setItem('settings.language.chosen', 'true');
    const view = await render(<App />);

    await waitFor(() => {
      const nodes = view.queryAllByTestId('direction-root');
      expect(nodes.length).toBe(1);
      const rootNode = nodes[0];
      if (!rootNode) throw new Error('missing direction-root');
      const style = Array.isArray(rootNode.props.style)
        ? Object.assign({}, ...rootNode.props.style.filter(Boolean))
        : rootNode.props.style;
      expect(style.direction).toBe('rtl');
    });
  });

  it('renders direction: ltr at the provider root for English innocent-neighbor control (en)', async () => {
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
    await AsyncStorage.setItem('settings.language.chosen', 'true');
    const view = await render(<App />);

    await waitFor(() => {
      const nodes = view.queryAllByTestId('direction-root');
      expect(nodes.length).toBe(1);
      const rootNode = nodes[0];
      if (!rootNode) throw new Error('missing direction-root');
      const style = Array.isArray(rootNode.props.style)
        ? Object.assign({}, ...rootNode.props.style.filter(Boolean))
        : rootNode.props.style;
      expect(style.direction).toBe('ltr');
    });
  });
});
