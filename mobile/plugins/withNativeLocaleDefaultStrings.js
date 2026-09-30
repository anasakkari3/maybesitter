const { AndroidConfig, withStringsXml } = require('@expo/config-plugins');
const localizedIosKeys = Object.keys(require('../locales/native/ar.json'));

/**
 * Expo's top-level locales are for iOS permission prompts, but CNG also writes
 * those keys to Android's Arabic and Hebrew resources. Android release lint
 * requires every translated key to exist in values/strings.xml. These keys are
 * never read on Android; the default entries only make the generated resource
 * set complete without weakening lint for actual Android copy.
 */
function withNativeLocaleDefaultStrings(config) {
  return withStringsXml(config, modConfig => {
    const items = localizedIosKeys.map(name => ({
      $: { name },
      _: name === 'CFBundleDisplayName' ? config.name : 'Used by iOS permission prompts',
    }));
    modConfig.modResults = AndroidConfig.Strings.setStringItem(items, modConfig.modResults);
    return modConfig;
  });
}

module.exports = withNativeLocaleDefaultStrings;
