import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../../state/AppContext';
import { isolate } from '../../i18n/bidi';
import { formatDate } from '../../i18n/format';
import { useTimeZone } from '../../i18n/timezone';
import { Btn, Card, Txt } from '../../ui/primitives';
import { ScreenIn } from '../../ui/motion';
import { userFacingMessage } from '../../api/ui/userFacingMessage';
import {
  useDeleteAllMemory,
  useDeleteMemory,
  useMemory,
  useMemorySuggestion,
  usePatchMemory,
} from '../../api/queries';
import type { MemoryAdaptive, MemoryItem, MemorySuggestion } from '../../api/schemas/profile';
import { SettingsHeader } from '../settings/SettingsChrome';
import { memorySentence } from './memoryDisplay';
import {
  ADAPTIVE_CLASS_STRING,
  CONFIDENCE_STRING,
  GROUP_STRING,
  MEMORY_GROUP_ORDER,
  SOURCE_LABEL_STRING,
  confidenceBand,
  evidenceLines,
  fill,
  groupOf,
  type MemoryGroup,
} from './memoryProvenance';

/**
 * Everything MaybeSitter remembers, where each piece came from, and the way
 * out of it (UC-3.16, #202).
 *
 * `MemorySection` on Settings → Trust → Knows is the short version and stays
 * what it was: the list and the four controls. This is the long one, and the
 * difference is not length — it is that every row here can be asked *why*, and
 * answers with dates and a count rather than with an adjective.
 *
 * ── "Why?" answers from the record, or says it cannot ────────────
 *
 * The lines come from `evidenceLines`, which is built only from fields the
 * server actually sends. Where there is nothing behind a fact but the user
 * having typed it, the panel says so — «ما في إشي انراقب لطلع منه هاد» — rather
 * than filling the space. The one thing a transparency screen must never do is
 * imply more evidence than exists, and an empty "Why?" would read as the app
 * declining to answer.
 *
 * ── The undo window is a courtesy, not a promise ─────────────────
 *
 * Delete removes the row immediately and holds the request for five seconds.
 * Leaving the screen inside that window **commits** the delete rather than
 * cancelling it: the user pressed Delete, saw it go, and a deletion that
 * silently did not happen because they navigated away is the worse failure of
 * the two. `flush` is that commit, and it runs on unmount.
 *
 * The row is hidden locally rather than by rewriting the query cache. The cache
 * is what the server said; while the delete has not been sent, the server still
 * has the record, and a cache edited to disagree would be a lie that survives a
 * remount.
 *
 * ── Suggestions are not memory until kept ────────────────────────
 *
 * The "Noticed, not saved" card lists what the server computed on this read
 * from what the user finished (UC-3.16, #202). Nothing in it is stored: Keep
 * asks the server to store its own sentence, in the app's language, and "Not
 * right" asks it not to offer that claim again. The share behind a suggestion
 * is never printed — the counts it came from are, which are facts about what
 * happened rather than a score.
 *
 * ── Bidi isolation is not cosmetic ───────────────────────────────
 *
 * Every rendered fact goes through `isolate` for the reason `MemorySection`
 * gives: a quiet-hours range in Latin digits inside an Arabic sentence renders
 * backwards without it. Dates in the "Why?" panel are `latin` for the same
 * reason `Txt latin` exists.
 */

/** How long a deleted row can be brought back. */
export const UNDO_WINDOW_MS = 5_000;

export function MemoryScreen({ onBack }: { onBack: () => void }) {
  const { t, p, rtl, lang } = useApp();
  const insets = useSafeAreaInsets();
  const timeZone = useTimeZone();

  const memory = useMemory();
  const patch = usePatchMemory();
  const remove = useDeleteMemory();
  const removeAll = useDeleteAllMemory();
  const decide = useMemorySuggestion();

  const [editing, setEditing] = useState<string | null>(null);
  const [why, setWhy] = useState<string | null>(null);
  const [undoable, setUndoable] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);

  // Held in a ref, not in state: the pending delete has to survive the unmount
  // that state cannot, and nothing renders from it.
  const scheduled = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  // Synced in an effect rather than assigned during render: `flush` runs from a
  // timer and from unmount, long after the render that created it, and a ref
  // written while rendering is the pattern React's own lint rule forbids.
  const removeRef = useRef(remove);
  useEffect(() => { removeRef.current = remove; });

  const flush = useCallback(() => {
    const job = scheduled.current;
    if (!job) return;
    clearTimeout(job.timer);
    scheduled.current = null;
    removeRef.current.mutate(job.id);
  }, []);

  useEffect(() => flush, [flush]);

  const scheduleDelete = useCallback((id: string) => {
    // One at a time: a second delete commits the first rather than replacing
    // it, so no row can be dropped from the screen and never from the server.
    flush();
    const timer = setTimeout(() => {
      scheduled.current = null;
      setUndoable(null);
      removeRef.current.mutate(id);
    }, UNDO_WINDOW_MS);
    scheduled.current = { id, timer };
    setUndoable(id);
  }, [flush]);

  const undo = useCallback(() => {
    const job = scheduled.current;
    if (!job) return;
    clearTimeout(job.timer);
    scheduled.current = null;
    setUndoable(null);
  }, []);

  const strings = t as unknown as Record<string, string>;
  const date = useCallback(
    (iso: string) => formatDate(new Date(iso), 'short', { locale: lang, timeZone }),
    [lang, timeZone],
  );

  // A 404 is the memory feature being off for this build. The screen still
  // renders its way back — a blank page with no exit is a worse answer than an
  // honest "nothing here".
  const items = (memory.data?.items ?? []).filter(item => item.id !== undoable);
  const suggestions = memory.data?.suggestions ?? [];
  const adaptive = memory.data?.adaptive ?? null;
  const suggestionLanguage: 'ar' | 'he' | 'en' = lang === 'ar' || lang === 'he' ? lang : 'en';

  const groups = MEMORY_GROUP_ORDER
    .map(group => [group, items.filter(item => groupOf(item) === group)] as const)
    .filter(([, rows]) => rows.length > 0);

  const failure = [patch.error, remove.error, removeAll.error, decide.error].find(error => error != null);

  return (
    <ScreenIn style={{ backgroundColor: p.bg }}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 60, gap: 14 }}>
        <SettingsHeader title={t.memoryScreenTitle} onBack={onBack} />

        {failure ? (
          <Txt size={14} color={p.wm} testID="memory-screen-error">{userFacingMessage(failure, t)}</Txt>
        ) : null}

        {undoable ? (
          <Card pad={14} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }} testID="memory-undo-bar">
            <Txt size={14} style={{ flex: 1 }}>{t.memoryDeletedNotice}</Txt>
            <Action label={t.memoryUndo} testID="memory-undo" onPress={undo} />
          </Card>
        ) : null}

        {/* Also what a 404 renders: `items` is empty either way, and the
            screen has nothing truer to say than that it holds nothing. */}
        {suggestions.length > 0 ? (
          <SuggestionsCard
            suggestions={suggestions}
            strings={strings}
            busy={decide.isPending}
            onKeep={suggestion => decide.mutate({ suggestion, decision: 'keep', language: suggestionLanguage })}
            onDismiss={suggestion => decide.mutate({ suggestion, decision: 'dismiss', language: suggestionLanguage })}
          />
        ) : null}

        {groups.length === 0 && suggestions.length === 0 ? (
          <Card pad={18}>
            <Txt size={14} color={p.mu} testID="memory-screen-empty">{t.memoryScreenEmpty}</Txt>
          </Card>
        ) : null}

        {groups.map(([group, rows]) => (
          <MemoryGroupCard
            key={group}
            group={group}
            rows={rows}
            strings={strings}
            date={date}
            rtl={rtl}
            editing={editing}
            why={why}
            onToggleWhy={id => setWhy(current => (current === id ? null : id))}
            onEdit={id => setEditing(id)}
            onCancelEdit={() => setEditing(null)}
            onSave={(id, next) => { setEditing(null); patch.mutate({ id, content: next }); }}
            onDelete={id => { setWhy(null); scheduleDelete(id); }}
          />
        ))}

        {/* Read-only on purpose (#202): the group is set from behaviour, and
            the one thing this card offers is the truth about what it changes. */}
        {adaptive ? <AdaptiveCard adaptive={adaptive} strings={strings} /> : null}

        {items.length > 0 ? (
          <Card pad={18} style={{ gap: 10 }}>
            {confirmAll ? (
              <>
                <Txt size={13} color={p.wm}>{t.memoryDeleteAllConfirm}</Txt>
                {/* Named on the confirm, not in a footnote: the behaviour log
                    is the half the user cannot see, so the one moment they can
                    be told it is going is the moment they agree to it. */}
                <Txt size={13} color={p.mu} lh={1.5} testID="memory-delete-all-also">{t.memoryDeleteAllAlso}</Txt>
                <View style={{ flexDirection: 'row', gap: 14 }}>
                  <Action
                    label={t.memoryDeleteAll}
                    testID="memory-screen-delete-all-confirm"
                    tone="warn"
                    onPress={() => { setConfirmAll(false); flush(); removeAll.mutate(); }}
                  />
                  <Action label={t.cancel} onPress={() => setConfirmAll(false)} />
                </View>
              </>
            ) : (
              <Action
                label={t.memoryDeleteAll}
                testID="memory-screen-delete-all"
                tone="warn"
                onPress={() => setConfirmAll(true)}
              />
            )}
          </Card>
        ) : null}
      </ScrollView>
    </ScreenIn>
  );
}

/**
 * "How reminders adapt to you" (UC-3.16, #202): the group the shipped
 * classifier reads from the account's behaviour, and the post-UC-3.13 (#199)
 * guarantee about what the group may change — it can make a suggested step
 * smaller and a reminder gentler, never stronger.
 *
 * No controls: the group is set from behaviour rather than from anything the
 * user asked for, so the honest panel is one that can be read and disagreed
 * with, not one that pretends to be a setting. When there is no behaviour to
 * read a group from, the card says that instead of showing a label the
 * defaults produced.
 */
function AdaptiveCard({ adaptive, strings }: { adaptive: MemoryAdaptive; strings: Record<string, string> }) {
  const { p } = useApp();
  return (
    <Card pad={18} style={{ gap: 8 }} testID="memory-adaptive">
      <Txt size={13} weight={600} color={p.mu}>{strings.memoryAdaptiveTitle}</Txt>
      {adaptive.classification !== null ? (
        // Row-wrapped so the pill hugs its label instead of stretching.
        <View style={{ flexDirection: 'row' }}>
          <Chip
            label={strings[ADAPTIVE_CLASS_STRING[adaptive.classification]] ?? ''}
            testID="memory-adaptive-classification"
          />
        </View>
      ) : (
        <Txt size={13} color={p.mu} lh={1.5} testID="memory-adaptive-unset">{strings.memoryAdaptiveUnset}</Txt>
      )}
      <Txt size={13} color={p.mu} lh={1.5} testID="memory-adaptive-effect">{strings.memoryAdaptiveEffect}</Txt>
    </Card>
  );
}

function SuggestionsCard({
  suggestions, strings, busy, onKeep, onDismiss,
}: {
  suggestions: readonly MemorySuggestion[];
  strings: Record<string, string>;
  busy: boolean;
  onKeep: (suggestion: MemorySuggestion) => void;
  onDismiss: (suggestion: MemorySuggestion) => void;
}) {
  const { p } = useApp();
  return (
    <Card pad={0} style={{ overflow: 'hidden' }} testID="memory-suggestions">
      <View style={{ paddingHorizontal: 18, paddingTop: 16, paddingBottom: 4, gap: 4 }}>
        <Txt size={13} weight={600} color={p.mu}>{strings.memorySuggestionsTitle}</Txt>
        <Txt size={13} color={p.mu} lh={1.5} testID="memory-suggestions-lede">{strings.memorySuggestionsLede}</Txt>
      </View>
      {suggestions.map(suggestion => (
        <View
          key={suggestion.fingerprint}
          style={{ paddingHorizontal: 18, paddingVertical: 14, gap: 8, borderTopWidth: 1, borderTopColor: p.ln }}
        >
          <Txt size={15} lh={1.5} testID={`memory-suggestion-${suggestion.fingerprint}`}>
            {isolate(fill(strings.memorySuggestionFocusWindow ?? '', {
              start: suggestion.window.start,
              end: suggestion.window.end,
            }))}
          </Txt>
          <Txt size={13} color={p.mu} lh={1.5} testID={`memory-suggestion-evidence-${suggestion.fingerprint}`}>
            {isolate(fill(strings.memorySuggestionEvidence ?? '', {
              days: String(suggestion.evidence.lookbackDays),
              total: String(suggestion.evidence.totalCount),
              matching: String(suggestion.evidence.matchingCount),
            }))}
          </Txt>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <Action
              label={strings.memorySuggestionKeep ?? ''}
              testID={`memory-suggestion-keep-${suggestion.fingerprint}`}
              disabled={busy}
              onPress={() => onKeep(suggestion)}
            />
            <Action
              label={strings.memorySuggestionDismiss ?? ''}
              testID={`memory-suggestion-dismiss-${suggestion.fingerprint}`}
              disabled={busy}
              onPress={() => onDismiss(suggestion)}
            />
          </View>
        </View>
      ))}
    </Card>
  );
}

function MemoryGroupCard({
  group, rows, strings, date, rtl, editing, why,
  onToggleWhy, onEdit, onCancelEdit, onSave, onDelete,
}: {
  group: MemoryGroup;
  rows: readonly MemoryItem[];
  strings: Record<string, string>;
  date: (iso: string) => string;
  rtl: boolean;
  editing: string | null;
  why: string | null;
  onToggleWhy: (id: string) => void;
  onEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSave: (id: string, next: string) => void;
  onDelete: (id: string) => void;
}) {
  const { p } = useApp();
  return (
    <Card pad={0} style={{ overflow: 'hidden' }} testID={`memory-group-${group}`}>
      <View style={{ paddingHorizontal: 18, paddingTop: 16, paddingBottom: 4 }}>
        <Txt size={13} weight={600} color={p.mu}>{strings[GROUP_STRING[group]]}</Txt>
      </View>
      {rows.map(item => (
        <MemoryDetailRow
          key={item.id}
          item={item}
          strings={strings}
          date={date}
          rtl={rtl}
          editing={editing === item.id}
          showWhy={why === item.id}
          onToggleWhy={() => onToggleWhy(item.id)}
          onEdit={() => onEdit(item.id)}
          onCancelEdit={onCancelEdit}
          onSave={next => onSave(item.id, next)}
          onDelete={() => onDelete(item.id)}
        />
      ))}
    </Card>
  );
}

function MemoryDetailRow({
  item, strings, date, rtl, editing, showWhy,
  onToggleWhy, onEdit, onCancelEdit, onSave, onDelete,
}: {
  item: MemoryItem;
  strings: Record<string, string>;
  date: (iso: string) => string;
  rtl: boolean;
  editing: boolean;
  showWhy: boolean;
  onToggleWhy: () => void;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (next: string) => void;
  onDelete: () => void;
}) {
  const { t, p } = useApp();
  const [draft, setDraft] = useState(item.content);

  if (editing) {
    return (
      <View style={{ paddingHorizontal: 18, paddingVertical: 14, gap: 10, borderTopWidth: 1, borderTopColor: p.ln }}>
        <TextInput
          testID={`memory-screen-edit-input-${item.id}`}
          accessibilityLabel={t.memoryEdit}
          value={draft}
          onChangeText={setDraft}
          maxLength={200}
          multiline
          style={{ color: p.tx, fontSize: 15, minHeight: 44, textAlign: rtl ? 'right' : 'left' }}
        />
        <View style={{ flexDirection: 'row', gap: 14 }}>
          <Action
            label={t.memorySave}
            testID={`memory-screen-save-${item.id}`}
            disabled={draft.trim() === ''}
            onPress={() => onSave(draft.trim())}
          />
          <Action label={t.cancel} onPress={onCancelEdit} />
        </View>
      </View>
    );
  }

  return (
    <View style={{ paddingHorizontal: 18, paddingVertical: 14, gap: 8, borderTopWidth: 1, borderTopColor: p.ln }}>
      <Txt size={15} lh={1.5} testID={`memory-screen-item-${item.id}`}>
        {isolate(memorySentence({ content: item.content, strings }))}
      </Txt>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Chip label={strings[SOURCE_LABEL_STRING[item.sourceLabel]] ?? ''} testID={`memory-screen-source-${item.id}`} />
        {/* Words, never the number. A confidence printed as 0.62 invites the
            reader to treat a threshold as a measurement of themselves. */}
        <Chip
          label={strings[CONFIDENCE_STRING[confidenceBand(item.confidence)]] ?? ''}
          testID={`memory-confidence-${item.id}`}
        />
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <Action
          label={showWhy ? t.memoryWhyHide : t.memoryWhy}
          testID={`memory-why-${item.id}`}
          onPress={onToggleWhy}
        />
        <View style={{ flex: 1 }} />
        <Action label={t.memoryEdit} testID={`memory-screen-edit-${item.id}`} onPress={onEdit} />
        <Action label={t.memoryDelete} testID={`memory-screen-delete-${item.id}`} tone="warn" onPress={onDelete} />
      </View>

      {showWhy ? (
        <View style={{ gap: 6, paddingTop: 4 }} testID={`memory-evidence-${item.id}`}>
          {evidenceLines(item, { strings, date }).map(line => (
            <View key={line.key} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
              <Txt size={13} color={p.mu}>·</Txt>
              <Txt size={13} color={p.mu} lh={1.5} style={{ flex: 1 }} testID={`memory-evidence-${item.id}-${line.key}`}>
                {isolate(line.text)}
              </Txt>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function Chip({ label, testID }: { label: string; testID?: string }) {
  const { p } = useApp();
  if (label === '') return null;
  return (
    <View style={{ backgroundColor: p.sf2, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}>
      <Txt size={12} color={p.mu} {...(testID ? { testID } : {})}>{label}</Txt>
    </View>
  );
}

function Action({
  label, onPress, tone, testID, disabled,
}: { label: string; onPress: () => void; tone?: 'warn'; testID?: string; disabled?: boolean }) {
  const { p } = useApp();
  return (
    <Btn
      label={label}
      {...(testID ? { testID } : {})}
      {...(disabled ? { disabled: true } : {})}
      onPress={disabled ? undefined : onPress}
      scaleTo={0.97}
      hitSlop={8}
      style={{ minHeight: 32, justifyContent: 'center' }}
    >
      <Txt size={14} color={disabled ? p.mu : tone === 'warn' ? p.wm : p.ac}>{label}</Txt>
    </Btn>
  );
}
