/**
 * The order bringing context in is allowed to happen in.
 *
 * ── Why a reducer and not booleans on a screen ───────────────────
 *
 * Every step of this flow is a step where something must *not* happen. The
 * clipboard must not be read before the user presses paste; the server must not
 * be called before there is text; a confirm must not be sent twice; a conflict
 * must not resolve itself. Five independent booleans is five ways for two of
 * those to be true at once, and the one that matters — "we already sent the
 * confirm" — is the one that costs a duplicated write when it goes wrong. One
 * status cannot be in two states.
 *
 * ── The pasted text is dropped as soon as it is spent ────────────
 *
 * `proposed` clears `text`. The screen has no further use for it, the server
 * never stored it, and the longest piece of prose about a person this app ever
 * holds should not outlive its purpose inside a reducer that a screenshot or a
 * dev-tools inspection can read.
 */
import type { AiContextImportProposal, ImportCandidate } from '../../api/schemas/aiContextImport';
import type { ImportAssistant } from './assistants';

export type ImportResolution = 'replace' | 'keep_both';

export type ImportStatus =
  /** Choosing which assistant. */
  | 'pick'
  /** The steps are on screen; the button copies the question and opens the assistant. */
  | 'handoff'
  /** Waiting for the answer to be pasted back. */
  | 'paste'
  /** The server is reading it. */
  | 'reading'
  /** The candidates are on screen. */
  | 'review'
  | 'saving'
  | 'done';

export interface ImportState {
  readonly status: ImportStatus;
  readonly assistant: ImportAssistant | null;
  readonly text: string;
  readonly proposal: AiContextImportProposal | null;
  /** One per candidate, all true when the candidates arrive. */
  readonly kept: readonly boolean[];
  /** One per candidate; an empty string means untouched. */
  readonly edits: readonly string[];
  /** One per candidate. Only read on a conflict; defaults to keeping both. */
  readonly resolutions: readonly ImportResolution[];
  /** Whether the rows are showing, as opposed to the three summary lines. */
  readonly expanded: boolean;
  readonly openFailed: boolean;
  readonly pasteEmpty: boolean;
  readonly readFailed: boolean;
  readonly saveFailed: boolean;
}

export type ImportAction =
  | { type: 'pick'; assistant: ImportAssistant }
  | { type: 'handedOff' }
  | { type: 'openFailed' }
  | { type: 'pasted'; text: string }
  | { type: 'pasteEmpty' }
  | { type: 'read' }
  | { type: 'readFailed' }
  | { type: 'proposed'; proposal: AiContextImportProposal }
  | { type: 'expand' }
  | { type: 'toggle'; index: number }
  | { type: 'edit'; index: number; content: string }
  | { type: 'resolve'; index: number; resolve: ImportResolution }
  | { type: 'save' }
  | { type: 'saved' }
  | { type: 'saveFailed' }
  | { type: 'restart' };

export const initialImport: ImportState = {
  status: 'pick',
  assistant: null,
  text: '',
  proposal: null,
  kept: [],
  edits: [],
  resolutions: [],
  expanded: false,
  openFailed: false,
  pasteEmpty: false,
  readFailed: false,
  saveFailed: false,
};

function replaceAt<T>(list: readonly T[], index: number, value: T): readonly T[] {
  return list.map((existing, i) => (i === index ? value : existing));
}

export function reduceImport(state: ImportState, action: ImportAction): ImportState {
  switch (action.type) {
    case 'pick':
      return { ...state, status: 'handoff', assistant: action.assistant, openFailed: false };

    case 'handedOff':
      return { ...state, status: 'paste' };

    case 'openFailed':
      // The step stays. A failed handoff means the user copies the question
      // themselves, which the screen offers — it does not mean the flow is over.
      return { ...state, status: 'handoff', openFailed: true };

    case 'pasted':
      // Text arriving before the handoff is a bug in a caller: the paste button
      // does not exist yet. Ignored rather than trusted.
      if (state.status !== 'paste') return state;
      return { ...state, text: action.text, pasteEmpty: false, readFailed: false };

    case 'pasteEmpty':
      if (state.status !== 'paste') return state;
      // Whatever they pasted before stays. An empty clipboard is a fact about
      // the device, not a reason to discard work.
      return { ...state, pasteEmpty: true };

    case 'read':
      if (state.status !== 'paste' || state.text.trim() === '') return state;
      return { ...state, status: 'reading', readFailed: false };

    case 'readFailed':
      return { ...state, status: 'paste', readFailed: true };

    case 'proposed':
      return {
        ...state,
        status: 'review',
        proposal: action.proposal,
        // Everything starts kept, so "Keep all" is one press and the review is
        // opt-in. Nothing is written by either path until the user says so.
        kept: action.proposal.candidates.map(() => true),
        edits: action.proposal.candidates.map(() => ''),
        // Keep both, every time, until the user chooses otherwise. The default
        // has to be the one that destroys nothing.
        resolutions: action.proposal.candidates.map(() => 'keep_both' as const),
        expanded: false,
        // Spent. See the header.
        text: '',
      };

    case 'expand':
      return { ...state, expanded: true };

    case 'toggle':
      return { ...state, kept: replaceAt(state.kept, action.index, !state.kept[action.index]) };

    case 'edit':
      return { ...state, edits: replaceAt(state.edits, action.index, action.content) };

    case 'resolve':
      return { ...state, resolutions: replaceAt(state.resolutions, action.index, action.resolve) };

    case 'save':
      if (state.status !== 'review') return state;
      return { ...state, status: 'saving', saveFailed: false };

    case 'saved':
      return { ...state, status: 'done' };

    case 'saveFailed':
      // Back to the choices, with them intact, so the primary button re-sends
      // the very same ones. Nothing was written.
      return { ...state, status: 'review', saveFailed: true };

    case 'restart':
      return initialImport;

    default:
      return state;
  }
}

export interface AcceptedImportRow {
  index: number;
  content?: string;
  resolve?: ImportResolution;
}

/**
 * What the confirm request carries.
 *
 * An edit is sent only when it says something different: whitespace, or the
 * same words back, would otherwise mark the row `user_stated` and claim the user
 * wrote a sentence they merely left alone. A resolution is sent only on a
 * conflict, because it means nothing anywhere else.
 */
export function acceptedFrom(state: ImportState): AcceptedImportRow[] {
  const candidates: readonly ImportCandidate[] = state.proposal?.candidates ?? [];
  const rows: AcceptedImportRow[] = [];

  candidates.forEach((candidate, index) => {
    if (!state.kept[index]) return;
    const edited = (state.edits[index] ?? '').trim();
    rows.push({
      index,
      ...(edited !== '' && edited !== candidate.content ? { content: edited } : {}),
      ...(candidate.relation === 'conflict'
        ? { resolve: state.resolutions[index] ?? 'keep_both' }
        : {}),
    });
  });

  return rows;
}
