import React, { useEffect, useState } from 'react';
import { BackHandler, Platform, TextInput, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useApp } from '../../state/AppContext';
import { useTimeZone } from '../../i18n/timezone';
import { fill } from '../../i18n/strings';
import { family } from '../../theme/fonts';
import { useLayoutMode } from '../../theme/textScale';
import { Btn, Card, Txt } from '../../ui/primitives';
import { EmptyState, Tag } from '../../ui/chrome';
import { Dialog } from '../../ui/dialog';
import { LiveRegion } from '../../ui/liveRegion';
import { Screen, ScreenScroll } from '../../ui/screen';
import { QueryBoundary } from '../../api/ui/QueryBoundary';
import { useCreateWeeklyBlock, useDeleteWeeklyBlock, usePatchWeeklyBlock, useWeeklyBlocks } from '../../api/queries';
import type { WeeklyBlock } from '../../api/schemas/weeklyBlocks';
import type { WeeklyBlockPatch } from '../../api/endpoints/weeklyBlocks';
import { SettingsHeader } from '../settings/SettingsChrome';
import { ServerToggle } from '../settings/ServerToggle';
import { timeShowing, timeShown } from '../plan/pickerClock';
import { weeklyA11yLabel, weeklyLine } from './weeklyText';
import { isolateAuto } from '../../i18n/bidi';
import { patchFor, validateWeeklyDraft, weeklyErrorKey, type WeeklyDraft } from './weeklyForm';

/**
 * Settings → «الثابت الأسبوعي» (weekly fixed blocks).
 *
 * Every block with its days and hours and whether it is on; a tap opens it to
 * change its name, days or hours; the switch pauses and resumes it (the
 * server's answer, never an optimistic flip — `ServerToggle`); delete is
 * behind the app's one confirmation `Dialog`. «أضف» makes one by hand, and
 * the button that saves it is the confirmation the server requires
 * (`confirmation.confirmedByUserAt`): nothing exists before it is pressed.
 *
 * The same hours on the same day are the rule the server keeps — an end
 * before its start is refused as `overnight_not_supported` — and this form
 * says so before sending, and again, in the person's language, if the server
 * says it.
 */
export function WeeklyBlocksScreen({ onBack }: { onBack: () => void }) {
  const { t, p, lang } = useApp();
  const blocks = useWeeklyBlocks();
  const patch = usePatchWeeklyBlock();
  const [editing, setEditing] = useState<WeeklyBlock | 'new' | null>(null);

  if (editing !== null) {
    return <WeeklyBlockEditor block={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />;
  }

  const items = blocks.data ?? [];
  return (
    <Screen pinned={<SettingsHeader title={t.wbTitle} onBack={onBack} />} testID="weekly-blocks">
      <ScreenScroll testID="weekly-blocks-scroll">
        <Txt role="supporting" color={p.mu} lh={1.5}>{t.wbIntro}</Txt>
        <QueryBoundary isPending={blocks.isPending} error={blocks.error} onRetry={() => void blocks.refetch()}>
          {items.length === 0 ? (
            <EmptyState testID="weekly-blocks-empty" title={t.wbEmptyTitle} body={t.wbEmptyBody} top={24} />
          ) : (
            <View style={{ gap: 12 }}>
              {items.map((block) => {
                const paused = block.status !== 'active';
                return (
                  <Card key={block.id} pad={0} style={{ overflow: 'hidden' }} testID={`weekly-block-${block.id}`}>
                    <Btn
                      testID={`weekly-block-open-${block.id}`}
                      label={`${weeklyA11yLabel(block, lang)}${paused ? `${t.wbListSep}${t.wbPaused}` : ''}`}
                      hint={t.wbEditTitle}
                      onPress={() => setEditing(block)}
                      scaleTo={0.99}
                      style={{ alignItems: 'flex-start', gap: 6, paddingVertical: 16, paddingHorizontal: 18, borderBottomWidth: 1, borderBottomColor: p.ln }}
                    >
                      <Txt role="card" color={paused ? p.mu : p.tx}>{block.title}</Txt>
                      <Txt size={14} color={p.mu} testID={`weekly-block-when-${block.id}`}>{weeklyLine(block, lang, { withTitle: false })}</Txt>
                      {paused ? <Tag kind="muted" label={t.wbPaused} testID={`weekly-block-paused-${block.id}`} /> : null}
                    </Btn>
                    <ServerToggle
                      testID={`weekly-block-active-${block.id}`}
                      title={t.wbActiveToggle}
                      accessibilityLabel={`${t.wbActiveToggle}${t.wbListSep}${block.title}`}
                      body={paused ? t.wbActiveBody : undefined}
                      value={!paused}
                      onChange={async (next) => {
                        const saved = await patch.mutateAsync({ id: block.id, patch: { status: next ? 'active' : 'paused' } });
                        return saved.status === (next ? 'active' : 'paused');
                      }}
                    />
                  </Card>
                );
              })}
            </View>
          )}
        </QueryBoundary>
        <Btn
          testID="weekly-blocks-add"
          label={t.wbAdd}
          onPress={() => setEditing('new')}
          style={{ minHeight: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: p.ln, backgroundColor: p.sf, paddingHorizontal: 16 }}
        >
          <Txt size={15} weight={600} color={p.ac}>{t.wbAdd}</Txt>
        </Btn>
      </ScreenScroll>
    </Screen>
  );
}

const NEW_DRAFT: WeeklyDraft = { title: '', weekdays: [], start: '09:00', end: '17:00' };

function WeeklyBlockEditor({ block, onDone }: { block: WeeklyBlock | null; onDone: () => void }) {
  const { t, p, lang, script, rtl } = useApp();
  const timezone = useTimeZone();
  const stacked = useLayoutMode() !== 'normal';
  const create = useCreateWeeklyBlock();
  const patch = usePatchWeeklyBlock();
  const remove = useDeleteWeeklyBlock();
  const [draft, setDraft] = useState<WeeklyDraft>(block
    ? { title: block.title, weekdays: [...block.weekdays], start: block.start, end: block.end }
    : NEW_DRAFT);
  const [picking, setPicking] = useState<'start' | 'end' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const busy = create.isPending || patch.isPending || remove.isPending;

  // Android's back closes the form, not the whole screen.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onDone(); return true; });
    return () => sub.remove();
  }, [onDone]);

  const toggleDay = (day: number) => setDraft((current) => ({
    ...current,
    weekdays: current.weekdays.includes(day) ? current.weekdays.filter((d) => d !== day) : [...current.weekdays, day].sort((a, b) => a - b),
  }));

  const save = async () => {
    if (busy) return;
    const invalid = validateWeeklyDraft(draft);
    if (invalid) { setError(t[invalid]); return; }
    setError(null);
    try {
      if (block) {
        const changes: WeeklyBlockPatch = patchFor(block, draft);
        if (Object.keys(changes).length > 0) await patch.mutateAsync({ id: block.id, patch: changes });
      } else {
        await create.mutateAsync({
          title: draft.title.trim(),
          weekdays: draft.weekdays,
          start: draft.start,
          end: draft.end,
          timezone,
          // This press is the confirmation: the person has just read the block
          // back and chosen to keep it every week.
          confirmedByUserAt: new Date().toISOString(),
        });
      }
      onDone();
    } catch (caught) {
      setError(t[weeklyErrorKey(caught)]);
    }
  };

  const del = async () => {
    if (!block) return;
    try {
      await remove.mutateAsync(block.id);
      setConfirmDelete(false);
      onDone();
    } catch (caught) {
      setConfirmDelete(false);
      setError(t[weeklyErrorKey(caught)]);
    }
  };

  const timeRow = (which: 'start' | 'end') => (
    <Btn
      testID={`weekly-edit-${which}`}
      label={`${which === 'start' ? t.wbFieldStart : t.wbFieldEnd} ${draft[which]}`}
      onPress={() => setPicking(picking === which ? null : which)}
      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 52, paddingHorizontal: 16, borderRadius: 16, backgroundColor: p.sf2, gap: 12 }}
    >
      <Txt size={15}>{which === 'start' ? t.wbFieldStart : t.wbFieldEnd}</Txt>
      <Txt size={16} weight={600} latin testID={`weekly-edit-${which}-value`}>{draft[which]}</Txt>
    </Btn>
  );

  return (
    <Screen
      pinned={<SettingsHeader title={block ? t.wbEditTitle : t.wbNewTitle} onBack={onDone} />}
      testID="weekly-edit"
      overlay={confirmDelete && block ? (
        <Dialog
          testID="weekly-delete-dialog"
          title={fill(t.wbDeleteTitle, { title: block.title })}
          body={t.wbDeleteBody}
          confirmLabel={t.wbDeleteConfirm}
          cancelLabel={t.cancel}
          onConfirm={() => void del()}
          onCancel={() => setConfirmDelete(false)}
          busy={remove.isPending}
          confirmTestID="weekly-delete-confirm"
          cancelTestID="weekly-delete-cancel"
        />
      ) : null}
    >
      <ScreenScroll testID="weekly-edit-scroll" automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled">
        <View style={{ gap: 8 }}>
          <Txt size={13} weight={600} color={p.mu}>{t.wbFieldTitle}</Txt>
          <TextInput
            testID="weekly-edit-title"
            accessibilityLabel={t.wbFieldTitle}
            placeholder={t.wbFieldTitlePlaceholder}
            placeholderTextColor={p.mu}
            value={draft.title}
            maxLength={120}
            returnKeyType="done"
            onChangeText={(title) => setDraft((current) => ({ ...current, title }))}
            style={{ backgroundColor: p.sf2, borderRadius: 16, paddingVertical: 12, paddingHorizontal: 16, fontSize: 16, minHeight: 52, color: p.tx, fontFamily: family(400, script), textAlign: rtl ? 'right' : 'left' }}
          />
        </View>

        <View style={{ gap: 8 }}>
          <Txt size={13} weight={600} color={p.mu}>{t.wbFieldDays}</Txt>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }} accessibilityLabel={t.wbFieldDays}>
            {[0, 1, 2, 3, 4, 5, 6].map((day) => {
              const on = draft.weekdays.includes(day);
              return (
                <Btn
                  key={day}
                  testID={`weekly-edit-day-${day}`}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  label={t.days[day]!}
                  onPress={() => toggleDay(day)}
                  scaleTo={0.95}
                  style={{
                    minHeight: 44, minWidth: 44, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 999,
                    alignItems: 'center', justifyContent: 'center',
                    backgroundColor: on ? p.acs : p.sf, borderWidth: on ? 2 : 1, borderColor: on ? p.acd : p.ln,
                  }}
                >
                  <Txt size={14} weight={on ? 600 : 400} color={on ? p.acd : p.tx}>{t.wbDays[day]!}</Txt>
                </Btn>
              );
            })}
          </View>
        </View>

        <View style={{ gap: 8, flexDirection: stacked ? 'column' : 'row' }}>
          <View style={stacked ? undefined : { flex: 1 }}>{timeRow('start')}</View>
          <View style={stacked ? undefined : { flex: 1 }}>{timeRow('end')}</View>
        </View>
        {picking ? (
          <DateTimePicker
            testID="weekly-edit-picker"
            value={timeShowing(draft[picking])}
            mode="time"
            minuteInterval={5}
            // `start`/`end` are `HH:MM` on the block's own clock face; the wheel
            // works in wall-clock terms and the answer is read straight back.
            is24Hour
            display={Platform.OS === 'ios' ? 'spinner' : 'default'}
            onChange={(event, value) => {
              const which = picking;
              if (Platform.OS !== 'ios') setPicking(null);
              if (event.type === 'dismissed' || !value) return;
              setDraft((current) => ({ ...current, [which]: timeShown(value) }));
            }}
          />
        ) : null}

        {/* The block as it will be kept, read back before it is saved. */}
        {draft.weekdays.length > 0 && draft.title.trim() !== '' ? (
          <View accessible accessibilityLabel={weeklyA11yLabel({ ...draft, title: draft.title.trim() }, lang)} style={{ backgroundColor: p.sf2, borderRadius: 16, padding: 14, gap: 2 }}>
            {/* The title on its own line, as on the review card (u37). */}
            <Txt size={14} weight={600} testID="weekly-edit-preview-title">{isolateAuto(draft.title.trim())}</Txt>
            <Txt size={13} testID="weekly-edit-preview">{weeklyLine(draft, lang, { withTitle: false })}</Txt>
          </View>
        ) : null}

        <LiveRegion testID="weekly-edit-error-live">
          {error ? <Txt size={14} color={p.wm} weight={600} testID="weekly-edit-error">{error}</Txt> : null}
        </LiveRegion>

        <Btn
          testID="weekly-edit-save"
          label={block ? t.memorySave : t.wbSaveNew}
          onPress={() => void save()}
          disabled={busy}
          style={{ backgroundColor: p.ac, borderRadius: 16, minHeight: 52, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 }}
        >
          <Txt size={16} weight={600} color={p.onAccent}>{block ? t.memorySave : t.wbSaveNew}</Txt>
        </Btn>
        {block ? (
          <Btn
            testID="weekly-edit-delete"
            label={t.wbDelete}
            onPress={() => setConfirmDelete(true)}
            disabled={busy}
            style={{ borderRadius: 16, minHeight: 52, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: p.ln, paddingHorizontal: 16 }}
          >
            <Txt size={15} color={p.tx}>{t.wbDelete}</Txt>
          </Btn>
        ) : null}
      </ScreenScroll>
    </Screen>
  );
}
