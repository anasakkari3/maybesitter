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
  },
  statusCodes: {
    SIGN_IN_CANCELLED: '12501',
    IN_PROGRESS: 'ASYNC_OP_IN_PROGRESS',
    PLAY_SERVICES_NOT_AVAILABLE: '2',
    SIGN_IN_REQUIRED: '4',
    NULL_PRESENTER: 'NULL_PRESENTER',
  },
}));
