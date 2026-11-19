/**
 * de7fcb84 audit CXA8.9: the conflict card asked «استعمل الجديد» while
 * showing only the new line; the saved preference it would replace appeared
 * nowhere on the review. The card now says what is there now, from the
 * person's own memory list (the id is already the app's: `relatesToId`).
 */
import React from 'react';
import { expect, it } from '@jest/globals';
import { render, screen, within } from '@testing-library/react-native';
import { AppProvider } from '../../../state/AppContext';
import { AiImportReviewStep } from '../AiImportReviewStep';
import type { AiContextImportProposal } from '../../../api/schemas/aiContextImport';

const PROPOSAL = {
  success: true,
  proposalId: 'p1',
  assistant: 'other',
  candidates: [
    { kind: 'preference', category: 'routine', content: 'I prefer to work early in the morning', targetDate: null, confidence: 0.9, relation: 'conflict', relatesToId: 'mem_night' },
  ],
  summary: { new: 0, updates: 0, conflicts: 1 },
  existingConsidered: 1,
  existingTotal: 1,
  existingTruncated: false,
  createdAt: '2026-11-13T07:00:00.000Z',
  promptVersion: 'v1',
  model: null,
} as unknown as AiContextImportProposal;

const noop = () => undefined;

async function show(existing: ReadonlyMap<string, string>) {
  await render(<AppProvider><AiImportReviewStep
    proposal={PROPOSAL} kept={[true]} edits={['']} resolutions={['keep_both']} expanded={false} saving={false} saveFailed={false}
    existing={existing}
    onExpand={noop} onToggle={noop} onEdit={noop} onResolve={noop} onSave={noop} onCancel={noop}
  /></AppProvider>);
}

it('the conflict card shows the saved line it would replace', async () => {
  await show(new Map([['mem_night', 'I prefer to work at night, not in the morning']]));
  const card = screen.getByTestId('ai-import-conflict-0');
  expect(within(card).getByTestId('ai-import-conflict-0-existing')).toBeTruthy();
  expect(within(card).getByText(/I prefer to work at night, not in the morning/)).toBeTruthy();
});

it('says nothing it does not know when the saved line is not in the list', async () => {
  await show(new Map());
  expect(screen.queryByTestId('ai-import-conflict-0-existing')).toBeNull();
});
