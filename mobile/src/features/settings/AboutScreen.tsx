import React from 'react';
import { ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import { useApp } from '../../state/AppContext';
import { Card, Txt } from '../../ui/primitives';
import { ScreenIn } from '../../ui/motion';
import { SettingsHeader, SettingsRow } from './SettingsChrome';
import { openLegal, privacyPolicyUrl, termsUrl } from '../../config/legalLinks';
import { testCrashEnabled } from '../../config/env';
import { triggerTestCrash } from '../../lib/crash';

/**
 * About (UC-2.R4, #174).
 *
 * Version and build, and the legal links again — somebody looking for the
 * privacy policy will look here as readily as in the Legal group, and a second
 * route to it costs one row.
 *
 * The version is read from the running build's own config rather than from a
 * constant this repository would have to remember to bump: a stale version
 * string on a support screen is a bug report nobody can reproduce.
 *
 * #174 names `expo-application`, which is not a dependency here. `expo-config`
 * already is, and `expoConfig.version` is the same number `app.config.ts`
 * sets — so this reads it rather than adding a native module for one string.
 */
export function AboutScreen({ onBack }: { onBack: () => void }) {
  const { t, p, lang } = useApp();
  const insets = useSafeAreaInsets();
  const version = Constants.expoConfig?.version ?? '—';
  const build = Constants.expoConfig?.ios?.buildNumber
    ?? (Constants.expoConfig?.android?.versionCode !== undefined
      ? String(Constants.expoConfig.android.versionCode)
      : null);
  const privacy = privacyPolicyUrl(lang);
  const terms = termsUrl(lang);
  /*
   * The hidden test-crash rows (UC-4.4, #180 step 8).
   *
   * Off unless `EXPO_PUBLIC_ENABLE_TEST_CRASH=true`, and never present in a
   * production build at all: `releaseConfigProblems` fails the *build* when
   * that variable is set for production, so no binary a user can install has
   * these rows compiled into a reachable branch. See src/config/env.ts.
   *
   * They exist because the two symbolication criteria have no other way to be
   * met — somebody has to cause a crash in a release build on purpose, and
   * then look for real frames in Crashlytics. One row per criterion: native
   * frames come from the dSYM and the R8 mapping, JS frames from the Hermes
   * source map the build exported.
   *
   * The labels are deliberately not in `locales/` — they are a developer
   * affordance that no user ever sees, and translating them would put
   * unreviewed Arabic into the approved round-1 copy for a row that crashes
   * the app.
   */
  const testCrash = testCrashEnabled();

  return (
    <ScreenIn style={{ backgroundColor: p.bg }}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 60, gap: 14 }}>
        <SettingsHeader title={t.settingsAbout} onBack={onBack} />
        <Card pad={18} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Txt size={15}>{t.aboutVersion}</Txt>
          <Txt size={15} color={p.mu} latin selectable testID="about-version">
            {build ? `${version} (${build})` : version}
          </Txt>
        </Card>
        {privacy || terms ? (
          <Card pad={0} style={{ overflow: 'hidden' }}>
            {privacy ? (
              <SettingsRow label={t.legalPrivacyPolicy} value={t.legalOpensInBrowser} onPress={() => void openLegal(privacy)} testID="about-privacy" />
            ) : null}
            {terms ? (
              <SettingsRow label={t.legalTerms} value={t.legalOpensInBrowser} onPress={() => void openLegal(terms)} testID="about-terms" />
            ) : null}
          </Card>
        ) : null}
        {testCrash ? (
          <Card pad={0} style={{ overflow: 'hidden' }}>
            <SettingsRow
              label="Force a native crash (test)"
              onPress={() => triggerTestCrash('native')}
              testID="about-test-crash-native"
              tone="warn"
            />
            <SettingsRow
              label="Throw a JavaScript error (test)"
              onPress={() => triggerTestCrash('javascript')}
              testID="about-test-crash-js"
              tone="warn"
            />
          </Card>
        ) : null}
      </ScrollView>
    </ScreenIn>
  );
}
