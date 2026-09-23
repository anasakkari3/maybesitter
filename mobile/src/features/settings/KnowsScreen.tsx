import React from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { useTimeZone } from '../../i18n/timezone';
import { Card, Txt } from '../../ui/primitives';
import { Screen, ScreenScroll } from '../../ui/screen';
import { QueryBoundary } from '../../api/ui/QueryBoundary';
import { useProfile, useTrust } from '../../api/queries';
import { SettingsHeader, SettingsRow } from './SettingsChrome';
import { MemorySection } from '../memory/MemorySection';
import { fill, ltr } from '../../i18n/strings';
import { formatDate } from '../../i18n/format';

/**
 * What MaybeSitter knows (UC-2.R4 #174, memory from UC-2.7a #167).
 *
 * ── A "never" claim is only printed if the server agrees ─────────
 *
 * The three "it never does this" lines are static copy, and static copy about
 * somebody's privacy is exactly the kind that goes on being displayed after it
 * stops being true. So each is rendered only while the server's `whatKnows`
 * says so; if the server ever reports `privateMessageIngestion: true`, the
 * matching line disappears rather than contradicting it.
 *
 * The screen would rather show less than show something false. That is also
 * why nothing here renders while the query is still loading: an unanswered
 * "we never read your messages" is a promise made on no authority.
 */
export function KnowsScreen({
  onBack, onMemory, onImport,
}: {
  onBack: () => void;
  onMemory?: (() => void) | undefined;
  onImport?: (() => void) | undefined;
}) {
  const { t, p, lang } = useApp();
  const timeZone = useTimeZone();
  const trust = useTrust();
  const profile = useProfile();
  const knows = trust.data?.whatKnows;

  // The date of the last import, when there was one. A row that said only
  // "bring my AI context" to somebody who already did would read as though
  // nothing had happened.
  const lastImport = profile.data?.aiContextImport ?? null;
  const importSub = lastImport
    // `ltr` because a date inside Arabic text reorders without it — the same
    // rule every other date in this app goes through.
    ? fill(t.aiImportLastImported, {
      date: ltr(formatDate(new Date(lastImport.lastImportedAt), 'short', { locale: lang, timeZone })),
    })
    : t.aiImportEntrySub;

  const nevers = knows
    ? ([
      ['messages', t.knowsNeverMessages, knows.privateMessageIngestion === false],
      ['inference', t.knowsNeverInference, knows.sensitiveInference === false],
      ['medical', t.knowsNeverMedical, knows.medicalProfile === false],
    ] as const).filter(([, , holds]) => holds)
    : [];

  return (
    <Screen pinned={<SettingsHeader title={t.settingsKnows} onBack={onBack} />}>
      <ScreenScroll>
        <QueryBoundary isPending={trust.isPending} error={trust.error} onRetry={() => void trust.refetch()}>

        {knows ? (
          <Card pad={18} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Txt size={15} style={{ flex: 1 }}>{t.knowsCommitments}</Txt>
            <Txt size={17} weight={600} latin testID="knows-commitment-count">
              {String(knows.confirmedCommitmentCount)}
            </Txt>
          </Card>
        ) : null}

        {/* Hidden entirely when the memory feature is off — the section asks
            the server, and a 404 means there is no such thing to show.
            `onMemory` opens the full screen (UC-3.16, #202): the same records,
            grouped by who asserted them, each one able to say why it is there.
            Optional, so a caller that has no screen to open simply shows the
            card it always did. */}
        <MemorySection {...(onMemory ? { onOpen: onMemory } : {})} />

        {/* Under the memory section rather than above it: the first thing this
            screen answers is what MaybeSitter knows, and bringing more in is an
            action about that, not a heading over it. Optional, so a caller with
            no screen to open shows the memory card exactly as before. */}
        {onImport ? (
          <Card pad={0}>
            <SettingsRow
              first
              label={t.aiImportTitle}
              sub={importSub}
              onPress={onImport}
              testID="knows-ai-import"
            />
          </Card>
        ) : null}

        {nevers.length > 0 ? (
          <Card pad={18} style={{ gap: 10 }} testID="knows-never">
            <Txt role="card">{t.knowsNeverHeading}</Txt>
            {nevers.map(([key, line]) => (
              <View key={key} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
                <Txt size={14} color={p.mu}>·</Txt>
                <Txt size={14} color={p.mu} lh={1.5} style={{ flex: 1 }} testID={`knows-never-${key}`}>{line}</Txt>
              </View>
            ))}
          </Card>
        ) : null}
        </QueryBoundary>
      </ScreenScroll>
    </Screen>
  );
}
