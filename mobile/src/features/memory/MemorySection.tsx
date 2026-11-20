import React, { useEffect, useRef, useState } from 'react';
import { TextInput, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { isolateAuto, isolateLatinRuns } from '../../i18n/bidi';
import { Btn, Card, Txt } from '../../ui/primitives';
import { LiveRegion } from '../../ui/liveRegion';
import { useAnnounceOnIos } from '../../ui/announce';
import { markErrorShown, userFacingMessage } from '../../api/ui/userFacingMessage';
import {
  useCreateMemory,
  useDeleteAllMemory,
  useDeleteMemory,
  useMemory,
  useMemoryPurging,
  useMemorySummary,
  usePatchMemory,
} from '../../api/queries';
import { useM5bOn } from '../m5b/capabilities';
import { useMemoryTranslationOn } from '../m6/capabilities';
import { MemoryTranslationPanel, TranslateAction, translationTargetOf, type TranslationTarget } from '../m6/MemoryTranslation';
import type { MemoryItem } from '../../api/schemas/profile';
import { memoryHoldsErasable } from './memoryErasable';
import { CHIP_STRING, memorySentence, provenanceChip } from './memoryDisplay';
import { KeptMemoryEdit } from './KeptMemoryEdit';

/**
 * Everything MaybeSitter remembers, and the controls to change it
 * (UC-2.7a #167 step 6, on UC-2.R4 #174's screen).
 *
 * ── It disappears when the feature is off ────────────────────────
 *
 * `GET /api/mobile/memory` answers 404 when `MAYBESITTER_FEATURE_MEMORY` is
 * off, and the section renders nothing at all. Not an error, not an empty
 * state: a build without the feature has no memory, and saying "nothing yet"
 * would imply there is a store that happens to be empty.
 *
 * ── Delete is a real delete, and says so ─────────────────────────
 *
 * Both destructive actions confirm inline before they run, and the copy says
 * it cannot be undone — because it cannot: the server removes the record and
 * its whole supersession history. Editing is not destructive (it supersedes),
 * so it does not confirm.
 *
 * ── Bidi isolation is not cosmetic ───────────────────────────────
 *
 * A fact's content is the user's own words, in whatever script they used, next
 * to times in Latin digits. Without an isolate the neutral characters at the
 * boundary reorder and a quiet-hours range renders backwards. `isolate` is
 * UC-1.R3 (#156)'s helper and every rendered fact goes through it.
 *
 * ── Nothing is offered while delete-all may be erasing it ────────
 *
 * While a delete-all is on its way — pressed here or on `MemoryScreen` — and
 * after one whose outcome is unknown until a fresh list answers, the rows and
 * every control go, as they do on `MemoryScreen` (M5B2A-R32-003): an add, an
 * edit or a delete sent beside the purge could land after it said done.
 *
 * ── It is the short version of `MemoryScreen` ────────────────────
 *
 * `onOpen` adds the way through to the full screen (UC-3.16, #202), which
 * groups the same records by who asserted them and can answer "why?" for each.
 * Optional: this card is still the whole feature on its own, and a caller with
 * nowhere to send the user simply gets no link rather than a dead one.
 */
export function MemorySection({ onOpen }: { onOpen?: (() => void) | undefined } = {}) {
  const { t, tr, p, rtl, lang } = useApp();
  const memory = useMemory();
  // Asked even with nothing remembered, so the answer is ready when a first
  // record arrives; off or unknown leaves this card exactly as it was.
  const m5bOn = useM5bOn();
  const create = useCreateMemory();
  const patch = usePatchMemory();
  const remove = useDeleteMemory();
  const removeAll = useDeleteAllMemory();

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  // CA8.2: the last write that failed, said on the card; and an edit that
  // failed, held until its row is known to be still there (or gone).
  const [failed, setFailed] = useState<unknown>(null);
  const [keptEdit, setKeptEdit] = useState<{ id: string; content: string; kind: MemoryItem['kind'] } | null>(null);
  // The words of an edit whose row went: beside the add field, never in it,
  // so a new fact being typed is not overwritten (A3 review).
  const [kept, setKept] = useState<{ content: string; kind: MemoryItem['kind'] } | null>(null);
  const failedText = failed == null ? null : userFacingMessage(failed, t);
  // Marked as said at once: the line above says it (A3 review).
  const fail = (error: unknown) => { markErrorShown(error); setFailed(error); };
  useAnnounceOnIos(failedText);
  // M6a-2: the row whose translation panel is open. Unknown or off offers none.
  const translationOn = useMemoryTranslationOn() === true;
  const [translating, setTranslating] = useState<string | null>(null);
  // The paragraph is asked for only after its disclosure is on screen
  // (M5B1-011): the effect that flips this runs after the line has mounted.
  const [disclosed, setDisclosed] = useState(false);
  const purging = useMemoryPurging(memory.data);
  const hasItems = !purging && (memory.data?.items.length ?? 0) > 0;
  // Rows already on screen may have been sent, so a later failed refetch of
  // the list keeps the card and its disclosure (M5B-A-004).
  const summaryOn = m5bOn === true && hasItems;
  const summary = useMemorySummary(summaryLanguage(lang), summaryOn && disclosed);
  // Only a current answer is a paragraph (M5B-A-001): a refetch that failed,
  // or one still running after a memory change, never shows the old one.
  // A list that failed to refetch shows its rows.
  const current = summary.status === 'success' && !summary.isFetching && !memory.isError;
  // A refusal the person can act on is said in one line above the rows
  // (staging 2026-11-20: the minute cap looked like nothing at all). With no
  // reason there is nothing to act on, and the card stays as it was.
  const reason = summaryOn && current && summary.data.status === 'unavailable' ? summary.data.reason : undefined;
  const unavailableLine = reason ? t[SUMMARY_UNAVAILABLE_LINE[reason]] : null;
  useAnnounceOnIos(unavailableLine);
  // The minute cap clears in a minute: asked once more after it, once per
  // mount, never in a loop (review of #885). Its line says so.
  const retriedBusy = useRef(false);
  const refetchSummary = summary.refetch;
  useEffect(() => {
    if (reason !== 'busy_now' || retriedBusy.current) return undefined;
    const timer = setTimeout(() => { retriedBusy.current = true; void refetchSummary(); }, SUMMARY_BUSY_RETRY_MS);
    return () => clearTimeout(timer);
  }, [reason, refetchSummary]);

  // 404 on the first read: the feature is off for this build. Nothing to show,
  // and nothing to apologise for. A failed refetch keeps the rows it had.
  if (memory.data === undefined) return null;

  const items = purging ? [] : memory.data.items;
  // An edit refused because its row changed elsewhere (another device
  // replaced or deleted it): once the re-read has no such row, the typed
  // words are kept on the card, to save again or let go — never lost (CA8.2).
  if (keptEdit && !purging && !items.some(item => item.id === keptEdit.id)) {
    setKeptEdit(null);
    setEditing(current => (current === keptEdit.id ? null : current));
    setKept({ content: keptEdit.content, kind: keptEdit.kind });
  }
  const strings = t as unknown as Record<string, string>;
  const ready = summaryOn && current && summary.data.status === 'ready' ? summary.data : null;
  const loading = summaryOn && !memory.isError && (!disclosed || summary.isFetching || summary.isPending) && summary.status !== 'error';

  return (
    <Card pad={0} style={{ overflow: 'hidden' }} testID="memory-section">
      <View style={{ paddingHorizontal: 18, paddingTop: 16, paddingBottom: 8 }}>
        <Txt size={13} weight={600} color={p.mu}>{t.memoryTitle}</Txt>
      </View>

      {/* A failed write is said, not swallowed (CA8.2). Always mounted, so
          TalkBack hears the line arrive; VoiceOver hears useAnnounceOnIos. */}
      <LiveRegion style={{ paddingHorizontal: 18, paddingBottom: 8 }}>
        {failedText ? <Txt size={14} color={p.wm} testID="memory-error">{failedText}</Txt> : null}
      </LiveRegion>

      {items.length === 0 && (!adding || purging) ? (
        <View style={{ paddingHorizontal: 18, paddingBottom: 14 }}>
          <Txt size={14} color={p.mu} testID="memory-empty">{t.memoryEmpty}</Txt>
        </View>
      ) : null}

      {ready ? (
        <View style={{ paddingHorizontal: 18, paddingBottom: 14, gap: 8 }}>
          <Txt role="section" size={13} weight={600} color={p.mu} testID="memory-summary-title">{t.m5bSummaryTitle}</Txt>
          <Txt size={15} lh={1.6} testID="memory-summary">
            {ready.sentences.map(sentence => isolateAuto(sentence.text)).join(' ')}
          </Txt>
          {ready.totalCount > ready.coveredCount ? (
            <Txt size={13} color={p.mu} testID="memory-summary-more">
              {tr('m5bSummaryMore', { count: ready.totalCount - ready.coveredCount })}
            </Txt>
          ) : null}
        </View>
      ) : loading ? (
        <View style={{ paddingHorizontal: 18, paddingBottom: 14 }}>
          <Txt size={14} color={p.mu} testID="memory-summary-loading">{t.m5bSummaryLoading}</Txt>
        </View>
      ) : null}

      {/* Why there is no paragraph: always mounted, so TalkBack hears the
          line arrive; VoiceOver hears useAnnounceOnIos (review of #885). */}
      <LiveRegion style={{ paddingHorizontal: 18, paddingBottom: 14 }}>
        {unavailableLine && !ready && !loading
          ? <Txt size={14} color={p.mu} testID="memory-summary-unavailable">{isolateLatinRuns(unavailableLine)}</Txt>
          : null}
      </LiveRegion>

      {ready || loading ? null : items.map(item => (
        <MemoryRow
          key={item.id}
          item={item}
          strings={strings}
          m5bOn={m5bOn === true}
          editing={editing === item.id}
          confirming={confirming === item.id}
          translateTarget={translationOn ? translationTargetOf(item.content, lang, item.kind) : null}
          translating={translating === item.id}
          onTranslate={() => { setEditing(null); setConfirming(null); setTranslating(item.id); }}
          onCloseTranslate={() => setTranslating(null)}
          onEdit={() => { setTranslating(null); setEditing(item.id); }}
          onCancelEdit={() => { setEditing(null); setKeptEdit(null); }}
          saving={patch.isPending}
          onSave={next => {
            // Closed only once the server took it: a failure keeps the field
            // and the words in it (CA8.2).
            setFailed(null);
            setKeptEdit(null);
            patch.mutate({ id: item.id, content: next }, {
              onSuccess: () => setEditing(current => (current === item.id ? null : current)),
              onError: (error) => { fail(error); setKeptEdit({ id: item.id, content: next, kind: item.kind }); },
            });
          }}
          onAskDelete={() => { setTranslating(null); setConfirming(item.id); }}
          onCancelDelete={() => setConfirming(null)}
          onDelete={() => { setConfirming(null); setFailed(null); remove.mutate(item.id, { onError: fail }); }}
        />
      ))}

      {summaryOn ? <SummaryDisclosure onShown={setDisclosed} /> : null}

      {kept && !purging ? (
        <KeptMemoryEdit
          testPrefix="memory"
          initial={kept.content}
          saving={create.isPending}
          onSave={content => {
            setFailed(null);
            create.mutate(
              { kind: kept.kind === 'preference' ? 'preference' : 'fact', content, language: 'mixed' },
              { onSuccess: () => setKept(null), onError: fail },
            );
          }}
          onCancel={() => setKept(null)}
        />
      ) : null}

      {purging ? null : adding ? (
        <View style={{ paddingHorizontal: 18, paddingVertical: 12, gap: 10, borderTopWidth: 1, borderTopColor: p.ln }}>
          <TextInput
            testID="memory-add-input"
            accessibilityLabel={t.memoryAdd}
            value={draft}
            onChangeText={setDraft}
            placeholder={t.memoryAddPlaceholder}
            placeholderTextColor={p.mu}
            maxLength={200}
            multiline
            style={{ color: p.tx, fontSize: 15, minHeight: 44, textAlign: rtl ? 'right' : 'left' }}
          />
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <SmallAction
              label={t.memorySave}
              testID="memory-add-save"
              disabled={draft.trim() === '' || create.isPending}
              onPress={() => {
                // Cleared only once the server took it (CA8.2).
                setFailed(null);
                create.mutate({ kind: 'fact', content: draft.trim(), language: 'mixed' }, {
                  onSuccess: () => { setDraft(''); setAdding(false); },
                  onError: fail,
                });
              }}
            />
            <SmallAction label={t.cancel} onPress={() => { setDraft(''); setAdding(false); }} />
          </View>
        </View>
      ) : (
        <Btn
          label={t.memoryAdd}
          testID="memory-add"
          scaleTo={0.98}
          onPress={() => setAdding(true)}
          style={{ paddingVertical: 14, paddingHorizontal: 18, borderTopWidth: 1, borderTopColor: p.ln, alignItems: 'flex-start' }}
        >
          <Txt size={14} color={p.ac}>{t.memoryAdd}</Txt>
        </Btn>
      )}

      {onOpen ? (
        <Btn
          label={t.memoryOpen}
          testID="memory-open"
          scaleTo={0.98}
          onPress={onOpen}
          style={{ paddingVertical: 14, paddingHorizontal: 18, borderTopWidth: 1, borderTopColor: p.ln, alignItems: 'flex-start' }}
        >
          <Txt size={14} color={p.ac}>{t.memoryOpen}</Txt>
        </Btn>
      ) : null}

      {/* Offered whenever there is anything delete-all erases, rows or not (CXA8.4). */}
      {!purging && memoryHoldsErasable(memory.data) ? (
        <View style={{ paddingHorizontal: 18, paddingVertical: 12, borderTopWidth: 1, borderTopColor: p.ln, gap: 8 }}>
          {confirmAll ? (
            <>
              <Txt size={13} color={p.wm}>{t.memoryDeleteAllConfirm}</Txt>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <SmallAction
                  label={t.memoryDeleteAll}
                  testID="memory-delete-all-confirm"
                  tone="warn"
                  onPress={() => { setConfirmAll(false); setFailed(null); removeAll.mutate(undefined, { onError: fail }); }}
                />
                <SmallAction label={t.cancel} onPress={() => setConfirmAll(false)} />
              </View>
            </>
          ) : (
            <Btn
              label={t.memoryDeleteAll}
              testID="memory-delete-all"
              scaleTo={0.98}
              onPress={() => setConfirmAll(true)}
              hitSlop={8}
              style={{ alignItems: 'flex-start', minHeight: 44, justifyContent: 'center' }}
            >
              <Txt size={14} color={p.wm}>{t.memoryDeleteAll}</Txt>
            </Btn>
          )}
        </View>
      ) : null}
    </Card>
  );
}

function MemoryRow({
  item, strings, editing, confirming, m5bOn, translateTarget, translating,
  onTranslate, onCloseTranslate, onEdit, onCancelEdit, onSave, onAskDelete, onCancelDelete, onDelete, saving = false,
}: {
  item: MemoryItem;
  /** M6a-2: the app's language when this fact reads in another one and translation is on. */
  translateTarget: TranslationTarget | null;
  translating: boolean;
  onTranslate: () => void;
  onCloseTranslate: () => void;
  strings: Record<string, string>;
  /** Only names the row for M5b's tests; the wrap itself applies always (PLAN-M5b-1 Release). */
  m5bOn: boolean;
  editing: boolean;
  confirming: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (next: string) => void;
  /** A save on its way: Save waits for its answer rather than sending twice. */
  saving?: boolean;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}) {
  const { t, p, rtl } = useApp();
  const [draft, setDraft] = useState(item.content);
  const chip = provenanceChip(item.provenance, item.source);

  return (
    <View style={{ paddingHorizontal: 18, paddingVertical: 14, gap: 8, borderTopWidth: 1, borderTopColor: p.ln }}>
      {editing ? (
        <>
          <TextInput
            testID={`memory-edit-input-${item.id}`}
            accessibilityLabel={t.memoryEdit}
            value={draft}
            onChangeText={setDraft}
            maxLength={200}
            multiline
            style={{ color: p.tx, fontSize: 15, minHeight: 44, textAlign: rtl ? 'right' : 'left' }}
          />
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <SmallAction
              label={t.memorySave}
              testID={`memory-save-${item.id}`}
              disabled={draft.trim() === '' || saving}
              onPress={() => onSave(draft.trim())}
            />
            <SmallAction label={t.cancel} onPress={onCancelEdit} />
          </View>
        </>
      ) : (
        <>
          <Txt size={15} lh={1.5} dir="auto" testID={`memory-item-${item.id}`}>
            {isolateAuto(memorySentence({ content: item.content, strings }))}
          </Txt>
          {/* At AX5 the actions wrap to a second line instead of clipping
              «امسح» — on or off, because a clipped control is a defect. */}
          <View
            {...(m5bOn ? { testID: `m5b-memory-row-actions-${item.id}` } : {})}
            style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 10, rowGap: 4 }}
          >
            {chip ? (
              <View style={{ backgroundColor: p.sf2, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}>
                <Txt size={12} color={p.mu} testID={`memory-chip-${item.id}`}>{strings[CHIP_STRING[chip]]}</Txt>
              </View>
            ) : null}
            <View style={{ flex: 1 }} />
            {/* Edit and delete wait while a translation panel is open: its save
                is an edit of this row (M6A2-APP-007). */}
            {confirming || translating ? null : (
              <>
                {translateTarget ? (
                  <TranslateAction item={item} target={translateTarget} onPress={onTranslate} />
                ) : null}
                <SmallAction label={t.memoryEdit} testID={`memory-edit-${item.id}`} onPress={onEdit} />
                <SmallAction label={t.memoryDelete} testID={`memory-delete-${item.id}`} tone="warn" onPress={onAskDelete} />
              </>
            )}
          </View>
          {translateTarget && translating && !confirming ? (
            // Keyed by the target: a language change mid-request aborts it and asks again (M6A2-APP-002).
            <MemoryTranslationPanel key={translateTarget} item={item} target={translateTarget} onClose={onCloseTranslate} />
          ) : null}
          {confirming ? (
            <>
              <Txt size={13} color={p.wm}>{t.memoryDeleteConfirm}</Txt>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <SmallAction label={t.memoryDelete} testID={`memory-delete-confirm-${item.id}`} tone="warn" onPress={onDelete} />
                <SmallAction label={t.cancel} onPress={onCancelDelete} />
              </View>
            </>
          ) : null}
        </>
      )}
    </View>
  );
}

const summaryLanguage = (lang: string): 'ar' | 'en' | 'he' => (lang === 'ar' || lang === 'he' ? lang : 'en');

/** A minute and a little: the minute cap counts by the UTC minute. */
const SUMMARY_BUSY_RETRY_MS = 65_000;

/** The line for each reason the summary route gives (lib/services/mobile/memorySummary.ts). */
const SUMMARY_UNAVAILABLE_LINE = {
  busy_now: 'm5bSummaryBusyNow',
  daily_cap: 'm5bSummaryDailyCap',
  monthly_cap: 'm5bSummaryMonthlyCap',
  not_included: 'm5bSummaryNotIncluded',
} as const;

/**
 * Where the paragraph comes from, said before it is asked for and kept while
 * it loads, after it arrives and when it fails (M5B1-011). It mounts first;
 * its effect is what lets the request go.
 */
function SummaryDisclosure({ onShown }: { onShown: (shown: boolean) => void }) {
  const { t, p } = useApp();
  // Mounting lets the request go; unmounting (capability off, list emptied)
  // takes that back, so a later remount asks only after it is drawn again
  // (M5B-A-005).
  useEffect(() => {
    onShown(true);
    return () => onShown(false);
  }, [onShown]);
  return (
    <View style={{ paddingHorizontal: 18, paddingBottom: 12 }}>
      <Txt size={13} color={p.mu} testID="memory-summary-disclosure">{isolateLatinRuns(t.m5bSummaryDisclosure)}</Txt>
    </View>
  );
}

function SmallAction({
  label, onPress, tone, testID, disabled,
}: { label: string; onPress: () => void; tone?: 'warn'; testID?: string; disabled?: boolean }) {
  const { p } = useApp();
  return (
    <Btn
      label={label}
      testID={testID}
      disabled={disabled}
      onPress={disabled ? undefined : onPress}
      scaleTo={0.97}
      hitSlop={8}
      style={{ minHeight: 44, justifyContent: 'center' }}
    >
      <Txt size={14} color={disabled ? p.mu : tone === 'warn' ? p.wm : p.ac}>{label}</Txt>
    </Btn>
  );
}
