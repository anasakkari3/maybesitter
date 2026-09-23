import React from 'react';
import { TextInput, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { fill } from '../../i18n/strings';
import { Btn, Card, Txt } from '../../ui/primitives';
import { Notice, SectionLabel, Tag } from '../../ui/chrome';
import type { AiContextImportProposal, ImportCandidate } from '../../api/schemas/aiContextImport';
import type { ImportResolution } from './aiImportMachine';
import { Footer, PrimaryButton, SecondaryButton } from './AiImportButtons';

/**
 * What we found, and the one decision the user actually has to make.
 *
 * ── Keep all is the primary, and review is opt-in ────────────────
 *
 * Eighteen checkboxes is a form, and a form at the end of a minute-long flow is
 * where people stop. So the default is three summary lines and one button, and
 * "look at them one by one" is there for anyone who wants it. Every row starts
 * kept either way — nothing is written until one of the two buttons is pressed.
 *
 * ── Except a conflict, which is never decided for them ───────────
 *
 * A conflict is the server saying two sentences cannot both be true. Its
 * section sits *above* the summary and says plainly that pressing Keep all
 * leaves both of them in place. That is the fail-safe: nothing the user did not
 * ask for is destroyed. It is also a real product state — somebody can walk out
 * of here with two sentences that disagree — so the copy carries it rather than
 * hiding it.
 *
 * ── The truncation line is not a detail ──────────────────────────
 *
 * When the account has more records than the model was shown, a candidate that
 * duplicates an older one comes back as "new". Saying which records were
 * compared against is the difference between an honest list and one the user
 * believes was complete.
 */
export function AiImportReviewStep({
  proposal, kept, edits, resolutions, expanded, saving, saveFailed,
  onExpand, onToggle, onEdit, onResolve, onSave, onCancel,
}: {
  proposal: AiContextImportProposal;
  kept: readonly boolean[];
  edits: readonly string[];
  resolutions: readonly ImportResolution[];
  expanded: boolean;
  saving: boolean;
  saveFailed: boolean;
  onExpand: () => void;
  onToggle: (index: number) => void;
  onEdit: (index: number, content: string) => void;
  onResolve: (index: number, resolve: ImportResolution) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { t, p, tr } = useApp();
  const keptCount = kept.filter(Boolean).length;
  const conflicts = proposal.candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => candidate.relation === 'conflict');

  if (proposal.candidates.length === 0) {
    return (
      <View style={{ gap: 16 }}>
        <Txt size={20} weight={600}>{t.aiImportReviewTitle}</Txt>
        <Notice text={t.aiImportReviewNothing} testID="ai-import-nothing" />
        <Footer>
          <PrimaryButton label={t.done} onPress={onCancel} testID="ai-import-nothing-done" />
        </Footer>
      </View>
    );
  }

  return (
    <View style={{ gap: 16 }}>
      <Txt size={20} weight={600}>{t.aiImportReviewTitle}</Txt>

      <Card pad={18} style={{ gap: 8 }} testID="ai-import-summary">
        <Txt size={14} color={p.mu}>{tr('aiImportSummaryNewN', { n: proposal.summary.new })}</Txt>
        <Txt size={14} color={p.mu}>{tr('aiImportSummaryUpdatesN', { n: proposal.summary.updates })}</Txt>
        <Txt size={14} color={p.mu}>{tr('aiImportSummaryConflictsN', { n: proposal.summary.conflicts })}</Txt>
        {proposal.existingTruncated ? (
          <Txt size={13} color={p.mu} testID="ai-import-truncated">
            {fill(t.aiImportTruncated, { n: String(proposal.existingConsidered) })}
          </Txt>
        ) : null}
      </Card>

      {conflicts.length > 0 ? (
        <View style={{ gap: 10 }}>
          <SectionLabel testID="ai-import-conflict-heading">{t.aiImportConflictTitle}</SectionLabel>
          <Notice text={t.aiImportConflictDefault} testID="ai-import-conflict-default" />
          {conflicts.map(({ candidate, index }) => (
            <Card key={index} pad={16} style={{ gap: 10 }} testID={`ai-import-conflict-${index}`}>
              <Txt size={15} lh={1.5}>{candidate.content}</Txt>
              <ConflictChoice
                index={index}
                resolve={resolutions[index] ?? 'keep_both'}
                onResolve={onResolve}
              />
            </Card>
          ))}
        </View>
      ) : null}

      {expanded ? (
        <View style={{ gap: 10 }}>
          {proposal.candidates.map((candidate, index) => (
            <CandidateRow
              key={index}
              index={index}
              candidate={candidate}
              kept={kept[index] ?? true}
              edit={edits[index] ?? ''}
              onToggle={onToggle}
              onEdit={onEdit}
            />
          ))}
        </View>
      ) : null}

      {saveFailed ? <Notice text={t.aiImportFailed} testID="ai-import-save-failed" /> : null}

      <Footer>
        <PrimaryButton
          label={saving ? t.aiImportSaving : tr('aiImportKeepAllN', { n: keptCount })}
          disabled={saving || keptCount === 0}
          onPress={onSave}
          testID="ai-import-keep-all"
        />
        {expanded ? null : (
          <SecondaryButton label={t.aiImportReview} onPress={onExpand} testID="ai-import-review" />
        )}
        <SecondaryButton label={t.cancel} onPress={onCancel} testID="ai-import-cancel" />
      </Footer>
    </View>
  );
}

function ConflictChoice({
  index, resolve, onResolve,
}: {
  index: number;
  resolve: ImportResolution;
  onResolve: (index: number, resolve: ImportResolution) => void;
}) {
  const { t, p } = useApp();
  const options: readonly { value: ImportResolution; label: string; testID: string }[] = [
    { value: 'keep_both', label: t.aiImportConflictKeepBoth, testID: `ai-import-conflict-${index}-keep-both` },
    { value: 'replace', label: t.aiImportConflictReplace, testID: `ai-import-conflict-${index}-replace` },
  ];

  return (
    <View style={{ flexDirection: 'row', gap: 10 }}>
      {options.map((option) => (
        <Btn
          key={option.value}
          label={option.label}
          // A single choice, so a screen reader says so rather than announcing
          // two independent buttons.
          accessibilityRole="radio"
          onPress={() => onResolve(index, option.value)}
          testID={option.testID}
          style={{
            flex: 1, minHeight: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
            borderWidth: 1,
            borderColor: resolve === option.value ? p.ac : p.ln,
            backgroundColor: resolve === option.value ? p.sf2 : 'transparent',
          }}
        >
          <Txt size={14} color={resolve === option.value ? p.ac : p.mu}>{option.label}</Txt>
        </Btn>
      ))}
    </View>
  );
}

function CandidateRow({
  index, candidate, kept, edit, onToggle, onEdit,
}: {
  index: number;
  candidate: ImportCandidate;
  kept: boolean;
  edit: string;
  onToggle: (index: number) => void;
  onEdit: (index: number, content: string) => void;
}) {
  const { t, p } = useApp();
  const [editing, setEditing] = React.useState(false);

  const relationLabel = candidate.relation === 'update'
    ? t.aiImportRelationUpdate
    : candidate.relation === 'conflict'
      ? t.aiImportRelationConflict
      : t.aiImportRelationNew;

  return (
    <Card pad={16} style={{ gap: 10 }} testID={`ai-import-candidate-${index}`}>
      <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
        <Btn
          label={candidate.content}
          accessibilityRole="checkbox"
          onPress={() => onToggle(index)}
          scaleTo={0.9}
          hitSlop={8}
          testID={`ai-import-candidate-${index}-toggle`}
          style={{
            width: 26, height: 26, borderRadius: 13, marginTop: 2,
            borderWidth: 2,
            borderColor: kept ? p.ac : p.ln,
            backgroundColor: kept ? p.ac : 'transparent',
          }}
        >
          <View />
        </Btn>
        <View style={{ flex: 1, gap: 6 }}>
          <Txt size={15} lh={1.5}>{edit.trim() !== '' ? edit : candidate.content}</Txt>
          {/* `proposal` whatever the relation is: the dashed proposal colour is
              this design's one visual promise that nothing has been written
              yet, and that is true of an update and a conflict as much as of a
              new line. The relation is carried by the words. */}
          <Tag kind="proposal" label={relationLabel} testID={`ai-import-candidate-${index}-relation`} />
        </View>
      </View>

      {editing ? (
        <TextInput
          value={edit !== '' ? edit : candidate.content}
          onChangeText={(value) => onEdit(index, value)}
          multiline
          testID={`ai-import-candidate-${index}-input`}
          style={{ color: p.tx, fontSize: 15, minHeight: 44, borderWidth: 1, borderColor: p.ln, borderRadius: 12, padding: 10 }}
        />
      ) : (
        <Btn
          label={t.memoryEdit}
          onPress={() => setEditing(true)}
          hitSlop={8}
          testID={`ai-import-candidate-${index}-edit`}
          style={{ minHeight: 32, justifyContent: 'center' }}
        >
          <Txt size={14} color={p.ac}>{t.memoryEdit}</Txt>
        </Btn>
      )}
    </Card>
  );
}
