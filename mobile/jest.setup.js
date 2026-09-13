// AsyncStorage is a native module: under jest it is null unless mocked, and
// the language preference reads it on mount, so every render test would fail.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// The Firebase auth SDK is a native module. `src/auth/firebaseAuthRepository`
// imports it at module load, so every test that renders the gate would fail on
// the import alone — even the ones that inject a FakeAuthRepository and never
// reach Firebase. The mock is deliberately inert: a test that accidentally
// used the real repository would get `null` and a failed assertion, not a
// quietly signed-in user.
jest.mock('@react-native-firebase/auth', () => ({
  getAuth: () => ({ currentUser: null }),
  getIdToken: async () => null,
  onAuthStateChanged: () => () => {},
  reload: async () => {},
  signOut: async () => {},
  createUserWithEmailAndPassword: async () => ({ user: null }),
  signInWithEmailAndPassword: async () => ({ user: null }),
  sendPasswordResetEmail: async () => {},
  sendEmailVerification: async () => {},
}));

// NetInfo is a native module too. Without this the query layer's connectivity
// listener throws on its first probe, and every test that renders ApiProvider
// fails on a device fact none of them are about.
jest.mock('@react-native-community/netinfo', () =>
  require('@react-native-community/netinfo/jest/netinfo-mock'),
);

// The Google sign-in SDK is a TurboModule: importing it under Jest throws
// before any test body runs. The mock is inert for the same reason the
// Firebase one is — a test that reached the real SDK would get nothing, not a
// signed-in user. Behaviour is driven through `FakeAuthRepository` instead.
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: () => {},
    hasPlayServices: async () => true,
    signIn: async () => ({ type: 'cancelled' }),
    signOut: async () => null,
    addScopes: async () => null,
    getTokens: async () => ({ accessToken: 'fake-access-token', idToken: 'fake-id-token' }),
    revokeAccess: async () => null,
  },
  statusCodes: {
    SIGN_IN_CANCELLED: '12501',
    IN_PROGRESS: 'ASYNC_OP_IN_PROGRESS',
    PLAY_SERVICES_NOT_AVAILABLE: '2',
    SIGN_IN_REQUIRED: '4',
    NULL_PRESENTER: 'NULL_PRESENTER',
  },
}));

// `expo-crypto`'s digest is native: under Jest it resolves to an empty string,
// which would make the Apple nonce test pass while asserting nothing. Backed
// by Node's real SHA-256 instead, so the test checks what it claims to — that
// this app asks for SHA-256, in hex, and sends the hash and the raw nonce to
// the right places.
jest.mock('expo-crypto', () => {
  const nodeCrypto = require('node:crypto');
  return {
    CryptoDigestAlgorithm: { SHA256: 'SHA-256', SHA512: 'SHA-512' },
    CryptoEncoding: { HEX: 'hex', BASE64: 'base64' },
    getRandomBytes: (byteCount) => new Uint8Array(nodeCrypto.randomBytes(byteCount)),
    getRandomBytesAsync: async (byteCount) => new Uint8Array(nodeCrypto.randomBytes(byteCount)),
    randomUUID: () => nodeCrypto.randomUUID(),
    digestStringAsync: async (algorithm, data, options) => {
      const nodeAlgorithm = String(algorithm).toLowerCase().replace('-', '');
      return nodeCrypto
        .createHash(nodeAlgorithm)
        .update(data, 'utf8')
        .digest(options?.encoding === 'base64' ? 'base64' : 'hex');
    },
  };
});

// `expo-apple-authentication` is iOS-native. `isAvailableAsync` resolves true
// here, standing in for an iOS 13+ device — which is exactly what it does on a
// real one, capability or not. That is the point: the availability tests are
// about this app's own flag and platform gates, not about the SDK's answer.
// `signInAsync` is inert; the flows are driven through `FakeAuthRepository`.
jest.mock('expo-apple-authentication', () => ({
  isAvailableAsync: async () => true,
  signInAsync: async () => ({ identityToken: null, fullName: null }),
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
  AppleAuthenticationCredentialState: { REVOKED: 0, AUTHORIZED: 1, NOT_FOUND: 2, TRANSFERRED: 3 },
}));

// `expo-speech-recognition` is a native module and there is none under Jest.
//
// The mock is deliberately inert rather than clever: `ExpoSpeechCaptureService`
// takes its module and its event subscription as constructor arguments, so the
// real behaviour — permissions, locale resolution, every error code, the
// transcript path — is exercised against a fake in
// `expoSpeechCaptureService.test.ts`. This exists only so the composer can be
// rendered at all.
//
// `getSupportedLocales` answering with nothing is the honest default here:
// a Jest environment has no recogniser, so the service resolves
// `localeUnavailable` and the mic hides itself, which is what a device without
// dictation does.
jest.mock('expo-speech-recognition', () => ({
  ExpoSpeechRecognitionModule: {
    requestPermissionsAsync: async () => ({ granted: false }),
    getSupportedLocales: async () => ({ locales: [], installedLocales: [] }),
    start: () => {},
    stop: () => {},
    abort: () => {},
  },
  useSpeechRecognitionEvent: () => {},
}));

// Crashlytics is native (UC-4.4, #180). `src/lib/crash.ts` resolves the client
// lazily and returns null when there is none, so this mock only keeps the
// import from throwing at module load; the wrapper's own rules — the attribute
// allowlist, the breadcrumb list, and never calling setUserId — are asserted
// against an injected fake in `crash.test.ts`.
jest.mock('@react-native-firebase/crashlytics', () => ({
  getCrashlytics: () => { throw new Error('no native crashlytics under jest'); },
  log: () => {},
  recordError: () => {},
  setAttributes: async () => null,
  setCrashlyticsCollectionEnabled: async () => null,
}));
