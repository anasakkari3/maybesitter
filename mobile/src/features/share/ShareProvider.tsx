/**
 * One share, from the moment another app hands it over until it is a proposal
 * or gone (UC-3.0, #183).
 *
 * ── Why this holds the payload and `AppContext` does not ─────────
 *
 * The same reason `CaptureProvider` holds the draft: a shared chat export is
 * the most sensitive content this product ever touches, and putting it in the
 * app-wide store would give it the app's lifetime instead of the flow's. This
 * is mounted inside `Root`, so signing out unmounts it and the payload goes
 * with it — and so does the last reference to the file paths, which is why the
 * unmount effect deletes them rather than trusting a screen to.
 *
 * ── The screen's state is derived, not stored ────────────────────
 *
 * What is on screen is a function of two things: the intent the native module
 * is holding, and whether an upload is in flight or has failed. Only the second
 * is state here, and it is only ever set from a button's handler.
 *
 * That is not stylistic. The first version copied the normalised payload into
 * `useState` from inside the arrival effect, which is a synchronous setState in
 * an effect body — a cascading render, and an `eslint react-hooks` error. It
 * also meant the same fact lived in two places: the native module's intent and
 * our copy of it, free to disagree the moment one was cleared without the other.
 *
 * So the native intent is left alone until the share is *finished* — analysed
 * or discarded — and `resetShareIntent()` is what ends it.
 *
 * ── Nothing is persisted, here or anywhere below ─────────────────
 *
 * No storage import. The bytes of a text, PDF or archive share never enter
 * JavaScript at all: `apiUpload` passes React Native a `{ uri, name, type }`
 * descriptor and the platform streams the file, so a 15 MB share is never a
 * string in the JS heap.
 *
 * A picture is the one exception, and `prepareImages.ts` is where it happens
 * and why (UC-3.6, #190): no EXIF may be in the upload, removing a segment
 * means rewriting the file, and rewriting means reading it. One image at a
 * time is read, rewritten into the cache directory and dropped; the copies are
 * deleted alongside the OS's own on every exit from this flow.
 *
 * ── Consent and the flag are both checked before the upload ──────
 *
 * Neither is asked of the server first. A share that needs the model and has no
 * consent, and a share into a build with the feature off, are both refused on
 * the phone — because the alternative is uploading somebody's screenshot to be
 * told no.
 *
 * ── The flag is checked before the upload, not after ─────────────
 *
 * With `EXPO_PUBLIC_FEATURE_SHARE_INTAKE` off, a share still opens the app and
 * still shows a notice — that is the acceptance criterion — but it is refused
 * here, and the temporary copies are deleted immediately. Asking the server
 * first would upload somebody's screenshot to be told the feature is off.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../state/AppContext';
import { useAiConsentGranted, useProposeFromShare } from '../../api/queries';
import { userFacingMessageKey, type UserFacingKey } from '../../api/ui/userFacingMessage';
import { shareIntakeEnabled } from '../../config/env';
import { deleteSharedFiles } from '../../lib/shareFiles';
import { sharedImageBytes } from '../../lib/shareImages';
import { useCaptureFlow } from '../capture/CaptureProvider';
import { prepareImages } from './prepareImages';
import { ShareIntentHost, useNativeShareIntent } from './shareIntentBridge';
import {
  normalizeShareIntent,
  urisOf,
  urisOfIntent,
  type SharedPayload,
  type SharePayloadProblem,
} from './intake';

/**
 * What the share screen is showing.
 *
 *  - `idle` — nothing has been shared; the screen is not reachable.
 *  - `ready` — a payload is previewed and nothing has left the phone.
 *  - `analyzing` — the one upload is in flight.
 *  - `failed` — a refusal, on device or from the server. `messageKey` says why.
 *  - `unavailable` — this build does not offer share. Nothing was sent.
 *  - `needsConsent` — reading this needs the model, and the user has not agreed
 *    to that. Nothing was sent.
 */
export type ShareStatus = 'idle' | 'ready' | 'analyzing' | 'failed' | 'unavailable' | 'needsConsent';

export interface ShareIntakeState {
  status: ShareStatus;
  /** Null unless there is something the user could still analyse. */
  payload: SharedPayload | null;
  /** The locale key for a refusal. Never a sentence built from an error. */
  messageKey: UserFacingKey | null;
}

const IDLE: ShareIntakeState = { status: 'idle', payload: null, messageKey: null };

/** Where the one upload has got to. The only thing here that is state. */
type Phase =
  | { kind: 'idle' }
  | { kind: 'analyzing' }
  | { kind: 'failed'; messageKey: UserFacingKey };

/**
 * A client-side refusal, as one locale key.
 *
 * A closed record rather than a `switch` with a default, so adding a reason to
 * `SharePayloadProblem` without giving the user words for it fails `tsc`.
 */
/**
 * The kinds that cannot be read without a model (UC-2.1 #161, UC-3.0 #183).
 *
 * A typed sentence analyses either way — the server falls back to the rule-based
 * extractor and makes no model call, which is why `CaptureScreen`'s AI chip
 * says what will happen rather than gating anything. An image, a PDF or a chat
 * archive is not like that: there is no rule-based way to read a screenshot, so
 * from #190 on a share of one *is* a model call.
 *
 * Uploading it anyway would be the worst of both: the bytes cross the network,
 * one of the user's thirty daily shares is spent, and the answer is a refusal
 * they could have been told about before anything left the phone. So this is
 * checked here, and text still behaves exactly like typed capture.
 */
const NEEDS_MODEL: ReadonlySet<SharedPayload['kind']> = new Set(['images', 'pdf', 'chatArchive']);

const PROBLEM_KEY: Readonly<Record<SharePayloadProblem, UserFacingKey>> = {
  empty: 'shareEmpty',
  too_many_files: 'shareTooManyFiles',
  file_too_large: 'shareTooLarge',
  text_too_long: 'shareTextTooLong',
  unsupported: 'shareUnsupported',
};

export interface ShareContextValue {
  state: ShareIntakeState;
  /** Uploads the payload and, on success, hands the proposal to review. */
  analyze(): Promise<void>;
  /** Deletes the copies, forgets the share and goes home. Persists nothing. */
  discard(): void;
}

const ShareContext = createContext<ShareContextValue | null>(null);

function ShareIntake({ children }: { children: React.ReactNode }) {
  const { actions } = useApp();
  const { hasShareIntent, shareIntent, reset } = useNativeShareIntent();
  const { adoptProposal } = useCaptureFlow();
  const propose = useProposeFromShare();
  // `asked` matters as much as `granted`: while the answer is still loading,
  // `granted` is false and refusing then would show the notice to somebody who
  // has in fact agreed.
  const { granted: aiGranted, asked: aiAsked } = useAiConsentGranted();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const enabled = shareIntakeEnabled();
  const normalized = useMemo(
    () => (hasShareIntent ? normalizeShareIntent(shareIntent) : null),
    [hasShareIntent, shareIntent],
  );
  /** What the user could still send. Null when there is nothing sendable. */
  const payload = enabled && normalized?.ok ? normalized.payload : null;

  /** Whether sending this would need a model the user has not agreed to. */
  const blockedOnConsent = Boolean(payload) && NEEDS_MODEL.has(payload!.kind) && aiAsked && !aiGranted;

  const state = useMemo<ShareIntakeState>(() => {
    if (phase.kind === 'analyzing') return { status: 'analyzing', payload, messageKey: null };
    if (phase.kind === 'failed') return { status: 'failed', payload, messageKey: phase.messageKey };
    if (!normalized) return IDLE;
    if (!enabled) return { status: 'unavailable', payload: null, messageKey: 'shareUnavailable' };
    if (!normalized.ok) return { status: 'failed', payload: null, messageKey: PROBLEM_KEY[normalized.problem] };
    // After the refusals and before `ready`: the preview still shows, because
    // seeing what was shared is not the part that needs consent.
    if (blockedOnConsent) return { status: 'needsConsent', payload, messageKey: 'shareNeedsAi' };
    return { status: 'ready', payload, messageKey: null };
  }, [blockedOnConsent, enabled, normalized, payload, phase]);

  /**
   * The live payload and the callbacks the effects need, out of the render.
   *
   * The unmount cleanup has to know which files to delete at a moment when it
   * can read nothing else, and the arrival effect must not re-run because a
   * function identity changed.
   */
  const held = useRef<SharedPayload | null>(null);
  /** The stripped copies this share wrote, which nothing else knows about. */
  const created = useRef<readonly string[]>([]);
  const latest = useRef({ go: actions.go, reset, adoptProposal });
  // Kept current in an effect rather than during render, and declared *first*
  // so the effects below — which run in declaration order within one commit —
  // never read a callback from the render before last.
  useEffect(() => { latest.current = { go: actions.go, reset, adoptProposal }; });
  useEffect(() => { held.current = payload; }, [payload]);

  /*
   * Whatever unmounts this tree — signing out, deleting the account, a hot
   * reload — takes the last reference to the paths with it. Deleting here is
   * the only way the criterion holds for a user who shares something and then
   * signs out without touching the screen.
   */
  useEffect(() => () => {
    deleteSharedFiles([...urisOf(held.current), ...created.current]);
    created.current = [];
    held.current = null;
  }, []);

  /**
   * A share has arrived: show it, and delete anything that will never be sent.
   *
   * No state is set here. The screen is a function of the intent, so "a share
   * arrived" needs nothing recorded — only the two side effects that are not
   * React's: the navigation, and the files.
   */
  useEffect(() => {
    if (!normalized) return;
    latest.current.go('share');
    // Off, or refused on device. Nothing will be previewed and nothing
    // uploaded, so the copies the OS made are of no further use to anyone:
    // they go now rather than when a screen happens to unmount.
    if (!enabled || !normalized.ok) deleteSharedFiles(urisOfIntent(shareIntent));
  }, [enabled, normalized, shareIntent]);

  /** Deletes the copies this share left behind and forgets it. Idempotent. */
  const clear = useCallback(() => {
    // Both sets: the copy the OS made, and the stripped copy `prepareImages`
    // wrote beside it. Missing the second would leave a photograph in the cache
    // directory for the life of the install (UC-3.6, #190).
    deleteSharedFiles([...urisOf(held.current), ...created.current]);
    created.current = [];
    held.current = null;
    latest.current.reset();
    setPhase({ kind: 'idle' });
  }, []);

  const analyze = useCallback(async () => {
    const sending = held.current;
    if (!sending) return;
    // The same check the state derives, re-read here rather than trusted from a
    // render: this is the line the bytes would cross on, and a stale closure
    // must not be what decides.
    if (NEEDS_MODEL.has(sending.kind) && aiAsked && !aiGranted) return;
    setPhase({ kind: 'analyzing' });

    /*
     * Pictures are rewritten before anything leaves the phone (UC-3.6, #190).
     *
     * Before `setPhase`'s upload and before any consent or flag question has
     * been asked of the network, because the criterion is about the *upload*:
     * a photograph's GPS coordinates that reach the server and are stripped
     * there have already crossed the network.
     *
     * A picture this cannot account for byte by byte refuses the share rather
     * than uploading it unstripped. The copies made so far are deleted either
     * way — `created` comes back on both paths for exactly that reason.
     */
    let uploading = sending.files;
    if (sending.kind === 'images') {
      const stripped = prepareImages(sending.files, sharedImageBytes);
      if (!stripped.ok) {
        deleteSharedFiles(stripped.created);
        setPhase({ kind: 'failed', messageKey: PROBLEM_KEY[stripped.problem] });
        return;
      }
      created.current = stripped.prepared.created;
      uploading = stripped.prepared.files;
    }

    try {
      const proposal = await propose.mutateAsync({
        ...(sending.text === undefined ? {} : { text: sending.text }),
        files: uploading.map((file) => ({
          uri: file.uri,
          // The server reads the name once to guess a source and then drops it.
          name: file.fileName,
          type: file.mimeType,
        })),
        sourceHint: sending.sourceHint,
      });
      // The copies go before review opens, not after it closes: the share has
      // been read, the proposal is in memory, and there is nothing left the
      // files are needed for.
      clear();
      latest.current.adoptProposal(proposal);
      latest.current.go('capture');
    } catch (error) {
      // The payload is kept so the user can try again on a network failure.
      // `userFacingMessageKey` never interpolates the error's message, which on
      // this route could quote what was shared.
      setPhase({ kind: 'failed', messageKey: userFacingMessageKey(error) });
    }
  }, [aiAsked, aiGranted, clear, propose]);

  const discard = useCallback(() => {
    clear();
    actions.go('today');
  }, [actions, clear]);

  const value = useMemo<ShareContextValue>(() => ({ state, analyze, discard }), [state, analyze, discard]);
  return <ShareContext.Provider value={value}>{children}</ShareContext.Provider>;
}

/**
 * The provider `Root` mounts.
 *
 * Two layers because the library's context has to be above the code that reads
 * it. `ShareIntentHost` is the only thing that imports the native module; a
 * build without the share extension mounts it and it reports nothing.
 */
export function ShareProvider({ children }: { children: React.ReactNode }) {
  return (
    <ShareIntentHost>
      <ShareIntake>{children}</ShareIntake>
    </ShareIntentHost>
  );
}

export function useShareIntake(): ShareContextValue {
  const value = useContext(ShareContext);
  if (!value) throw new Error('useShareIntake must be used inside a ShareProvider');
  return value;
}
