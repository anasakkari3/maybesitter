import { useClarityStage, useReplayEvent } from '../../clarity/ClarityProvider';
import React, { useCallback, useReducer } from 'react';
import * as Clipboard from 'expo-clipboard';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { fill } from '../../i18n/strings';
import { Notice } from '../../ui/chrome';
import { ForbiddenError, InputTooLargeError, QuotaExceededError } from '../../api/errors';
import { useConfirmAiContextImport, useImportAiContext } from '../../api/queries';
import { readClipboardText } from '../capture/clipboardImport';
import type { SuggestionCategory } from '../../api/schemas/profile';
import { ASSISTANTS, type ImportAssistant } from './assistants';
import { acceptedFrom, initialImport, reduceImport } from './aiImportMachine';
import { buildAssistantPrompt } from './importPrompt';
import { MAX_IMPORT_LENGTH } from './importLimits';
import { openAssistant } from './openAssistant';
import { AiImportPickStep } from './AiImportPickStep';
import { AiImportHandoffStep } from './AiImportHandoffStep';
import { AiImportPasteStep } from './AiImportPasteStep';
import { AiImportReviewStep } from './AiImportReviewStep';

/**
 * The whole flow, and the only implementation of it.
 *
 * Settings wraps it in `AiImportScreen`; onboarding renders it as a sub-state
 * of the about step. Two entry points, one module — a second copy would be two
 * places for the conflict default to drift, and that default is the one that
 * decides whether anything gets destroyed.
 *
 * `onDone` reports the categories of what was kept, which is all the caller
 * needs: onboarding uses them to stop asking questions the import answered, and
 * Settings ignores them.
 */
export function AiImportFlow({
  onDone, onCancel,
}: {
  onDone: (categories: readonly SuggestionCategory[]) => void;
  onCancel: () => void;
}) {
  const { t } = useApp();
  const replayEvent = useReplayEvent();
  const [state, dispatch] = useReducer(reduceImport, initialImport);
  const importing = useImportAiContext();
  const confirming = useConfirmAiContextImport();
  useClarityStage(`ai_import_${state.status}`);

  const copyPrompt = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(buildAssistantPrompt(t));
    } catch {
      // A refused pasteboard is not the end of anything: the question is on
      // screen in a card the user can select.
    }
  }, [t]);

  const pick = useCallback(async (assistant: ImportAssistant) => {
    dispatch({ type: 'pick', assistant });
    // The clipboard first, always. If the handoff opens the browser and the
    // copy had not happened yet, the user arrives at their assistant with
    // nothing to paste.
    await copyPrompt();
    const outcome = await openAssistant(ASSISTANTS[assistant].url);
    if (outcome === 'failed') dispatch({ type: 'openFailed' });
  }, [copyPrompt]);

  const paste = useCallback(async () => {
    const result = await readClipboardText(undefined, { maxLength: MAX_IMPORT_LENGTH });
    if (result.kind === 'empty') dispatch({ type: 'pasteEmpty' });
    else dispatch({ type: 'pasted', text: result.text });
  }, []);

  const read = useCallback(() => {
    if (!state.assistant || state.text.trim() === '') return;
    dispatch({ type: 'read' });
    importing.mutate(
      { text: state.text, assistant: state.assistant },
      {
        onSuccess: (proposal) => dispatch({ type: 'proposed', proposal }),
        onError: () => dispatch({ type: 'readFailed' }),
      },
    );
  }, [importing, state.assistant, state.text]);

  const save = useCallback(() => {
    const proposal = state.proposal;
    if (!proposal) return;
    const accepted = acceptedFrom(state);
    dispatch({ type: 'save' });
    confirming.mutate(
      { proposalId: proposal.proposalId, accepted },
      {
        onSuccess: () => {
          replayEvent('ai_import_confirmed');
          dispatch({ type: 'saved' });
          onDone(accepted.map(({ index }) => proposal.candidates[index]!.category as SuggestionCategory));
        },
        // Nothing was written and nobody has been told otherwise. The choices
        // stay exactly as they were and the primary button re-sends them.
        onError: () => dispatch({ type: 'saveFailed' }),
      },
    );
  }, [confirming, onDone, state, replayEvent]);

  // Three refusals the user can do something about, so they are named rather
  // than collapsed into "something went wrong". Everything else goes through
  // the reducer's `readFailed` and `userFacingMessage`, which is the only path
  // by which an error becomes words in this app.
  const refusal = importing.error instanceof ForbiddenError && importing.error.reason === 'consent_required'
    ? t.aiImportConsentNeeded
    : importing.error instanceof QuotaExceededError
      ? t.aiImportRateLimited
      : importing.error instanceof InputTooLargeError
        ? fill(t.aiImportPasteTooLong, { n: String(importing.error.maxCharacters) })
        : null;

  return (
    <View style={{ gap: 16 }} testID="ai-import-flow">
      {refusal ? <Notice text={refusal} testID="ai-import-refused" /> : null}

      {state.status === 'pick' ? (
        <AiImportPickStep onPick={(assistant) => void pick(assistant)} />
      ) : null}

      {state.status === 'handoff' && state.assistant ? (
        <AiImportHandoffStep
          assistant={state.assistant}
          openFailed={state.openFailed}
          onCopyAgain={() => void copyPrompt()}
          onReady={() => dispatch({ type: 'handedOff' })}
        />
      ) : null}

      {state.status === 'paste' || state.status === 'reading' ? (
        <AiImportPasteStep
          text={state.text}
          pasteEmpty={state.pasteEmpty}
          readFailed={state.readFailed}
          reading={state.status === 'reading'}
          onPaste={() => void paste()}
          onRead={read}
          onBack={onCancel}
        />
      ) : null}

      {(state.status === 'review' || state.status === 'saving') && state.proposal ? (
        <AiImportReviewStep
          proposal={state.proposal}
          kept={state.kept}
          edits={state.edits}
          resolutions={state.resolutions}
          expanded={state.expanded}
          saving={state.status === 'saving'}
          saveFailed={state.saveFailed}
          onExpand={() => dispatch({ type: 'expand' })}
          onToggle={(index) => dispatch({ type: 'toggle', index })}
          onEdit={(index, content) => dispatch({ type: 'edit', index, content })}
          onResolve={(index, resolve) => dispatch({ type: 'resolve', index, resolve })}
          onSave={save}
          onCancel={onCancel}
        />
      ) : null}
    </View>
  );
}
