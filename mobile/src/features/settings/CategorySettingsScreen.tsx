/**
 * Settings → Categories (#415).
 *
 * ── Two controls, and they are not the same question ─────────────
 *
 * "Do I want my lists split?" and "which parts of my life does this app know
 * about?" are separate answers, and the screen keeps them separate. Somebody
 * can narrow the catalog to the two categories they actually have without ever
 * turning the filter bar on — the app sorts quietly from then on, so the day
 * they do turn the bar on their commitments are already filed rather than
 * sitting in one heap.
 *
 * Collapsing the two into a single switch was the obvious design and it is
 * wrong: it would mean a user cannot try the split for an evening without also
 * deciding, in the same tap, which six categories describe their life.
 *
 * ── Nothing moves until the server agrees ────────────────────────
 *
 * `ServerToggle` holds this rule and the reason it exists applies here: these
 * switches decide how somebody's own words are sorted, and a switch that
 * flipped optimistically would tell them their captures are being filed a
 * particular way before anything had agreed to it.
 *
 * ── Turning everything off is an answer, not an error ────────────
 *
 * The screen says what it means and leaves it alone. Re-enabling a category
 * because the set went empty would be the product overruling a sentence the
 * user just said.
 */
import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { Card, Txt } from '../../ui/primitives';
import { Screen, ScreenScroll } from '../../ui/screen';
import { SettingsHeader } from './SettingsChrome';
import { ServerToggle } from './ServerToggle';
import { useCategoryPreferences, useSetCategoryPreferences } from '../../api/queries';
import type { CategoryPreferences } from '../../api/schemas/categories';

type Category = CategoryPreferences['enabled'][number];

/**
 * The catalog, in the order the chips are drawn.
 *
 * The same order the server filters by, so the settings screen and the filter
 * bar list the categories identically. A user who sees Work first here and
 * Health first there has two different mental models of one list.
 */
const CATALOG: readonly Category[] = ['work', 'family', 'health', 'finance', 'social', 'errands'];

const LABEL: Record<Category, string> = {
  work: 'catWork',
  family: 'catFamily',
  health: 'catHealth',
  finance: 'catFinance',
  social: 'catSocial',
  errands: 'catErrands',
};

export function CategorySettingsScreen({ onBack }: { onBack: () => void }) {
  const { t, p } = useApp();
  const preferences = useCategoryPreferences();
  const save = useSetCategoryPreferences();
  const strings = t as unknown as Record<string, string>;

  const current = preferences.data?.categoryPreferences;

  /**
   * Sends a whole preference and reports whether the server took it.
   *
   * `ServerToggle` reads the boolean to decide whether to show its failure
   * line, so a rejected write has to come back as `false` rather than as a
   * thrown error nobody catches.
   */
  const write = async (next: CategoryPreferences): Promise<boolean> => {
    try {
      await save.mutateAsync(next);
      return true;
    } catch {
      return false;
    }
  };

  const setGrouping = (grouping: boolean) =>
    write({ enabled: current?.enabled ?? [], grouping });

  const setCategory = (category: Category, on: boolean) => {
    const kept = current?.enabled ?? [];
    // Rebuilt from the catalog rather than pushed onto the end, so the order
    // the server stores does not depend on the order the user happened to tap.
    const enabled = CATALOG.filter((candidate) =>
      candidate === category ? on : kept.includes(candidate),
    );
    return write({ enabled, grouping: current?.grouping ?? false });
  };

  return (
    <Screen pinned={<SettingsHeader title={t.settingsParts} onBack={onBack} />}>
      <ScreenScroll bottom={130}>
        <Txt size={14} color={p.mu} lh={1.5}>{t.catSettingsBody}</Txt>

        {current === undefined ? (
          <ActivityIndicator testID="category-settings-loading" color={p.ac} />
        ) : (
          <>
            <Card pad={0} style={{ overflow: 'hidden' }}>
              <ServerToggle
                testID="category-split-toggle"
                title={t.catSettingsSplit}
                body={t.catSettingsSplitHint}
                value={current.grouping}
                onChange={setGrouping}
              />
            </Card>

            <View style={{ gap: 6 }}>
              <Txt size={15} weight={600}>{t.catSettingsWhich}</Txt>
              <Txt size={13} color={p.mu} lh={1.5}>{t.catSettingsWhichHint}</Txt>
            </View>

            <Card pad={0} style={{ overflow: 'hidden' }}>
              {CATALOG.map((category) => (
                <ServerToggle
                  key={category}
                  testID={`category-toggle-${category}`}
                  title={strings[LABEL[category]]!}
                  value={current.enabled.includes(category)}
                  onChange={(on) => setCategory(category, on)}
                />
              ))}
            </Card>

            {current.enabled.length === 0 ? (
              <Txt size={13} color={p.mu} lh={1.5}>{t.catSettingsNone}</Txt>
            ) : null}
          </>
        )}
      </ScreenScroll>
    </Screen>
  );
}
