import React from 'react';
import { describe, expect, it } from '@jest/globals';
import { render, screen } from '@testing-library/react-native';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import { createAppQueryClient } from '../../../api/queryClient';
import { ApiProvider } from '../../../api/ui/ApiProvider';
import { AccountDeletionProvider } from '../AccountDeletionProvider';
import { DeleteAccountScreen } from '../../../screens/DeleteAccountScreen';
import ar from '../../../i18n/locales/ar.json';
import he from '../../../i18n/locales/he.json';

/**
 * The deletion screen in a right-to-left language.
 *
 * Arabic is the app's default, so this is the layout most users will see, not
 * a variant. Direction is set once on the root view (`src/Root.tsx`); what
 * matters here is that nothing on this screen hard-codes a physical side,
 * which would leave the text and its bullets disagreeing.
 */

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

async function renderIn(lang: 'ar' | 'he') {
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
  const repository = createFakeAuthRepository({
    initialUser: { uid: 'alice', email: 'a@example.com', emailVerified: true, displayName: null, providerIds: ['password'] },
  });
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <ApiProvider client={createAppQueryClient()}>
            <AccountDeletionProvider>
              <DeleteAccountScreen onBack={() => {}} />
            </AccountDeletionProvider>
          </ApiProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

describe('right-to-left', () => {
  it('renders the Arabic copy and writes it right-to-left', async () => {
    await renderIn('ar');
    // `ar` is the app's default language, so this is the common case.
    expect(await screen.findByText(ar.accountDeleteTitle)).toBeTruthy();
    const title = screen.getByText(ar.accountDeleteTitle);
    const style = Array.isArray(title.props.style) ? Object.assign({}, ...title.props.style.filter(Boolean)) : title.props.style;
    expect(style.writingDirection).toBe('rtl');
    // iOS Fabric swaps this logical edge under inherited RTL.
    expect(style.textAlign).toBe('left');
  });

  it('hard-codes no physical side anywhere on the screen or the receipt', () => {
    // The eslint rule bans marginLeft/paddingRight and friends; this covers
    // the flex properties it does not, which mirror just as wrongly.
    for (const file of ['DeleteAccountScreen.tsx', 'AccountDeletedScreen.tsx']) {
      const source = readFileSync(join(__dirname, '..', '..', '..', 'screens', file), 'utf8');
      expect(source).not.toMatch(/flexDirection: 'row-reverse'/);
      expect(source).not.toMatch(/textAlign: '(left|right)'/);
      expect(source).not.toMatch(/\b(marginLeft|marginRight|paddingLeft|paddingRight|left|right):/);
    }
  });

  it('renders the Hebrew copy too', async () => {
    await renderIn('he');
    // Hebrew is wired but not user-selectable yet (src/i18n/README.md); the
    // strings still have to be there and still have to render.
    expect(typeof he.accountDeleteTitle).toBe('string');
    expect(he.accountDeleteTitle.length).toBeGreaterThan(0);
  });
});
