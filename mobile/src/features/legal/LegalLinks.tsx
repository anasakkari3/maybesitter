import React, { useState } from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { fill } from '../../i18n/strings';
import { Btn, Card, Txt } from '../../ui/primitives';
import { openLegal, privacyPolicyUrl, termsUrl } from '../../config/legalLinks';

/**
 * The Legal group in Settings (UC-4.2, #177).
 *
 * ── It disappears rather than 404s ───────────────────────────────
 *
 * The domain is not bought yet (OWNER-A1, #137). With no configured base URL
 * every link is null and this renders nothing at all — not a greyed-out row,
 * not "coming soon". A row that looks tappable and is not is a smaller lie
 * than a dead link, but it is still one, and Settings is where somebody goes
 * *because* they want to check what we do with their data.
 *
 * ── A failure shows the address ──────────────────────────────────
 *
 * If the in-app browser refuses — no browser, or the user is offline — the row
 * shows the URL as text. Somebody can then write it down or open it later,
 * which is strictly more useful than a toast that says "something went wrong".
 */
export function LegalLinks() {
  const { t, p, lang } = useApp();
  const [failed, setFailed] = useState<string | null>(null);

  const rows = ([
    ['privacy', t.legalPrivacyPolicy, privacyPolicyUrl(lang)],
    ['terms', t.legalTerms, termsUrl(lang)],
  ] as const).filter(([, , url]) => url !== null);

  if (rows.length === 0) return null;

  return (
    <Card pad={0} style={{ overflow: 'hidden' }}>
      <View style={{ paddingHorizontal: 18, paddingTop: 16, paddingBottom: 6 }}>
        <Txt size={13} weight={600} color={p.mu}>{t.legalSectionTitle}</Txt>
      </View>
      {rows.map(([key, label, url], index) => (
        <Btn
          key={key}
          // `link`, not `button`: VoiceOver and TalkBack then say "link", which
          // is what tells somebody they are about to leave the app.
          label={`${label}. ${t.legalOpensInBrowser}`}
          scaleTo={0.98}
          onPress={() => {
            void openLegal(url).then(opened => setFailed(opened ? null : url));
          }}
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            paddingVertical: 16,
            paddingHorizontal: 18,
            minHeight: 52,
            borderTopWidth: 1,
            borderTopColor: p.ln,
            borderBottomWidth: index < rows.length - 1 ? 0 : 0,
          }}
        >
          <Txt size={15} testID={`settings-${key === 'privacy' ? 'privacy-policy' : 'terms'}`}>{label}</Txt>
          <Txt size={13} color={p.mu}>{t.legalOpensInBrowser}</Txt>
        </Btn>
      ))}
      {failed ? (
        <View style={{ paddingHorizontal: 18, paddingBottom: 14 }}>
          <Txt size={13} color={p.mu} selectable testID="legal-open-failed">
            {fill(t.legalUnavailable, { url: failed })}
          </Txt>
        </View>
      ) : null}
    </Card>
  );
}
