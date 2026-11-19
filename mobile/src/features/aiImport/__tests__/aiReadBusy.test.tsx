/**
 * QA CXA1.4, CA8.1: when the model never read the text, the review screens
 * said "nothing to bring over" / "nothing to suggest from that", as though the
 * person's words held nothing. The server now marks such an answer
 * `degraded: true`, and both screens say the model is busy instead.
 */
import React from 'react';
import { afterEach, describe, expect, it } from '@jest/globals';
import { cleanup, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider } from '../../../state/AppContext';
import { AiImportReviewStep } from '../AiImportReviewStep';
import { AboutYouReviewStep } from '../../onboarding/AboutYouReviewStep';
import { aiContextImportProposalSchema } from '../../../api/schemas/aiContextImport';
import { profileProposalSchema } from '../../../api/schemas/profile';
import ar from '../../../i18n/locales/ar.json';
import en from '../../../i18n/locales/en.json';
import he from '../../../i18n/locales/he.json';

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const noop = () => undefined;

const IMPORT = {
  success: true as const, proposalId: 'p-1', assistant: 'chatgpt' as const, candidates: [],
  summary: { new: 0, updates: 0, conflicts: 0 },
  existingConsidered: 0, existingTotal: 0, existingTruncated: false,
  createdAt: '2026-11-19T08:00:00.000Z', promptVersion: 'ai-context-import-v2', model: null,
};

function wrap(node: React.ReactElement) {
  return <SafeAreaProvider initialMetrics={metrics}><AppProvider>{node}</AppProvider></SafeAreaProvider>;
}

function importStep(proposal: typeof IMPORT & { degraded?: boolean }) {
  return wrap(
    <AiImportReviewStep
      proposal={aiContextImportProposalSchema.parse(proposal)}
      kept={[]} edits={[]} resolutions={[]} expanded={false} saving={false} saveFailed={false}
      onExpand={noop} onToggle={noop} onEdit={noop} onResolve={noop} onSave={noop} onCancel={noop}
    />,
  );
}

afterEach(async () => { await cleanup(); });

describe('a model that never read the text (QA CXA1.4, CA8.1)', () => {
  it('the schemas keep the degraded mark', () => {
    expect(aiContextImportProposalSchema.parse({ ...IMPORT, degraded: true }).degraded).toBe(true);
    expect(profileProposalSchema.parse({
      success: true, proposalId: 'pp-1', suggestions: [], createdAt: IMPORT.createdAt,
      promptVersion: 'profile-v1', model: null, degraded: true,
    }).degraded).toBe(true);
  });

  it('import says busy, not "nothing to bring"', async () => {
    await render(importStep({ ...IMPORT, degraded: true }));
    expect(screen.getByTestId('ai-import-busy')).toBeTruthy();
    expect(screen.queryByTestId('ai-import-nothing')).toBeNull();
  });

  it('an import the model read and found nothing in still says so', async () => {
    await render(importStep({ ...IMPORT, degraded: false }));
    expect(screen.getByTestId('ai-import-nothing')).toBeTruthy();
    expect(screen.queryByTestId('ai-import-busy')).toBeNull();
  });

  it('the description review says busy, not "nothing to suggest"', async () => {
    await render(wrap(<AboutYouReviewStep suggestions={[]} degraded onSave={noop} onBack={noop} />));
    expect(screen.getByTestId('about-review-busy')).toBeTruthy();
    expect(screen.queryByTestId('about-review-none')).toBeNull();
  });

  it('the busy lines exist in all three languages and blame nobody', () => {
    for (const locale of [ar, en, he] as Array<Record<string, string>>) {
      expect(locale.aiImportReviewBusy).toBeTruthy();
      expect(locale.obAboutReviewBusy).toBeTruthy();
    }
    expect(ar.obAboutReviewBusy).toContain('جرّب بعد شوي');
    expect(ar.aiImportReviewBusy).toContain('جرّب بعد شوي');
  });
});
