import type en from './locales/en.json';

// Makes every `t(...)` key-checked against the English locale file, which is the
// template: `t('notAKey')` is a compile error, not an empty string at runtime.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof en };
  }
}
