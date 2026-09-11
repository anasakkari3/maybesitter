import { useEffect } from 'react';
import { Linking } from 'react-native';
import type { Lang } from './i18n/strings';
import type { ThemePref } from './state/types';

// maybesitter://<screen>[?lang=ar|en&theme=system|light|dark]
// In Expo Go the same path arrives as exp://host:port/--/<screen>?…
// Used by the home-screen widget later, and to open any design state directly.
export function parseLink(url: string): { name: string; lang?: Lang; theme?: ThemePref } | null {
  const afterScheme = url.includes('/--/') ? url.split('/--/')[1] : url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  if (afterScheme == null) return null;
  const [path = '', query = ''] = afterScheme.split('?');
  const name = path.replace(/^\/+|\/+$/g, '');
  const params = new URLSearchParams(query);
  const lang = params.get('lang');
  const theme = params.get('theme');
  // The keys are left out entirely when the link doesn't carry them, rather
  // than set to undefined, so a link never overwrites a stored preference.
  const link: { name: string; lang?: Lang; theme?: ThemePref } = { name };
  if (lang === 'ar' || lang === 'en') link.lang = lang;
  if (theme === 'system' || theme === 'light' || theme === 'dark') link.theme = theme;
  return link;
}

export function useLinks(handlers: {
  jump: (name: string) => void;
  setLang: (l: Lang) => void;
  setThemePref: (t: ThemePref) => void;
}) {
  useEffect(() => {
    const apply = (url: string | null) => {
      if (!url) return;
      const link = parseLink(url);
      if (!link) return;
      if (link.lang) handlers.setLang(link.lang);
      if (link.theme) handlers.setThemePref(link.theme);
      if (link.name) handlers.jump(link.name);
    };
    Linking.getInitialURL().then(apply).catch(() => {});
    const sub = Linking.addEventListener('url', e => apply(e.url));
    return () => sub.remove();
    // handlers are recreated each render; the subscription only needs to exist once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
