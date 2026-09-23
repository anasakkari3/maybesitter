import { describe, expect, it } from '@jest/globals';
import { back, closeTask, derive, go, initialNav } from '../../../state/navigation';

describe('product expansion shares existing navigation history', () => {
  it('assistant → add → capture returns to add with no duplicate flow', () => {
    const assistant = go(initialNav, 'contextualAssistant');
    const add = go(assistant, 'addToMaybeSitter');
    const capture = go(add, 'capture');
    expect(derive(capture).screen).toBe('capture');
    expect(derive(closeTask(capture)).screen).toBe('addToMaybeSitter');
    expect(derive(back(add)).screen).toBe('contextualAssistant');
    expect(derive(back(assistant)).screen).toBe('today');
  });
  it('Google details preserve the integrations and profile history', () => {
    const profile = go(go(initialNav, 'settings'), 'myMaybeSitter');
    const hub = go(profile, 'integrations');
    const detail = go(hub, 'googleIntegration');
    expect(derive(back(detail)).screen).toBe('integrations');
    expect(derive(back(back(detail))).screen).toBe('myMaybeSitter');
  });
  it('calendar → commitments → add → back preserves the calendar stack', () => {
    const list = go(go(initialNav, 'calendar'), 'commitments');
    const add = go(list, 'addToMaybeSitter');
    expect(derive(back(add)).screen).toBe('commitments');
    expect(derive(back(list))).toMatchObject({ screen: 'calendar', showTabs: true });
  });
});
