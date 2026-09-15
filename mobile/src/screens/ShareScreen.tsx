/**
 * What another app handed over, before anything is done with it (UC-3.0, #183).
 *
 * The screen exists to make one sentence true: *nothing has left your phone
 * yet*. A share sheet is a place people tap by accident, and the thing tapped
 * by accident here is a chat history — so the app shows what it received, says
 * plainly that it is still local, and waits.
 *
 * ── It previews names and sizes, not thumbnails ──────────────────
 *
 * Deliberate, and the smaller claim on purpose: a name and a size are enough to
 * recognise what was shared, they cost no decode of a 15 MB HEIC, and they
 * cannot silently pull the file into an image cache. #183's sketch allows
 * thumbnails; nothing in its acceptance criteria needs them.
 *
 * ── Every refusal is a key, never a sentence ─────────────────────
 *
 * The words come from `t[messageKey]`, and the key from either the client-side
 * limits (`intake.ts`) or `userFacingMessageKey`. Neither path can put the
 * shared content, the file name or a server error's message on screen.
 */
import React from 'react';
import { ScrollView, View } from 'react-native';
import { useApp } from '../state/AppContext';
import { useShareIntake } from '../features/share/ShareProvider';
import type { SharedFile } from '../features/share/intake';
import { fill, ltr } from '../i18n/strings';
import { Card, Pill, Txt } from '../ui/primitives';

/** How much of a shared text is worth showing before Analyze. */
const PREVIEW_CHARACTERS = 600;

/**
 * A file size in words.
 *
 * Returns null for zero, which is what both platforms report when the OS would
 * not say. "0 KB" would be a claim about the file; nothing is the truth.
 */
function sizeLabel(bytes: number, t: { shareSizeKb: string; shareSizeMb: string }): string | null {
  if (bytes <= 0) return null;
  const kb = bytes / 1024;
  if (kb < 1024) return fill(t.shareSizeKb, { n: ltr(String(Math.max(1, Math.round(kb)))) });
  return fill(t.shareSizeMb, { n: ltr((kb / 1024).toFixed(1)) });
}

function FileRow({ file, index }: { file: SharedFile; index: number }) {
  const { t, p } = useApp();
  const size = sizeLabel(file.sizeBytes, t);
  return (
    <View style={{ gap: 2 }} testID={`share-file-${index}`}>
      {/* The user's own file name, on the user's own device. It is shown here
          and never sent to a log, a trace or the response (#183). */}
      <Txt size={15} weight={600} lines={2}>{file.fileName}</Txt>
      {size ? <Txt size={13} color={p.mu} latin>{size}</Txt> : null}
    </View>
  );
}

export function ShareScreen() {
  const { t, p, actions } = useApp();
  const { state, analyze, discard } = useShareIntake();
  const busy = state.status === 'analyzing';
  const blocked = state.status === 'needsConsent';
  const problem = state.messageKey ? t[state.messageKey] : null;

  if (state.status === 'unavailable') {
    return (
      <View testID="share-screen" style={{ flex: 1, backgroundColor: p.bg }}>
        <ScrollView contentContainerStyle={{ padding: 24, gap: 18, flexGrow: 1, justifyContent: 'center' }}>
          <Txt size={26} weight={600}>{t.shareTitle}</Txt>
          <Txt size={15} color={p.mu} testID="share-notice">{t.shareUnavailable}</Txt>
          <Pill label={t.back} kind="soft" onPress={() => actions.go('today')} testID="share-back" />
        </ScrollView>
      </View>
    );
  }

  const payload = state.payload;

  return (
    <View testID="share-screen" style={{ flex: 1, backgroundColor: p.bg }}>
      <ScrollView contentContainerStyle={{ padding: 24, gap: 18, flexGrow: 1 }}>
        <Txt size={26} weight={600}>{t.shareTitle}</Txt>
        <Txt size={15} color={p.mu}>{t.shareNothingSentYet}</Txt>

        {payload?.text ? (
          <Card pad={18}>
            <Txt size={15} testID="share-preview-text">
              {payload.text.slice(0, PREVIEW_CHARACTERS)}
            </Txt>
          </Card>
        ) : null}

        {payload && payload.files.length > 0 ? (
          <Card pad={18} style={{ gap: 14 }} testID="share-preview-files">
            {payload.files.map((file, index) => (
              <FileRow key={file.uri} file={file} index={index} />
            ))}
          </Card>
        ) : null}

        {problem ? (
          <Txt size={15} color={p.wm} testID="share-problem">{problem}</Txt>
        ) : null}

        {busy ? <Txt size={15} color={p.mu} testID="share-analyzing">{t.shareAnalyzing}</Txt> : null}

        {/* The same promise the review screen makes, in the same words, before
            the user has committed to anything. */}
        <Txt size={13} color={p.mu}>{t.suggestionNote}</Txt>

        {/* `disabled` is the only guard, and it is enough: `Pill` drops the
            handler itself while it is set, so there is no second place for the
            two to disagree about whether an upload is in flight. */}
        <View style={{ gap: 10 }}>
          {/* Reading a picture or a file is a model call, and the user has not
              agreed to those. The way forward is the Trust screen, the same
              place `CaptureScreen`'s AI chip goes — and the payload survives
              the trip, because this provider is mounted above the screens, so
              they can agree and come straight back to it. */}
          {blocked ? (
            <Pill
              label={t.shareTurnOnAi}
              kind="soft"
              onPress={() => actions.go('trust')}
              testID="share-turn-on-ai"
            />
          ) : null}
          {payload && !blocked ? (
            <Pill
              label={t.analyze}
              kind="accent"
              disabled={busy}
              onPress={() => void analyze()}
              testID="share-analyze"
            />
          ) : null}
          <Pill
            label={t.shareDiscard}
            kind="soft"
            disabled={busy}
            onPress={discard}
            testID="share-discard"
          />
        </View>
      </ScrollView>
    </View>
  );
}
