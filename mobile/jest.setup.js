// AsyncStorage is a native module: under jest it is null unless mocked, and
// the language preference reads it on mount, so every render test would fail.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
