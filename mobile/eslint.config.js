// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const i18next = require('eslint-plugin-i18next');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', '.expo/*', 'node_modules/*'],
  },
  {
    // `jest.setup.js` runs inside Jest and is nothing but `jest.mock` calls,
    // but no config block covered it, so every one of them read as an
    // undefined global. Twelve errors for the one identifier the file exists
    // to use drowns out anything real that lands here later.
    files: ['jest.setup.js'],
    languageOptions: { globals: { jest: 'readonly' } },
  },
  {
    files: ['src/**/*.{ts,tsx}', 'App.tsx', 'app.config.ts'],
    rules: {
      // Arabic is the default language and the root view sets `direction`, so
      // every box offset must be writing-direction relative or the mirrored
      // layout breaks. `left`/`right` are still allowed for symmetric absolute
      // fills (`left: 0, right: 0`), which mirror trivially.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "Property[key.name=/^(margin|padding)(Left|Right)$/], Property[key.name=/^border(Left|Right)(Width|Color|Style)$/]",
          message:
            'Use the start/end form (paddingStart, marginEnd, borderStartWidth…) so Arabic and Hebrew mirror correctly.',
        },
      ],
    },
  },
  {
    /**
     * Where device-local storage may be used (UC-1.4 #148 step 4).
     *
     * The retired Flutter client's mock mode persisted the user's edits to
     * `shared_preferences`, and the RN app must not carry that pattern into a
     * real build: commitment titles are the most personal thing this product
     * holds, and neither platform encrypts app storage by default. Server
     * state belongs in Firestore under the uid, where signing in on a new
     * device is what brings it back.
     *
     * `src/i18n/language.ts` is the exception the rule allows for: a stored
     * language preference is not content, and it has to survive a relaunch.
     *
     * `src/lib/deviceSettings/` is the second, and is outside the globs below
     * on purpose (UC-2.R1 #171). It is the directory this rule's own message
     * names, it holds exactly two things — which onboarding step this install
     * reached, and an offline copy of the five coarse routine answers whose
     * canonical home is the account — and its README makes the argument for
     * each. Anything added there needs the same argument in its own header.
     */
    files: ['src/api/**/*.{ts,tsx}', 'src/features/**/*.{ts,tsx}', 'src/screens/**/*.{ts,tsx}'],
    // Tests are excluded because the rule is about what *ships*: a test that
    // seeds the stored language preference persists nothing for a user. The
    // rule was accidentally inconsistent before — the same pattern in
    // `src/design/__tests__` was untouched only because of its directory.
    ignores: ['src/**/__tests__/**', 'src/**/__mocks__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@react-native-async-storage/async-storage',
              message:
                'No user content on device storage (#148). Server state lives in Firestore under the uid; device-only preferences belong in src/i18n/language.ts or a future src/lib/deviceSettings/.',
            },
            {
              name: 'expo-secure-store',
              message: 'Credentials live in the Firebase SDK keychain entry only (#151).',
            },
          ],
          patterns: [
            {
              group: ['expo-sqlite', 'react-native-mmkv', 'expo-file-system*'],
              message: 'No local database or file cache of user content (#148, #157).',
            },
          ],
        },
      ],
    },
  },
  {
    // The React Compiler lint rules landed with SDK 57 and flag idioms the
    // design implementation already uses and the app relies on:
    //   - `useRef(new Animated.Value(1)).current` in the press primitives and
    //     the motion helpers (react-hooks/refs), and refs read inside event
    //     handlers such as micDown/micUp;
    //   - `Date.now()` inside those same handlers (react-hooks/purity), which
    //     runs on press, not during render;
    //   - inline `icon={c => <TodayIcon color={c} />}` props in the tab bar
    //     (react-hooks/static-components).
    // They are warnings here rather than silence: the code is verified working
    // on device, and rewriting it is a separate, reviewable change.
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'react-hooks/refs': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/static-components': 'warn',
    },
  },
  {
    /**
     * No user-facing sentence is written in a screen (UC-2.R1 #171).
     *
     * The acceptance criterion names `i18next/no-literal-string` on the
     * onboarding tree. Onboarding is where it matters most: it is the first
     * thing an Arabic or Hebrew speaker sees, and it is the flow whose copy was
     * written last and fastest. A literal there is not a cosmetic bug — it is an
     * English sentence shown to somebody who did not choose English, on the
     * screen that decides whether they keep the app.
     *
     * It is an `error`, not a `warn`, because the 71 warnings this config
     * already carries are reviewed, load-bearing exceptions. A seventy-second
     * would be invisible.
     *
     * `jsx-text-only` is the narrow mode on purpose: it catches the thing the
     * criterion is about — a sentence sitting between two JSX tags — without
     * arguing about every `testID`, style token and accessibility role, which
     * are strings nobody reads.
     */
    files: ['src/features/onboarding/**/*.{ts,tsx}'],
    ignores: ['src/features/onboarding/__tests__/**'],
    plugins: { i18next },
    rules: {
      'i18next/no-literal-string': [
        'error',
        {
          mode: 'jsx-text-only',
          message: 'User-facing text belongs in src/i18n/locales/*.json, not in a screen (UC-2.R1 #171).',
        },
      ],
    },
  },
]);
