// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', '.expo/*', 'node_modules/*'],
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
]);
