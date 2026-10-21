import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useApp } from '../../state/AppContext';
import { isolateAuto, isolateLatinRuns, stripIsolates } from '../../i18n/bidi';
import { Btn, Txt } from '../../ui/primitives';
import { LiveRegion } from '../../ui/liveRegion';
import { useAnnounceOnIos } from '../../ui/announce';
import { proposeMemoryTranslation } from '../../api/endpoints/m6';
import { ConflictError, FeatureUnavailableError, NotFoundError } from '../../api/errors';
import { queryKeys, usePatchMemory, useUid } from '../../api/queries';
import { userFacingMessage } from '../../api/ui/userFacingMessage';
import type { MemoryItem } from '../../api/schemas/profile';
import { MEMORY_TRANSLATION_DISCLOSURE_VERSION } from './disclosure';
import { routineFactKeyOf } from '../memory/routineFactKeys';

/**
 * «اكتبها بالعربي» (condition 53, D53-1 (b); PLAN-M6a-2 R2).
 *
 * A fact written in another language than the app's can be offered to the
 * model for a translation. The model **proposes**; nothing is stored until the
 * person saves it, and saving is the ordinary edit against the same id — so a
 * record edited or deleted meanwhile answers 404/409 and nothing is written.
 *
 * Two taps (M6A2-R2-003): the action opens the panel with the disclosure, and
 * only «اقترح ترجمة» sends — so the person has read where it goes before they
 * ask, and the request names the disclosure version they were shown. The
 * button is drawn only after the disclosure's mount effect has run. One
 * request per tap, never retried; closing the panel while it loads cancels it.
 */

export type TranslationTarget = 'ar' | 'en' | 'he';

const LETTER = new RegExp('\\p{L}', 'u');
const ARABIC = new RegExp('\\p{Script=Arabic}', 'u');
const HEBREW = new RegExp('\\p{Script=Hebrew}', 'u');
const LATIN = new RegExp('\\p{Script=Latin}', 'u');

/**
 * The language of a fact's text, from its first letter — the server's own
 * classifier (M6A2-R3-002): another script is `other`, no letter is `null`,
 * and neither is translatable. A Latin-script fact counts as English.
 */
export function textLanguageOf(content: string): 'ar' | 'he' | 'en' | 'other' | null {
  for (const char of stripIsolates(content)) {
    if (!LETTER.test(char)) continue;
    return ARABIC.test(char) ? 'ar' : HEBREW.test(char) ? 'he' : LATIN.test(char) ? 'en' : 'other';
  }
  return null;
}

/**
 * The language a fact would be written in, or null when it already reads in
 * the app's or cannot be translated. A goal never is: it carries plans, and
 * rewording it is an edit the person makes themselves (the server answers 422).
 */
export function translationTargetOf(content: string, lang: string, kind?: string): TranslationTarget | null {
  if (kind === 'goal') return null;
  // A routine fact is a machine record (`quiet_hours:22:30-07:30`) the screen
  // already renders in the app's language; translating it would replace the
  // grammar other features read with prose (M6A2-APP-001).
  if (routineFactKeyOf(content) !== null) return null;
  if (lang !== 'ar' && lang !== 'en' && lang !== 'he') return null;
  const from = textLanguageOf(content);
  if (from === null || from === 'other') return null;
  return from === lang ? null : lang;
}

/** The row's action. Its accessibility label names the fact it would translate. */
/** The action colour of the surface the row sits on: Settings' card uses `ac`, the memory screen `acd`. */
export type ActionTone = 'ac' | 'acd';

export function TranslateAction({ item, target, onPress, tone = 'ac' }: {
  item: MemoryItem;
  target: TranslationTarget;
  onPress: () => void;
  tone?: ActionTone;
}) {
  const { tr, p } = useApp();
  const label = tr('m6TranslateAction', { lang: target });
  return (
    <Btn
      label={`${label}: ${item.content}`}
      testID={`m6-translate-action-${item.id}`}
      onPress={onPress}
      scaleTo={0.97}
      hitSlop={8}
      style={{ minHeight: 44, justifyContent: 'center' }}
    >
      <Txt size={14} color={p[tone]}>{label}</Txt>
    </Btn>
  );
}

type Phase =
  | { kind: 'asking' }
  | { kind: 'loading' }
  | { kind: 'ready'; text: string; memoryId: string; saving: boolean; failed: string | null }
  | { kind: 'unavailable' }
  | { kind: 'changed' };

export function MemoryTranslationPanel({ item, target, onClose, tone = 'ac' }: {
  item: MemoryItem;
  target: TranslationTarget;
  onClose: () => void;
  tone?: ActionTone;
}) {
  const { t, p } = useApp();
  const uid = useUid();
  const client = useQueryClient();
  const patch = usePatchMemory();
  const [shown, setShown] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'asking' });
  // Synchronous, unlike `phase.saving`: two presses before the disabled render
  // commits would otherwise both send the edit (M6A2-APP-003, as useOneAtATime).
  const savingRef = useRef(false);
  const sending = shown && phase.kind === 'loading';

  useEffect(() => {
    if (!sending) return;
    const controller = new AbortController();
    let live = true;
    proposeMemoryTranslation(item.id, target, MEMORY_TRANSLATION_DISCLOSURE_VERSION, { asUid: uid, signal: controller.signal }).then(
      (answer) => {
        if (!live) return;
        const proposal = answer.proposal;
        // A proposal made for another record, language or source than this
        // row's is not offered (M6A2-APP-004).
        setPhase(proposal.status === 'ready'
          && proposal.memoryId === item.id
          && proposal.to === target
          && proposal.from === textLanguageOf(item.content)
          ? { kind: 'ready', text: proposal.text, memoryId: proposal.memoryId, saving: false, failed: null }
          : { kind: 'unavailable' });
      },
      (error: unknown) => {
        if (!live) return;
        if (error instanceof NotFoundError && !(error instanceof FeatureUnavailableError)) {
          setPhase({ kind: 'changed' });
          void client.invalidateQueries({ queryKey: queryKeys.memory(uid) });
        } else {
          setPhase({ kind: 'unavailable' });
        }
      },
    );
    return () => {
      live = false;
      controller.abort();
    };
  }, [sending, item.id, item.content, target, uid, client]);

  const save = () => {
    if (phase.kind !== 'ready' || phase.saving || savingRef.current) return;
    savingRef.current = true;
    const { text, memoryId } = phase;
    setPhase({ ...phase, saving: true, failed: null });
    patch.mutate({ id: memoryId, content: text }, {
      // The edit supersedes, so this row's id leaves the list; the memory
      // prefix is invalidated by the mutation, and M5b's summary with it.
      onSuccess: onClose,
      onError: (error) => {
        // Released only after a failure: a success closes the panel.
        savingRef.current = false;
        if (error instanceof NotFoundError || error instanceof ConflictError) {
          setPhase({ kind: 'changed' });
          void client.invalidateQueries({ queryKey: queryKeys.memory(uid) });
        } else {
          setPhase({ kind: 'ready', text, memoryId, saving: false, failed: userFacingMessage(error, t) });
        }
      },
    });
  };

  const status = phase.kind === 'loading' ? t.m6TranslateLoading
    : phase.kind === 'unavailable' ? t.m6TranslateUnavailable
      : phase.kind === 'changed' ? t.m6TranslateChanged
        // VoiceOver hears that it is a suggestion too, as the screen says (M6A2-APP-005).
        : phase.kind === 'ready' ? phase.failed ?? `${phase.text}. ${t.suggestionNote}`
          : null;
  useAnnounceOnIos(status);

  return (
    <View testID={`m6-translate-panel-${item.id}`} style={{ gap: 8, paddingTop: 4 }}>
      <TranslationDisclosure id={item.id} onShown={setShown} />
      <LiveRegion>
        {phase.kind === 'loading' ? (
          <Txt size={14} color={p.mu} testID={`m6-translate-loading-${item.id}`}>{t.m6TranslateLoading}</Txt>
        ) : phase.kind === 'unavailable' ? (
          <Txt size={14} color={p.mu} testID={`m6-translate-unavailable-${item.id}`}>{t.m6TranslateUnavailable}</Txt>
        ) : phase.kind === 'changed' ? (
          <Txt size={14} color={p.wm} testID={`m6-translate-changed-${item.id}`}>{t.m6TranslateChanged}</Txt>
        ) : phase.kind === 'ready' ? (
          <View style={{ gap: 4 }}>
            <Txt size={15} lh={1.5} dir="auto" testID={`m6-translate-proposal-${item.id}`}>{isolateAuto(phase.text)}</Txt>
            <Txt size={13} color={p.mu}>{t.suggestionNote}</Txt>
            {phase.failed ? <Txt size={13} color={p.wm}>{phase.failed}</Txt> : null}
          </View>
        ) : null}
      </LiveRegion>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 10, rowGap: 4 }}>
        {phase.kind === 'asking' && shown ? (
          <PanelAction
            label={t.m6TranslateRequest}
            testID={`m6-translate-request-${item.id}`}
            onPress={() => setPhase({ kind: 'loading' })}
            tone={tone}
          />
        ) : null}
        {phase.kind === 'ready' ? (
          <PanelAction
            label={t.m6TranslateSave}
            testID={`m6-translate-save-${item.id}`}
            disabled={phase.saving}
            onPress={save}
            tone={tone}
          />
        ) : null}
        <PanelAction label={t.m6TranslateKeep} testID={`m6-translate-keep-${item.id}`} onPress={onClose} muted={phase.kind === 'ready'} tone={tone} />
      </View>
    </View>
  );
}

/** Said before anything can be sent; the request button appears only after its mount effect ran. */
function TranslationDisclosure({ id, onShown }: { id: string; onShown: (shown: boolean) => void }) {
  const { t, p } = useApp();
  useEffect(() => {
    onShown(true);
    return () => onShown(false);
  }, [onShown]);
  return (
    <Txt size={13} color={p.mu} testID={`m6-translate-disclosure-${id}`}>{isolateLatinRuns(t.m6TranslateDisclosure)}</Txt>
  );
}

function PanelAction({ label, testID, onPress, disabled, muted, tone }: {
  label: string;
  testID: string;
  onPress: () => void;
  disabled?: boolean;
  muted?: boolean;
  tone: ActionTone;
}) {
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
      <Txt size={14} color={disabled || muted ? p.mu : p[tone]}>{label}</Txt>
    </Btn>
  );
}
