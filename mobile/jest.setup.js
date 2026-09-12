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
