import React from 'react';
import { afterEach, describe, expect, it } from '@jest/globals';
import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { AppProvider } from '../../state/AppContext';
import { AuthGate } from '../AuthGate';
import { AuthProvider, useAuth } from '../AuthProvider';
import { createFakeAuthRepository } from '../fakeAuthRepository';
import en from '../../i18n/locales/en.json';

/**
 * The override, seen from the outside: does the gate let a developer in, and
 * is it truly impossible in a release bundle?
 *
 * `isDevBundle={false}` is how a store build is simulated — React Native sets
 * `__DEV__` false there, and everything else stays as misconfigured as the
 * worst case allows.
 */

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const ORIGINAL = {
  env: process.env.EXPO_PUBLIC_APP_ENV,
  api: process.env.EXPO_PUBLIC_API_BASE_URL,
  token: process.env.EXPO_PUBLIC_DEV_BEARER_TOKEN,
};

function setEnv(appEnv: string, api: string, token: string) {
  process.env.EXPO_PUBLIC_APP_ENV = appEnv;
  process.env.EXPO_PUBLIC_API_BASE_URL = api;
  process.env.EXPO_PUBLIC_DEV_BEARER_TOKEN = token;
}

afterEach(() => {
  process.env.EXPO_PUBLIC_APP_ENV = ORIGINAL.env;
  process.env.EXPO_PUBLIC_API_BASE_URL = ORIGINAL.api;
  process.env.EXPO_PUBLIC_DEV_BEARER_TOKEN = ORIGINAL.token;
});

/** Renders the token the client would actually send, never logging it. */
function TokenProbe() {
  const { getIdToken, devBypass } = useAuth();
  const [token, setToken] = React.useState<string | null>(null);
  React.useEffect(() => {
    void getIdToken().then(setToken);
  }, [getIdToken]);
  return <Text testID="probe">{`${devBypass ? 'bypass' : 'firebase'}:${token ?? 'none'}`}</Text>;
}

async function renderWithBundle(isDevBundle: boolean) {
  // The repository never resolves, so anything signed-in on screen can only
  // have come from the override.
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={createFakeAuthRepository()} isDevBundle={isDevBundle}>
          <AuthGate>
            <Text>THE APP</Text>
            <TokenProbe />
          </AuthGate>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

describe('dev bypass through the gate', () => {
  it('reaches the app against a local backend in a development bundle', async () => {
    setEnv('development', 'http://localhost:3000', 'local-dev-token');
    await renderWithBundle(true);
    expect(screen.getByText('THE APP')).toBeTruthy();
    expect(screen.getByTestId('probe')).toHaveTextContent('bypass:local-dev-token');
  });

  it('is inert in a release bundle with the same environment', async () => {
    setEnv('development', 'http://localhost:3000', 'local-dev-token');
    await renderWithBundle(false);
    // Still loading: the fake never resolved, and the override did not stand
    // in for it. The app is not reachable either way.
    expect(screen.getByTestId('auth-loading')).toBeTruthy();
    expect(screen.queryByText('THE APP')).toBeNull();
  });

  it.each(['staging', 'production'])('is inert in a %s development bundle', async appEnv => {
    setEnv(appEnv, 'http://localhost:3000', 'local-dev-token');
    await renderWithBundle(true);
    expect(screen.queryByText('THE APP')).toBeNull();
  });

  it('is inert when a development build points at a real backend', async () => {
    setEnv('development', 'https://maybesitter-staging.example.run.app', 'local-dev-token');
    await renderWithBundle(true);
    expect(screen.queryByText('THE APP')).toBeNull();
  });

  it('says on the sign-in screen when it is not active', async () => {
    setEnv('development', 'http://localhost:3000', '');
    await renderWithBundle(true);
    expect(screen.queryByText(en.authDevMode)).toBeNull();
  });
});
