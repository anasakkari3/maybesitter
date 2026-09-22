import React from 'react';
import { ScrollView, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { LANGUAGE_ENDONYM, LANGUAGE_OPTIONS, type LanguagePref } from '../../i18n/language';
import type { ThemePref } from '../../state/types';
import { Btn, Card, Txt } from '../../ui/primitives';
import { SectionLabel } from '../../ui/chrome';
import { ScreenIn } from '../../ui/motion';
import { SettingsHeader } from './SettingsChrome';
import { CheckIcon } from '../../ui/icons';

/**
 * Language and appearance, as pickers (Round 2, Phase I).
 *
 * Round 1 cycled each value on a row tap — three themes and four language
 * choices, with no way to see the options before committing, and in a
 * right-to-left layout no way to tell which way the cycle went. Here every
 * option is a radio row; the chosen one is marked; a language is named in
 * itself, never translated.
 */
export function LangAppearanceScreen({ onBack }: { onBack: () => void }) {
  const { t, p, langPref, themePref, actions } = useApp();
  const themes: { value: ThemePref; label: string }[] = [
    { value: 'system', label: t.vSystem }, { value: 'light', label: t.vLight }, { value: 'dark', label: t.vDark },
  ];
  return (
    <ScreenIn style={{ backgroundColor: p.bg }}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 60, gap: 16 }}>
        <SettingsHeader title={t.langAppearanceTitle} onBack={onBack} />
        <View style={{ gap: 6 }}>
          <SectionLabel>{t.langAppearanceLanguage}</SectionLabel>
          <Card pad={0} style={{ paddingHorizontal: 16 }} testID="lang-picker">
            {LANGUAGE_OPTIONS.map((option, index) => (
              <Radio key={option} first={index === 0} selected={langPref === option} label={option === 'system' ? t.vSystem : LANGUAGE_ENDONYM[option as Exclude<LanguagePref, 'system'>]} onPress={() => actions.setLangPref(option)} testID={`lang-option-${option}`} />
            ))}
          </Card>
        </View>
        <View style={{ gap: 6 }}>
          <SectionLabel>{t.langAppearanceTheme}</SectionLabel>
          <Card pad={0} style={{ paddingHorizontal: 16 }} testID="theme-picker">
            {themes.map((option, index) => (
              <Radio key={option.value} first={index === 0} selected={themePref === option.value} label={option.label} onPress={() => actions.setThemePref(option.value)} testID={`theme-option-${option.value}`} />
            ))}
          </Card>
        </View>
      </ScrollView>
    </ScreenIn>
  );
}

function Radio({ label, selected, onPress, testID, first }: { label: string; selected: boolean; onPress: () => void; testID: string; first: boolean }) {
  const { p } = useApp();
  return (
    <Btn label={label} onPress={onPress} accessibilityRole="radio" testID={testID} scaleTo={0.98}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, minHeight: 52, borderTopWidth: first ? 0 : 1, borderTopColor: p.ln }}>
      <Txt size={15} weight={selected ? 600 : 400} style={{ flex: 1 }}>{label}</Txt>
      <View style={{ width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: selected ? p.ac : 'transparent', borderWidth: selected ? 0 : 2, borderColor: p.lnStrong }}>
        {selected ? <CheckIcon size={12} color={p.onAccent} /> : null}
      </View>
    </Btn>
  );
}
