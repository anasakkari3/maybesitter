import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useApp } from '../../state/AppContext';
import { firstStrongScript, isolateAuto, isolateLatinRuns } from '../../i18n/bidi';
import { Btn, Txt } from '../../ui/primitives';
import { LiveRegion } from '../../ui/liveRegion';
import { useAnnounceOnIos } from '../../ui/announce';
import { proposeMemoryTranslation } from '../../api/endpoints/m6';
import { ConflictError, FeatureUnavailableError, NotFoundError } from '../../api/errors';
import { queryKeys, usePatchMemory, useUid } from '../../api/queries';
import { userFacingMessage } from '../../api/ui/userFacingMessage';
import type { MemoryItem } from '../../api/schemas/profile';

/**
 * «اكتبها بالعربي» (condition 53, D53-1 (b); PLAN-M6a-2 R2).
 *
 * A fact written in another language than the app's can be offered to the
 * model for a translation. The model **proposes**; nothing is stored until the
 * person saves it, and saving is the ordinary edit against the same id — so a
 * record edited or deleted meanwhile answers 404/409 and nothing is written.
 *
 * The disclosure mounts first and its effect is what lets the request go (the
 * M5b-1 rule: nothing is sent before the person has seen where it goes). One
 * request per tap, never retried; closing the panel while it loads cancels it.
 */

export type TranslationTarget = 'ar' | 'en' | 'he';

const SCRIPT_LANGUAGE = { arabic: 'ar', hebrew: 'he', latin: 'en' } as const;

/** The language a fact would be written in, or null when it already reads in the app's. */
export function translationTargetOf(content: string, lang: string): TranslationTarget | null {
  if (lang !== 'ar' && lang !== 'en' && lang !== 'he') return null;
  const script = firstStrongScript(content);
  if (script === null) return null;
  return SCRIPT_LANGUAGE[script] === lang ? null : lang;
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
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });

  useEffect(() => {
    if (!shown) return;
    const controller = new AbortController();
    let live = true;
    proposeMemoryTranslation(item.id, target, { asUid: uid, signal: controller.signal }).then(
      (answer) => {
        if (!live) return;
        const proposal = answer.proposal;
        // A proposal made for another record than this row's is not offered.
        setPhase(proposal.status === 'ready' && proposal.memoryId === item.id
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
  }, [shown, item.id, target, uid, client]);

  const save = () => {
    if (phase.kind !== 'ready' || phase.saving) return;
    const { text, memoryId } = phase;
    setPhase({ ...phase, saving: true, failed: null });
    patch.mutate({ id: memoryId, content: text }, {
      // The edit supersedes, so this row's id leaves the list; the memory
      // prefix is invalidated by the mutation, and M5b's summary with it.
      onSuccess: onClose,
      onError: (error) => {
        if (error instanceof NotFoundError || error instanceof ConflictError) {
          setPhase({ kind: 'changed' });
          void client.invalidateQueries({ queryKey: queryKeys.memory(uid) });
        } else {
          setPhase({ kind: 'ready', text, memoryId, saving: false, failed: userFacingMessage(error, t) });
        }
      },
    });
  };

  const status = phase.kind === 'loading' && shown ? t.m6TranslateLoading
    : phase.kind === 'unavailable' ? t.m6TranslateUnavailable
      : phase.kind === 'changed' ? t.m6TranslateChanged
        : phase.kind === 'ready' ? phase.failed ?? phase.text
          : null;
  useAnnounceOnIos(status);

  return (
    <View testID={`m6-translate-panel-${item.id}`} style={{ gap: 8, paddingTop: 4 }}>
      <TranslationDisclosure id={item.id} onShown={setShown} />
      <LiveRegion>
        {phase.kind === 'loading' && shown ? (
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

/** Said before anything is sent; its mount effect lets the request go, its unmount takes that back. */
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
