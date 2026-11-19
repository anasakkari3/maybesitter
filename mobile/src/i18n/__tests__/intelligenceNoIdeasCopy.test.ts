/**
 * The empty suggestions line must not ask the person to say something (QA CA7.6).
 *
 * «افهم كلامي» reads what the person said and re-reads the inbox; it never
 * asks the model for suggestions, and the owner decided on 2026-11-19 not to
 * add that call. So a line that invites the person to tell us more promises a
 * result that does not follow: they speak, see «فهمت N إشي», and the same
 * "no suggestions yet" line again. The line says where suggestions appear,
 * and asks for nothing.
 */
import { describe, expect, it } from '@jest/globals';
import ar from '../locales/ar.json';
import en from '../locales/en.json';
import he from '../locales/he.json';

describe('xIntelligenceNoIdeas (QA CA7.6)', () => {
  it('Arabic does not invite the person to speak or write', () => {
    expect(ar.xIntelligenceNoIdeas).not.toMatch(/احكي|احكيلي|اكتب|ضيف|خبّرني/);
    expect(ar.xIntelligenceNoIdeas).toContain('لسّا ما في اقتراحات');
  });

  it('English does not ask the person to add or tell anything', () => {
    expect(en.xIntelligenceNoIdeas).not.toMatch(/\b(add|tell|say|write|share)\b/i);
  });

  it('Hebrew does not ask the person to tell or add anything', () => {
    expect(he.xIntelligenceNoIdeas).not.toMatch(/ספר|הוסיפ|כתב|שתפ/);
  });
});
